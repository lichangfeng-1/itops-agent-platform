/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Migration } from './migrationFramework';
import { logger } from '../../utils/logger';

/**
 * Migration v061 — CMDB 同步状态与日志表
 *
 * 为 iTop CMDB 双向同步模块提供持久化支持：
 *   - cmdb_sync_state: 记录每个 CI 类型的同步状态（最近同步时间、计数、错误）
 *   - cmdb_sync_log: 每次同步操作的详细日志
 */
const v061CmdbSyncTables: Migration = {
  id: '20250101000061',
  version: 61,
  name: 'cmdb_sync_tables',
  description: 'CMDB sync state and log tables for iTop integration',

  up: async (db: any) => {
    logger.info('🔄 Creating CMDB sync tables...');

    // 同步状态表 — 每个 CI 类型一行
    db.exec(`
      CREATE TABLE IF NOT EXISTS cmdb_sync_state (
        ci_type TEXT PRIMARY KEY,
        direction TEXT DEFAULT 'pull',
        last_sync_at TEXT,
        last_sync_duration_ms INTEGER,
        last_count INTEGER DEFAULT 0,
        last_status TEXT DEFAULT 'pending',
        last_error TEXT,
        itop_id_map TEXT DEFAULT '{}',
        updated_at TEXT DEFAULT (datetime('now','localtime'))
      );
    `);

    // 同步日志表 — 每次同步的详细记录
    db.exec(`
      CREATE TABLE IF NOT EXISTS cmdb_sync_log (
        id TEXT PRIMARY KEY,
        sync_batch_id TEXT NOT NULL,
        timestamp TEXT DEFAULT (datetime('now','localtime')),
        direction TEXT NOT NULL,
        ci_type TEXT NOT NULL,
        action TEXT NOT NULL,
        itop_id TEXT,
        itop_class TEXT,
        platform_id TEXT,
        platform_table TEXT,
        success INTEGER DEFAULT 1,
        message TEXT,
        details TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_cmdb_sync_log_batch ON cmdb_sync_log(sync_batch_id);
      CREATE INDEX IF NOT EXISTS idx_cmdb_sync_log_ci_type ON cmdb_sync_log(ci_type, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_cmdb_sync_log_timestamp ON cmdb_sync_log(timestamp DESC);
    `);

    logger.info('✅ CMDB sync tables created');
  },

  down: async (db: any) => {
    db.exec(`DROP INDEX IF EXISTS idx_cmdb_sync_log_timestamp;`);
    db.exec(`DROP INDEX IF EXISTS idx_cmdb_sync_log_ci_type;`);
    db.exec(`DROP INDEX IF EXISTS idx_cmdb_sync_log_batch;`);
    db.exec(`DROP TABLE IF EXISTS cmdb_sync_log;`);
    db.exec(`DROP TABLE IF EXISTS cmdb_sync_state;`);
  },
};

export default v061CmdbSyncTables;
