/**
 * itopSyncService — iTop CMDB 双向同步核心编排服务
 *
 * 仿照 modules/network/services/snmpPollingService.ts 的 start/stop + setInterval 模式。
 *
 * 同步流程（Pull）:
 *   1. 从 settings/credentials 读取 iTop 配置
 *   2. 按顺序同步: Location → Rack → Server → DatacenterDevice
 *   3. 每个 CI 调用 itopClient.getObjects() → 字段映射 → upsert（见 cmdbSyncWriter）
 *   4. 写入 cmdb_sync_log + 更新 cmdb_sync_state（同一事务，保证原子性）
 *
 * 数据写入逻辑收敛在 cmdbSyncWriter.ts（避免本文件超过 500 行 ESLint 限制）。
 */

import { randomUUID } from 'crypto';
import db from '../../../models/database';
import { logger } from '../../../utils/logger';
import { cmdbSyncStateRepo, cmdbSyncLogRepo } from '../../../repositories';
import { itopClient } from './itopClient';
import { itopConfigService } from './itopConfigService';
import {
  upsertRoom,
  upsertRack,
  upsertServer,
  upsertDatacenterDevice,
  findRoomIdByName,
} from './cmdbSyncWriter';

// ============================================================
// 类型 & 字段映射
// ============================================================

export interface SyncResult {
  success: boolean;
  batchId: string;
  durationMs: number;
  summary: Record<string, { pulled: number; created: number; updated: number; errors: number }>;
  message: string;
}

interface ITopServer {
  name: string;
  ipaddress?: string;
  ipaddress_2?: string;
  osfamily?: string;
}
interface ITopRack {
  name: string;
  nb_u?: number;
  organization_name?: string;
  location_name?: string;
}
interface ITopLocation {
  name: string;
  description?: string;
  address?: string;
  country?: string;
  city?: string;
}
interface ITopDatacenterDevice {
  name: string;
  description?: string;
  ipaddress?: string;
  ipaddress_2?: string;
  finalclass?: string;
}

/** 每个 CI 类型的同步策略（策略模式，消除 syncXxx 的重复骨架） */
interface SyncStrategy<TFields> {
  ciType: string;
  oql: string;
  outputFields: string;
  /** 从 iTop 字段构造入参，执行 upsert，返回平台 ID 和动作 */
  upsert: (
    fields: TFields,
    ctx: { existingId: string | undefined; idMap: Record<string, string> },
  ) => { platformId: string; action: 'create' | 'update' | 'skip'; table?: string; message?: string };
}

// ============================================================
// 同步服务（单例）
// ============================================================

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;
let syncInProgress = false;

/**
 * 完整同步流程
 */
async function syncAll(): Promise<SyncResult> {
  const batchId = randomUUID();
  const startTime = Date.now();
  const summary: SyncResult['summary'] = {};

  if (syncInProgress) {
    return { success: false, batchId, durationMs: 0, summary, message: '上一次同步仍在进行中，已跳过' };
  }
  if (!itopClient.isConfigured()) {
    return { success: false, batchId, durationMs: 0, summary, message: 'iTop 未配置，跳过同步' };
  }

  syncInProgress = true;
  logger.info(`🔄 [CMDB-Sync] 开始同步 batch=${batchId}`);

  try {
    await syncCIs(locationStrategy, batchId, summary);
    await syncCIs(rackStrategy, batchId, summary);
    await syncCIs(serverStrategy, batchId, summary);
    await syncCIs(datacenterDeviceStrategy, batchId, summary);

    const durationMs = Date.now() - startTime;
    const totalErrors = Object.values(summary).reduce((sum, s) => sum + s.errors, 0);
    logger.info(`✅ [CMDB-Sync] 同步完成 batch=${batchId} 耗时=${durationMs}ms 错误=${totalErrors}`);

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
    return { success: false, batchId, durationMs, summary, message: msg };
  } finally {
    syncInProgress = false;
  }
}

// ============================================================
// 通用同步骨架（策略驱动）
// ============================================================

/**
 * 对单个 CI 类型执行：取数 → 逐条 upsert → 记日志 → 更新 state
 *
 * 事务边界：整个 CI 类型的「数据写入 + idMap 更新」包裹在 better-sqlite3 事务里，
 * 保证中途失败时不会留下「数据已写但 idMap 未更新」的脏状态（否则下次同步会重复创建）。
 */
