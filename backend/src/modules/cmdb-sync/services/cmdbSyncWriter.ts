/**
 * cmdbSyncWriter — iTop CI → 平台表的数据写入层
 *
 * 为什么不直接用 dcRepository/serverRepository？
 *   现有 repository 的 create 方法是给「平台原生 CRUD」设计的，字段集与 iTop 同步所需的
 *   （如 servers.ip_address / network_devices 的最小字段集）不完全匹配。
 *   强行复用会导致字段错配或需要给 repo 加大量「仅为同步用」的方法，反而增加耦合。
 *
 *   因此本文件作为 cmdb-sync 模块专属的数据写入层（类似 modules/dc 里的 writer 模式），
 *   把裸 SQL 收敛到这里，让 itopSyncService.ts 只负责编排（取数 → 映射 → 写入 → 记日志）。
 *
 * 所有写入都接受一个外部传入的 db 事务上下文（better-sqlite3 Transaction），
 * 由 itopSyncService 决定事务边界，保证「数据写入 + idMap 更新」原子性。
 */

import db from '../../../models/database';
import { roomsRepo, racksRepo, pdusRepo } from '../../../repositories';
import type { DcRackCreateInput } from '../../../repositories/dcRepository/types';

// ============================================================
// Location → dc_rooms
// ============================================================

export function upsertRoom(
  existingId: string | undefined,
  fields: { name: string; description?: string },
): string {
  if (existingId) {
    // roomsRepo.update 要求完整 DcRoomUpdateInput，这里只同步 name/description
    db.prepare(`
      UPDATE dc_rooms SET name = ?, description = ?, updated_at = datetime('now','localtime')
      WHERE id = ?
    `).run(fields.name, fields.description ?? '', existingId);
    return existingId;
  }
  const newId = crypto.randomUUID();
  roomsRepo.create({
    id: newId,
    name: fields.name,
    description: fields.description ?? '',
  });
  return newId;
}

// ============================================================
// Rack → dc_racks
// ============================================================

/**
 * @returns { id, action } 新建或更新的平台 ID；若缺少 room_id 则 throw 以触发 skip
 */
export function upsertRack(
  existingId: string | undefined,
  fields: { name: string; nb_u?: number; location_name?: string },
  roomId: string | null,
): { id: string; action: 'create' | 'update' } {
  // dc_racks.room_id 是 NOT NULL（见 v028_dc_infrastructure），缺机房时不能写入
  if (!roomId) {
    throw new Error(
      `机柜 ${fields.name} 无法关联到机房（location_name="${fields.location_name ?? ''}" 未同步或为空），跳过`,
    );
  }

  if (existingId) {
    // 只更新 name / total_u / room_id（COALESCE 保留原值）
    db.prepare(`
      UPDATE dc_racks SET name = ?, total_u = ?, room_id = COALESCE(?, room_id), updated_at = datetime('now','localtime')
      WHERE id = ?
    `).run(fields.name, fields.nb_u ?? 42, roomId, existingId);
    return { id: existingId, action: 'update' };
  }

  const newId = crypto.randomUUID();
  const input: DcRackCreateInput = {
    id: newId,
    name: fields.name,
    room_id: roomId,
    total_u: fields.nb_u ?? 42,
  };
  racksRepo.create(input);
  return { id: newId, action: 'create' };
}

// ============================================================
// Server → servers
// ============================================================

export interface ServerUpsertResult {
  id: string;
  action: 'create' | 'update' | 'skip';
  message?: string;
}

/**
 * 注意：servers.ip_address 在 v001 schema 中并无 UNIQUE 约束
 * （只有 network_devices.ip_address 和 credentials 表的 ip_address 是 UNIQUE）。
 * 因此这里不再做 IP 冲突预检——直接写入即可。
 */
