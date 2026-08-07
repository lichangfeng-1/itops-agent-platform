/**
 * itopSyncService — iTop CMDB 双向同步核心服务
 *
 * 仿照 modules/network/services/snmpPollingService.ts 的 start/stop + setInterval 模式。
 *
 * 同步流程（Pull）:
 *   1. 从 settings/credentials 读取 iTop 配置
 *   2. 按顺序同步: Location → Rack → Server → DatacenterDevice
 *   3. 每个 CI 调用 itopClient.getObjects() → 字段映射 → upsert 到平台表
 *   4. 写入 cmdb_sync_log + 更新 cmdb_sync_state
 */

import { randomUUID } from 'crypto';
import { logger } from '../../../utils/logger';
import db from '../../../models/database';
import { cmdbSyncStateRepo, cmdbSyncLogRepo } from '../../../repositories';
import { itopClient } from './itopClient';
import { itopConfigService } from './itopConfigService';

// ============================================================
// 类型
// ============================================================

export interface SyncResult {
  success: boolean;
  batchId: string;
  durationMs: number;
  summary: Record<string, { pulled: number; created: number; updated: number; errors: number }>;
  message: string;
}

// ============================================================
// 字段映射
// ============================================================

interface ITopServer {
  name: string;
  ipaddress?: string;
  ipaddress_2?: string;
  osfamily?: string;
  cpu?: string;
  ram?: string;
  organization_name?: string;
  status?: string;
  rack_id?: string;
  serial_number?: string;
}

interface ITopRack {
  name: string;
  description?: string;
  nb_u?: number;
  rack_unit_pos?: number;
  organization_name?: string;
  location_name?: string;
  status?: string;
}

interface ITopLocation {
  name: string;
  description?: string;
  address?: string;
  country?: string;
  city?: string;
  status?: string;
}

interface ITopDatacenterDevice {
  name: string;
  description?: string;
  ipaddress?: string;
  ipaddress_2?: string;
  finalclass?: string;
  organization_name?: string;
  rack_id?: string;
  serial_number?: string;
}

// ============================================================
// 同步服务（单例）
// ============================================================

let timer: ReturnType<typeof setInterval> | null = null;
let syncInProgress = false;

/**
 * 完整同步流程
 */
async function syncAll(): Promise<SyncResult> {
  const batchId = randomUUID();
  const startTime = Date.now();

  const summary: SyncResult['summary'] = {};

  if (syncInProgress) {
    return {
      success: false,
      batchId,
      durationMs: 0,
      summary,
      message: '上一次同步仍在进行中，已跳过',
    };
  }

  if (!itopClient.isConfigured()) {
    return {
      success: false,
      batchId,
      durationMs: 0,
      summary,
      message: 'iTop 未配置，跳过同步',
    };
  }

  syncInProgress = true;
  logger.info(`🔄 [CMDB-Sync] 开始同步 batch=${batchId}`);

  try {
    // 按依赖顺序同步：Location → Rack → Server → DatacenterDevice
    await syncLocations(batchId, summary);
    await syncRacks(batchId, summary);
    await syncServers(batchId, summary);
    await syncDatacenterDevices(batchId, summary);

    const durationMs = Date.now() - startTime;
    const totalErrors = Object.values(summary).reduce((sum, s) => sum + s.errors, 0);

    logger.info(
      `✅ [CMDB-Sync] 同步完成 batch=${batchId} 耗时=${durationMs}ms 错误=${totalErrors}`,
    );

    return {
      success: totalErrors === 0,
      batchId,
      durationMs,
      summary,
      message: totalErrors === 0 ? '同步成功' : `同步完成，但有 ${totalErrors} 个错误`,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`❌ [CMDB-Sync] 同步失败 batch=${batchId}:`, error as Error);

    return {
      success: false,
      batchId,
      durationMs,
      summary,
      message: msg,
    };
  } finally {
    syncInProgress = false;
  }
}

// ============================================================
// Location → dc_rooms
// ============================================================