async function syncCIs<TFields>(
  strategy: SyncStrategy<TFields>,
  batchId: string,
  summary: SyncResult['summary'],
): Promise<void> {
  const { ciType } = strategy;
  const stats = { pulled: 0, created: 0, updated: 0, errors: 0 };
  const start = Date.now();

  const result = await itopClient.getObjects<TFields>(
    ciType,
    strategy.oql,
    strategy.outputFields,
  );

  if (!result.success || !result.data) {
    stats.errors++;
    const errMsg = result.error ?? `获取 ${ciType} 失败`;
    cmdbSyncLogRepo.insert({ sync_batch_id: batchId, direction: 'pull', ci_type: ciType, action: 'error', message: errMsg });
    cmdbSyncStateRepo.upsert(ciType, {
      last_sync_at: new Date().toISOString(),
      last_sync_duration_ms: Date.now() - start,
      last_count: 0,
      last_status: 'error',
      last_error: errMsg,
    });
    summary[ciType] = stats;
    return;
  }

  const idMap = cmdbSyncStateRepo.getIdMap(ciType);

  // 事务：保证 upsert 数据 + idMap 落库的原子性
  const tx = db.transaction(() => {
    for (const obj of Object.values(result.data!.objects)) {
      stats.pulled++;
      const fields = obj.fields;
      const itopId = String(obj.key);

      try {
        const res = strategy.upsert(fields, { existingId: idMap[itopId], idMap });
        idMap[itopId] = res.platformId;

        if (res.action === 'skip') {
          cmdbSyncLogRepo.insert({
            sync_batch_id: batchId, direction: 'pull', ci_type: ciType, action: 'skip',
            itop_id: itopId, platform_id: res.platformId || null,
            platform_table: res.table ?? null, success: true, message: res.message,
          });
          continue;
        }

        if (res.action === 'create') stats.created++;
        else stats.updated++;

        cmdbSyncLogRepo.insert({
          sync_batch_id: batchId, direction: 'pull', ci_type: ciType, action: res.action,
          itop_id: itopId, platform_id: res.platformId, platform_table: res.table ?? null,
          success: true, message: res.message,
        });
      } catch (err) {
        stats.errors++;
        cmdbSyncLogRepo.insert({
          sync_batch_id: batchId, direction: 'pull', ci_type: ciType, action: 'error',
          itop_id: itopId, success: false,
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
  });

  tx();

  summary[ciType] = stats;
  logger.info(
    `📍 [CMDB-Sync] ${ciType}: pulled=${stats.pulled} created=${stats.created} updated=${stats.updated}`,
  );
}

// ============================================================
// 各 CI 类型的同步策略
// ============================================================

const locationStrategy: SyncStrategy<ITopLocation> = {
  ciType: 'Location',
  oql: 'SELECT Location',
  outputFields: 'name, description, address, country, city, status',
  upsert: (fields, { existingId }) => ({
    platformId: upsertRoom(existingId, { name: fields.name, description: fields.description }),
    action: existingId ? 'update' : 'create',
    table: 'dc_rooms',
  }),
};

const rackStrategy: SyncStrategy<ITopRack> = {
  ciType: 'Rack',
  oql: 'SELECT Rack',
  outputFields: 'name, description, nb_u, rack_unit_pos, organization_name, location_name, status',
  upsert: (fields, { existingId }) => {
    // 查找关联的机房：优先在已同步的 idMap 里按 location_name 找，找不到再查库
    const roomId = fields.location_name ? findRoomIdByName(fields.location_name) : null;
    const res = upsertRack(existingId, fields, roomId);
    return { platformId: res.id, action: res.action, table: 'dc_racks' };
  },
};

const serverStrategy: SyncStrategy<ITopServer> = {
  ciType: 'Server',
  oql: 'SELECT Server',
  outputFields: 'name, ipaddress, ipaddress_2, osfamily, organization_name, status, serial_number',
  upsert: (fields, { existingId }) => {
    const res = upsertServer(existingId, fields);
    return { platformId: res.id, action: res.action, table: 'servers', message: res.message };
  },
};

const datacenterDeviceStrategy: SyncStrategy<ITopDatacenterDevice> = {
  ciType: 'DatacenterDevice',
  oql: 'SELECT DatacenterDevice',
  outputFields: 'name, description, ipaddress, ipaddress_2, finalclass, organization_name, serial_number',
  upsert: (fields, { existingId }) => {
    const res = upsertDatacenterDevice(existingId, fields);
    return { platformId: res.id, action: res.action, table: res.table, message: res.message };
  },
};

// ============================================================
// 启动/停止定时同步
// ============================================================

export function startSync(intervalMinutes?: number): void {
  if (timer) return;

  const intervalMs = (intervalMinutes ?? itopConfigService.getSyncIntervalMinutes()) * 60 * 1000;

  // 启动后 10 秒先跑一次
  initialTimer = setTimeout(() => {
    if (itopConfigService.isSyncEnabled()) {
      syncAll().catch((err) => logger.error('[CMDB-Sync] 初始同步失败:', err as Error));
    }
  }, 10_000);

  timer = setInterval(() => {
    if (itopConfigService.isSyncEnabled()) {
      syncAll().catch((err) => logger.error('[CMDB-Sync] 定时同步失败:', err as Error));
    }
  }, intervalMs);

  logger.info(
    `🔄 [CMDB-Sync] 定时同步已启动，间隔 ${intervalMinutes ?? itopConfigService.getSyncIntervalMinutes()} 分钟`,
  );
}

export function stopSync(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
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