export function upsertServer(
  existingId: string | undefined,
  fields: {
    name: string;
    ipaddress?: string;
    ipaddress_2?: string;
    osfamily?: string;
  },
): ServerUpsertResult {
  const ip = fields.ipaddress || fields.ipaddress_2 || '';

  if (existingId) {
    db.prepare(`
      UPDATE servers
      SET name = ?, os = ?, hostname = COALESCE(NULLIF(?, ''), hostname), ip_address = ?, updated_at = datetime('now','localtime')
      WHERE id = ?
    `).run(fields.name, fields.osfamily ?? '', ip, ip || null, existingId);
    return { id: existingId, action: 'update' };
  }

  const newId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO servers (id, name, hostname, port, username, password, use_ssh_key, os, os_type, ip_address, enabled, tags, created_at, updated_at)
    VALUES (?, ?, ?, 22, '', NULL, 0, ?, 'linux', ?, 1, '[]', datetime('now','localtime'), datetime('now','localtime'))
  `).run(newId, fields.name, ip || fields.name, fields.osfamily ?? '', ip || null);

  return {
    id: newId,
    action: 'create',
    message: '未同步 SSH 密码/密钥，请在平台手动配置',
  };
}

// ============================================================
// DatacenterDevice → network_devices / dc_pdus
// ============================================================

export interface DeviceUpsertResult {
  id: string;
  action: 'create' | 'update' | 'skip';
  table: 'network_devices' | 'dc_pdus';
  message?: string;
}

/**
 * 根据 finalclass 分流：
 *   pdu / ups 类 → dc_pdus
 *   其他（switch / router / firewall 等）→ network_devices（要求唯一 IP）
 */
export function upsertDatacenterDevice(
  existingId: string | undefined,
  fields: {
    name: string;
    description?: string;
    ipaddress?: string;
    ipaddress_2?: string;
    finalclass?: string;
  },
): DeviceUpsertResult {
  const ip = fields.ipaddress || fields.ipaddress_2 || '';
  const finalClass = (fields.finalclass ?? '').toLowerCase();
  const isPDU = finalClass.includes('pdu') || finalClass.includes('ups');

  if (isPDU) {
    if (existingId) {
      db.prepare(`
        UPDATE dc_pdus SET name = ?, updated_at = datetime('now','localtime')
        WHERE id = ?
      `).run(fields.name, existingId);
      return { id: existingId, action: 'update', table: 'dc_pdus' };
    }
    const newId = crypto.randomUUID();
    pdusRepo.create({
      id: newId,
      name: fields.name,
      type: 'pdu',
      status: 'active',
      ip_address: ip,
      model: fields.description ?? '',
    });
    return { id: newId, action: 'create', table: 'dc_pdus' };
  }

  // network_devices 分支
  // network_devices.ip_address 是 NOT NULL UNIQUE（见 v006_network_device_credentials），
  // 无 IP 的设备必须跳过；IP 冲突时关联到已有记录。
  if (existingId) {
    db.prepare(`
      UPDATE network_devices SET name = ?, updated_at = datetime('now','localtime')
      WHERE id = ?
    `).run(fields.name, existingId);
    return { id: existingId, action: 'update', table: 'network_devices' };
  }

  if (!ip) {
    return {
      id: '',
      action: 'skip',
      table: 'network_devices',
      message: `${fields.name} 无 IP 地址，跳过（network_devices 要求唯一 IP）`,
    };
  }

  // IP 唯一性检查（仅 network_devices 需要）
  const ipOwner = db.prepare('SELECT id FROM network_devices WHERE ip_address = ?').get(ip) as
    | { id: string }
    | undefined;
  if (ipOwner) {
    return {
      id: ipOwner.id,
      action: 'skip',
      table: 'network_devices',
      message: `IP ${ip} 已存在，关联到已有设备`,
    };
  }

  const newId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO network_devices (id, name, ip_address, vendor, device_type, status, snmp_enabled, created_at, updated_at)
    VALUES (?, ?, ?, 'unknown', 'unknown', 'online', 1, datetime('now','localtime'), datetime('now','localtime'))
  `).run(newId, fields.name, ip);
  return { id: newId, action: 'create', table: 'network_devices' };
}

// ============================================================
// 辅助：按名称查机房（Rack 关联用）
// ============================================================

export function findRoomIdByName(name: string): string | null {
  const room = db.prepare('SELECT id FROM dc_rooms WHERE name = ?').get(name) as
    | { id: string }
    | undefined;
  return room?.id ?? null;
}