async function syncLocations(
  batchId: string,
  summary: SyncResult['summary'],
): Promise<void> {
  const ciType = 'Location';
  const stats = { pulled: 0, created: 0, updated: 0, errors: 0 };
  const start = Date.now();

  const result = await itopClient.getObjects<ITopLocation>(
    'Location',
    'SELECT Location',
    'name, description, address, country, city, status',
  );

  if (!result.success || !result.data) {
    stats.errors++;
    cmdbSyncLogRepo.insert({
      sync_batch_id: batchId,
      direction: 'pull',
      ci_type: ciType,
      action: 'error',
      message: result.error ?? '获取 Location 失败',
    });
    cmdbSyncStateRepo.upsert(ciType, {
      last_sync_at: new Date().toISOString(),
      last_sync_duration_ms: Date.now() - start,
      last_count: 0,
      last_status: 'error',
      last_error: result.error,
    });
    summary[ciType] = stats;
    return;
  }

  const idMap = cmdbSyncStateRepo.getIdMap(ciType);

  for (const [itopKey, obj] of Object.entries(result.data.objects)) {
    stats.pulled++;
    const fields = obj.fields;
    const itopId = String(obj.key);

    try {
      const existingId = idMap[itopId];
      if (existingId) {
        // UPDATE
        db.prepare(`
          UPDATE dc_rooms SET name = ?, description = ?, updated_at = datetime('now','localtime')
          WHERE id = ?
        `).run(fields.name, fields.description ?? '', existingId);
        stats.updated++;
        cmdbSyncLogRepo.insert({
          sync_batch_id: batchId,
          direction: 'pull',
          ci_type: ciType,
          action: 'update',
          itop_id: itopId,
          platform_id: existingId,
          platform_table: 'dc_rooms',
          success: true,
        });
      } else {
        // INSERT
        const newId = randomUUID();
        db.prepare(`
          INSERT INTO dc_rooms (id, name, label, description, width_m, depth_m, sort_order, created_at, updated_at)
          VALUES (?, ?, '', ?, 20, 15, 0, datetime('now','localtime'), datetime('now','localtime'))
        `).run(newId, fields.name, fields.description ?? '');
        idMap[itopId] = newId;
        stats.created++;
        cmdbSyncLogRepo.insert({
          sync_batch_id: batchId,
          direction: 'pull',
          ci_type: ciType,
          action: 'create',
          itop_id: itopId,
          platform_id: newId,
          platform_table: 'dc_rooms',
          success: true,
        });
      }
    } catch (err) {
      stats.errors++;
      cmdbSyncLogRepo.insert({
        sync_batch_id: batchId,
        direction: 'pull',
        ci_type: ciType,
        action: 'error',
        itop_id: itopId,
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  cmdbSyncStateRepo.upsert(ciType, {
    last_sync_at: new Date().toISOString(),
    last_sync_duration_ms: Date.now() - start,
    last_count: stats.pulled,
    last_status: stats.errors > 0 ? 'partial' : 'success',
    last_error: stats.errors > 0 ? `${stats.errors} errors` : null,
    itop_id_map: JSON.stringify(idMap),
  });

  summary[ciType] = stats;
  logger.info(`📍 [CMDB-Sync] Location: pulled=${stats.pulled} created=${stats.created} updated=${stats.updated}`);
}

// ============================================================
// Rack → dc_racks
// ============================================================

async function syncRacks(
  batchId: string,
  summary: SyncResult['summary'],
): Promise<void> {
  const ciType = 'Rack';
  const stats = { pulled: 0, created: 0, updated: 0, errors: 0 };
  const start = Date.now();

  const result = await itopClient.getObjects<ITopRack>(
    'Rack',
    'SELECT Rack',
    'name, description, nb_u, rack_unit_pos, organization_name, location_name, status',
  );

  if (!result.success || !result.data) {
    stats.errors++;
    cmdbSyncLogRepo.insert({
      sync_batch_id: batchId,
      direction: 'pull',
      ci_type: ciType,
      action: 'error',
      message: result.error ?? '获取 Rack 失败',
    });
    cmdbSyncStateRepo.upsert(ciType, {
      last_sync_at: new Date().toISOString(),
      last_sync_duration_ms: Date.now() - start,
      last_count: 0,
      last_status: 'error',
      last_error: result.error,
    });
    summary[ciType] = stats;
    return;
  }

  const rackIdMap = cmdbSyncStateRepo.getIdMap(ciType);
  const roomIdMap = cmdbSyncStateRepo.getIdMap('Location');

  for (const [, obj] of Object.entries(result.data.objects)) {
    stats.pulled++;
    const fields = obj.fields;
    const itopId = String(obj.key);

    try {
      // 查找关联的 room_id（如果 Location 已同步）
      const roomId = fields.location_name ? findRoomByName(fields.location_name, roomIdMap) : null;

      const existingId = rackIdMap[itopId];
      if (existingId) {
        db.prepare(`
          UPDATE dc_racks SET name = ?, total_u = ?, room_id = COALESCE(?, room_id), updated_at = datetime('now','localtime')
          WHERE id = ?
        `).run(fields.name, fields.nb_u ?? 42, roomId, existingId);
        stats.updated++;
        cmdbSyncLogRepo.insert({
          sync_batch_id: batchId,
          direction: 'pull',
          ci_type: ciType,
          action: 'update',
          itop_id: itopId,
          platform_id: existingId,
          platform_table: 'dc_racks',
          success: true,
        });
      } else {
        const newId = randomUUID();
        db.prepare(`
          INSERT INTO dc_racks (id, name, label, room_id, row_number, position_x, position_z, total_u, pdu_count, max_power_w, status, sort_order, created_at, updated_at)
          VALUES (?, ?, '', ?, 1, 0, 0, ?, 2, 4000, 'normal', 0, datetime('now','localtime'), datetime('now','localtime'))
        `).run(newId, fields.name, roomId, fields.nb_u ?? 42);
        rackIdMap[itopId] = newId;
        stats.created++;
        cmdbSyncLogRepo.insert({
          sync_batch_id: batchId,
          direction: 'pull',
          ci_type: ciType,
          action: 'create',
          itop_id: itopId,
          platform_id: newId,
          platform_table: 'dc_racks',
          success: true,
        });
      }
    } catch (err) {
      stats.errors++;
      cmdbSyncLogRepo.insert({
        sync_batch_id: batchId,
        direction: 'pull',
        ci_type: ciType,
        action: 'error',
        itop_id: itopId,
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  cmdbSyncStateRepo.upsert(ciType, {
    last_sync_at: new Date().toISOString(),
    last_sync_duration_ms: Date.now() - start,
    last_count: stats.pulled,
    last_status: stats.errors > 0 ? 'partial' : 'success',
    last_error: stats.errors > 0 ? `${stats.errors} errors` : null,
    itop_id_map: JSON.stringify(rackIdMap),
  });

  summary[ciType] = stats;
  logger.info(`🗄️ [CMDB-Sync] Rack: pulled=${stats.pulled} created=${stats.created} updated=${stats.updated}`);
}

// ============================================================
// Server → servers
// ============================================================

async function syncServers(
  batchId: string,
  summary: SyncResult['summary'],
): Promise<void> {
  const ciType = 'Server';
  const stats = { pulled: 0, created: 0, updated: 0, errors: 0 };
  const start = Date.now();

  const result = await itopClient.getObjects<ITopServer>(
    'Server',
    'SELECT Server',
    'name, ipaddress, ipaddress_2, osfamily, cpu, ram, organization_name, status, serial_number',
  );

  if (!result.success || !result.data) {
    stats.errors++;
    cmdbSyncLogRepo.insert({
      sync_batch_id: batchId,
      direction: 'pull',
      ci_type: ciType,
      action: 'error',
      message: result.error ?? '获取 Server 失败',
    });
    cmdbSyncStateRepo.upsert(ciType, {
      last_sync_at: new Date().toISOString(),
      last_sync_duration_ms: Date.now() - start,
      last_count: 0,
      last_status: 'error',
      last_error: result.error,
    });
    summary[ciType] = stats;
    return;
  }

  const idMap = cmdbSyncStateRepo.getIdMap(ciType);

  for (const [, obj] of Object.entries(result.data.objects)) {
    stats.pulled++;
    const fields = obj.fields;
    const itopId = String(obj.key);
    const ip = fields.ipaddress || fields.ipaddress_2 || '';

    try {
      const existingId = idMap[itopId];
      if (existingId) {
        // UPDATE — 注意 ip_address 唯一约束
        const existing = db.prepare('SELECT ip_address FROM servers WHERE id = ?').get(existingId) as
          | { ip_address: string | null }
          | undefined;

        // 只在 IP 变化且新 IP 不被其他服务器占用时更新
        if (ip && ip !== existing?.ip_address) {
          const ipOwner = db
            .prepare('SELECT id FROM servers WHERE ip_address = ? AND id != ?')
            .get(ip, existingId) as { id: string } | undefined;
          if (!ipOwner) {
            db.prepare(`
              UPDATE servers SET name = ?, ip_address = ?, os = ?, hostname = ?, updated_at = datetime('now','localtime')
              WHERE id = ?
            `).run(fields.name, ip, fields.osfamily ?? '', ip, existingId);
          } else {
            // IP 被占用，只更新名称等
            db.prepare(`
              UPDATE servers SET name = ?, os = ?, updated_at = datetime('now','localtime')
              WHERE id = ?
            `).run(fields.name, fields.osfamily ?? '', existingId);
          }
        } else {
          db.prepare(`
            UPDATE servers SET name = ?, os = ?, updated_at = datetime('now','localtime')
            WHERE id = ?
          `).run(fields.name, fields.osfamily ?? '', existingId);
        }
        stats.updated++;
        cmdbSyncLogRepo.insert({
          sync_batch_id: batchId,
          direction: 'pull',
          ci_type: ciType,
          action: 'update',
          itop_id: itopId,
          platform_id: existingId,
          platform_table: 'servers',
          success: true,
        });
      } else {
        // INSERT — 注意 ip_address 唯一约束，冲突时跳过
        const newId = randomUUID();
        // 检查 IP 是否已被其他服务器占用
        if (ip) {
          const ipOwner = db.prepare('SELECT id FROM servers WHERE ip_address = ?').get(ip) as
            | { id: string }
            | undefined;
          if (ipOwner) {
            // IP 冲突，关联到已有服务器并跳过创建
            idMap[itopId] = ipOwner.id;
            stats.updated++;
            cmdbSyncLogRepo.insert({
              sync_batch_id: batchId,
              direction: 'pull',
              ci_type: ciType,
              action: 'skip',
              itop_id: itopId,
              platform_id: ipOwner.id,
              platform_table: 'servers',
              success: true,
              message: `IP ${ip} 已存在，关联到已有服务器`,
            });
            continue;
          }
        }

        db.prepare(`
          INSERT INTO servers (id, name, hostname, port, username, password, use_ssh_key, os, os_type, ip_address, enabled, tags, created_at, updated_at)
          VALUES (?, ?, ?, 22, '', NULL, 0, ?, 'linux', ?, 1, '[]', datetime('now','localtime'), datetime('now','localtime'))
        `).run(newId, fields.name, ip || fields.name, fields.osfamily ?? '', ip || null);
        idMap[itopId] = newId;
        stats.created++;
        cmdbSyncLogRepo.insert({
          sync_batch_id: batchId,
          direction: 'pull',
          ci_type: ciType,
          action: 'create',
          itop_id: itopId,
          platform_id: newId,
          platform_table: 'servers',
          success: true,
          message: '未同步 SSH 密码/密钥，请在平台手动配置',
        });
      }
    } catch (err) {
      stats.errors++;
      cmdbSyncLogRepo.insert({
        sync_batch_id: batchId,
        direction: 'pull',
        ci_type: ciType,
        action: 'error',
        itop_id: itopId,
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  cmdbSyncStateRepo.upsert(ciType, {
    last_sync_at: new Date().toISOString(),
    last_sync_duration_ms: Date.now() - start,
    last_count: stats.pulled,
    last_status: stats.errors > 0 ? 'partial' : 'success',
    last_error: stats.errors > 0 ? `${stats.errors} errors` : null,
    itop_id_map: JSON.stringify(idMap),
  });

  summary[ciType] = stats;
  logger.info(`🖥️ [CMDB-Sync] Server: pulled=${stats.pulled} created=${stats.created} updated=${stats.updated}`);
}

// ============================================================
// DatacenterDevice → network_devices / dc_pdus
// ============================================================

async function syncDatacenterDevices(
  batchId: string,
  summary: SyncResult['summary'],
): Promise<void> {
  const ciType = 'DatacenterDevice';
  const stats = { pulled: 0, created: 0, updated: 0, errors: 0 };
  const start = Date.now();

  const result = await itopClient.getObjects<ITopDatacenterDevice>(
    'DatacenterDevice',
    'SELECT DatacenterDevice',
    'name, description, ipaddress, ipaddress_2, finalclass, organization_name, serial_number',
  );

  if (!result.success || !result.data) {
    stats.errors++;
    cmdbSyncLogRepo.insert({
      sync_batch_id: batchId,
      direction: 'pull',
      ci_type: ciType,
      action: 'error',
      message: result.error ?? '获取 DatacenterDevice 失败',
    });
    cmdbSyncStateRepo.upsert(ciType, {
      last_sync_at: new Date().toISOString(),
      last_sync_duration_ms: Date.now() - start,
      last_count: 0,
      last_status: 'error',
      last_error: result.error,
    });
    summary[ciType] = stats;
    return;
  }

  const idMap = cmdbSyncStateRepo.getIdMap(ciType);

  for (const [, obj] of Object.entries(result.data.objects)) {
    stats.pulled++;
    const fields = obj.fields;
    const itopId = String(obj.key);
    const ip = fields.ipaddress || fields.ipaddress_2 || '';
    const finalClass = (fields.finalclass ?? '').toLowerCase();

    try {
      // 根据 finalclass 分流
      // pdu / ups 类 → dc_pdus
      // 其他（switch / router / firewall 等）→ network_devices
      const isPDU = finalClass.includes('pdu') || finalClass.includes('ups');

      const existingId = idMap[itopId];
      if (isPDU) {
        if (existingId) {
          db.prepare(`
            UPDATE dc_pdus SET name = ?, updated_at = datetime('now','localtime')
            WHERE id = ?
          `).run(fields.name, existingId);
          stats.updated++;
        } else {
          const newId = randomUUID();
          db.prepare(`
            INSERT INTO dc_pdus (id, name, type, status, ip_address, model, created_at, updated_at)
            VALUES (?, ?, 'pdu', 'active', ?, ?, datetime('now','localtime'), datetime('now','localtime'))
          `).run(newId, fields.name, ip, fields.description ?? '');
          idMap[itopId] = newId;
          stats.created++;
        }
      } else {
        // network_devices
        if (existingId) {
          db.prepare(`
            UPDATE network_devices SET name = ?, updated_at = datetime('now','localtime')
            WHERE id = ?
          `).run(fields.name, existingId);
          stats.updated++;
        } else {
          // network_devices.ip_address 是 NOT NULL UNIQUE，必须有 IP
          if (!ip) {
            // 无 IP 的设备跳过
            cmdbSyncLogRepo.insert({
              sync_batch_id: batchId,
              direction: 'pull',
              ci_type: ciType,
              action: 'skip',
              itop_id: itopId,
              success: true,
              message: `${fields.name} 无 IP 地址，跳过（network_devices 要求唯一 IP）`,
            });
            continue;
          }

          // 检查 IP 唯一性
          const ipOwner = db.prepare('SELECT id FROM network_devices WHERE ip_address = ?').get(ip) as
            | { id: string }
            | undefined;
          if (ipOwner) {
            idMap[itopId] = ipOwner.id;
            stats.updated++;
            continue;
          }

          const newId = randomUUID();
          db.prepare(`
            INSERT INTO network_devices (id, name, ip_address, vendor, device_type, status, snmp_enabled, created_at, updated_at)
            VALUES (?, ?, ?, 'unknown', 'unknown', 'online', 1, datetime('now','localtime'), datetime('now','localtime'))
          `).run(newId, fields.name, ip);
          idMap[itopId] = newId;
          stats.created++;
        }
      }

      cmdbSyncLogRepo.insert({
        sync_batch_id: batchId,
        direction: 'pull',
        ci_type: ciType,
        action: existingId ? 'update' : 'create',
        itop_id: itopId,
        platform_id: idMap[itopId] ?? undefined,
        platform_table: isPDU ? 'dc_pdus' : 'network_devices',
        success: true,
      });
    } catch (err) {
      stats.errors++;
      cmdbSyncLogRepo.insert({
        sync_batch_id: batchId,
        direction: 'pull',
        ci_type: ciType,
        action: 'error',
        itop_id: itopId,
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  cmdbSyncStateRepo.upsert(ciType, {
    last_sync_at: new Date().toISOString(),
    last_sync_duration_ms: Date.now() - start,
    last_count: stats.pulled,
    last_status: stats.errors > 0 ? 'partial' : 'success',
    last_error: stats.errors > 0 ? `${stats.errors} errors` : null,
    itop_id_map: JSON.stringify(idMap),
  });

  summary[ciType] = stats;
  logger.info(
    `🔌 [CMDB-Sync] DatacenterDevice: pulled=${stats.pulled} created=${stats.created} updated=${stats.updated}`,
  );
}

// ============================================================
// 辅助函数
// ============================================================

function findRoomByName(
  name: string,
  roomIdMap: Record<string, string>,
): string | null {
  // 先在 idMap 里按名称找
  for (const platformId of Object.values(roomIdMap)) {
    const room = db.prepare('SELECT name FROM dc_rooms WHERE id = ?').get(platformId) as
      | { name: string }
      | undefined;
    if (room?.name === name) return platformId;
  }
  // 再直接查数据库
  const room = db.prepare('SELECT id FROM dc_rooms WHERE name = ?').get(name) as
    | { id: string }
    | undefined;
  return room?.id ?? null;
}

// ============================================================
// 启动/停止定时同步
// ============================================================

export function startSync(intervalMinutes?: number): void {
  if (timer) return;

  const intervalMs = (intervalMinutes ?? itopConfigService.getSyncIntervalMinutes()) * 60 * 1000;

  // 启动后 10 秒先跑一次
  setTimeout(() => {
    if (itopConfigService.isSyncEnabled()) {
      syncAll().catch((err) => logger.error('[CMDB-Sync] 初始同步失败:', err as Error));
    }
  }, 10_000);

  timer = setInterval(() => {
    if (itopConfigService.isSyncEnabled()) {
      syncAll().catch((err) => logger.error('[CMDB-Sync] 定时同步失败:', err as Error));
    }
  }, intervalMs);

  logger.info(`🔄 [CMDB-Sync] 定时同步已启动，间隔 ${intervalMinutes ?? itopConfigService.getSyncIntervalMinutes()} 分钟`);
}

export function stopSync(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('⏹️ [CMDB-Sync] 定时同步已停止');
  }
}

export function isSyncing(): boolean {
  return syncInProgress;
}

export const itopSyncService = {
  syncAll,
  startSync,
  stopSync,
  isSyncing,
};

export default itopSyncService;
