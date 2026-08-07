/**
 * cmdbSyncRepository — CMDB 同步状态与日志数据访问层
 *
 * 表结构见 v061_cmdb_sync_tables：
 *   - cmdb_sync_state: 每个 CI 类型的同步状态（单行）
 *   - cmdb_sync_log:   每次同步操作的详细记录（多行）
 */

import db from '../models/database';
import { randomUUID } from 'crypto';

// ============================================================
// 类型定义
// ============================================================

export interface CmdbSyncState {
  ci_type: string;
  direction: string;
  last_sync_at: string | null;
  last_sync_duration_ms: number | null;
  last_count: number;
  last_status: string;
  last_error: string | null;
  itop_id_map: string; // JSON: { itopId: platformId }
  updated_at: string;
}

export interface CmdbSyncLog {
  id: string;
  sync_batch_id: string;
  timestamp: string;
  direction: string; // 'pull' | 'push'
  ci_type: string; // 'Server' | 'Rack' | 'Location' | ...
  action: string; // 'create' | 'update' | 'skip' | 'error'
  itop_id: string | null;
  itop_class: string | null;
  platform_id: string | null;
  platform_table: string | null;
  success: number; // 0 | 1
  message: string | null;
  details: string | null; // JSON 详情
}

export interface CmdbSyncLogInput {
  sync_batch_id: string;
  direction: string;
  ci_type: string;
  action: string;
  itop_id?: string | null;
  itop_class?: string | null;
  platform_id?: string | null;
  platform_table?: string | null;
  success?: boolean;
  message?: string | null;
  details?: string | null;
}

// ============================================================
// cmdb_sync_state Repository
// ============================================================

export const cmdbSyncStateRepo = {
  get(ciType: string): CmdbSyncState | undefined {
    return db.prepare('SELECT * FROM cmdb_sync_state WHERE ci_type = ?').get(ciType) as
      | CmdbSyncState
      | undefined;
  },

  listAll(): CmdbSyncState[] {
    return db.prepare('SELECT * FROM cmdb_sync_state ORDER BY ci_type').all() as CmdbSyncState[];
  },

  upsert(
    ciType: string,
    data: {
      direction?: string;
      last_sync_at?: string;
      last_sync_duration_ms?: number;
      last_count?: number;
      last_status?: string;
      last_error?: string | null;
      itop_id_map?: string;
    },
  ): void {
    db.prepare(`
      INSERT INTO cmdb_sync_state (ci_type, direction, last_sync_at, last_sync_duration_ms, last_count, last_status, last_error, itop_id_map, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
      ON CONFLICT(ci_type) DO UPDATE SET
        direction = COALESCE(excluded.direction, direction),
        last_sync_at = COALESCE(excluded.last_sync_at, last_sync_at),
        last_sync_duration_ms = COALESCE(excluded.last_sync_duration_ms, last_sync_duration_ms),
        last_count = COALESCE(excluded.last_count, last_count),
        last_status = COALESCE(excluded.last_status, last_status),
        last_error = excluded.last_error,
        itop_id_map = COALESCE(excluded.itop_id_map, itop_id_map),
        updated_at = datetime('now','localtime')
    `).run(
      ciType,
      data.direction ?? 'pull',
      data.last_sync_at ?? null,
      data.last_sync_duration_ms ?? null,
      data.last_count ?? 0,
      data.last_status ?? 'pending',
      data.last_error ?? null,
      data.itop_id_map ?? '{}',
    );
  },

  /**
   * 获取 iTop ID → 平台 ID 的映射
   */
  getIdMap(ciType: string): Record<string, string> {
    const row = db.prepare('SELECT itop_id_map FROM cmdb_sync_state WHERE ci_type = ?').get(ciType) as
      | { itop_id_map: string }
      | undefined;
    if (!row?.itop_id_map) return {};
    try {
      return JSON.parse(row.itop_id_map) as Record<string, string>;
    } catch {
      return {};
    }
  },

  /**
   * 更新某个 CI 类型的 ID 映射
   */
  updateIdMap(ciType: string, idMap: Record<string, string>): void {
    db.prepare(`
      UPDATE cmdb_sync_state SET itop_id_map = ?, updated_at = datetime('now','localtime')
      WHERE ci_type = ?
    `).run(JSON.stringify(idMap), ciType);
  },

  delete(ciType: string): void {
    db.prepare('DELETE FROM cmdb_sync_state WHERE ci_type = ?').run(ciType);
  },
};

// ============================================================
// cmdb_sync_log Repository
// ============================================================

export const cmdbSyncLogRepo = {
  insert(log: CmdbSyncLogInput): void {
    db.prepare(`
      INSERT INTO cmdb_sync_log (id, sync_batch_id, timestamp, direction, ci_type, action, itop_id, itop_class, platform_id, platform_table, success, message, details)
      VALUES (?, ?, datetime('now','localtime'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      log.sync_batch_id,
      log.direction,
      log.ci_type,
      log.action,
      log.itop_id ?? null,
      log.itop_class ?? null,
      log.platform_id ?? null,
      log.platform_table ?? null,
      log.success === false ? 0 : 1,
      log.message ?? null,
      log.details ?? null,
    );
  },

  list(filters?: {
    ci_type?: string;
    direction?: string;
    batch_id?: string;
    limit?: number;
  }): CmdbSyncLog[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters?.ci_type) {
      conditions.push('ci_type = ?');
      params.push(filters.ci_type);
    }
    if (filters?.direction) {
      conditions.push('direction = ?');
      params.push(filters.direction);
    }
    if (filters?.batch_id) {
      conditions.push('sync_batch_id = ?');
      params.push(filters.batch_id);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters?.limit ?? 100;

    return db
      .prepare(`SELECT * FROM cmdb_sync_log ${whereClause} ORDER BY timestamp DESC LIMIT ?`)
      .all(...params, limit) as CmdbSyncLog[];
  },

  getRecent(limit = 20): CmdbSyncLog[] {
    return db
      .prepare('SELECT * FROM cmdb_sync_log ORDER BY timestamp DESC LIMIT ?')
      .all(limit) as CmdbSyncLog[];
  },

  deleteOld(daysToKeep = 30): number {
    const result = db
      .prepare(`DELETE FROM cmdb_sync_log WHERE timestamp < datetime('now','localtime', ?)`)
      .run(`-${daysToKeep} days`);
    return result.changes;
  },
};

// ============================================================
// 聚合导出
// ============================================================

export const cmdbSyncRepository = {
  state: cmdbSyncStateRepo,
  log: cmdbSyncLogRepo,
};

export default cmdbSyncRepository;
