# CMDB 同步模块 (`cmdb-sync/`)

> **DDD 限界上下文**：与外部 CMDB 系统（当前支持 iTop）的双向资产同步
> **聚合根**：`CmdbSyncState`、`CmdbSyncLog`
> **最后刷新**：2026-08-07

## 职责

从 iTop CMDB 拉取配置项（CI）到平台资产表，支持定时同步和手动触发。当前实现 **Pull** 方向，字段映射如下：

| iTop CI 类 | 平台表 | 说明 |
|------------|--------|------|
| `Location` | `dc_rooms` | 机房 |
| `Rack` | `dc_racks` | 机柜（依赖 Location 先同步） |
| `Server` | `servers` | 服务器（不同步 SSH 凭证，需手动配置） |
| `DatacenterDevice` | `network_devices` / `dc_pdus` | 按 `finalclass` 分流：pdu/ups→dc_pdus，其余→network_devices |

## 内部结构

```
cmdb-sync/
├── routes/
│   ├── config.ts            ← GET/PUT /cmdb-sync/config, POST /cmdb-sync/config/test
│   ├── sync.ts              ← POST /cmdb-sync/trigger, GET /cmdb-sync/status, GET /cmdb-sync/logs
│   └── index.ts             ← 路由聚合
├── services/
│   ├── itopClient.ts        ← iTop REST/JSON API 客户端（core/get、core/create、core/update、core/get_related）
│   ├── itopConfigService.ts ← 配置管理（非密配置→settings 表，密钥→credentials 表）
│   ├── itopSyncService.ts   ← 同步编排（策略模式 SyncStrategy<T> + db.transaction 保证原子性）
│   └── cmdbSyncWriter.ts    ← 数据写入层（iTop CI → 平台表 upsert）
├── routes.ts                # 模块路由入口
├── index.ts
└── README.md
```

## 路由端点（受保护）

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/cmdb-sync/config` | 已登录 | 获取当前配置（token 掩码） |
| PUT | `/cmdb-sync/config` | admin | 保存配置（Zod 校验） |
| POST | `/cmdb-sync/config/test` | admin | 测试连接（支持临时配置） |
| POST | `/cmdb-sync/trigger` | admin/operator | 手动触发一次同步 |
| GET | `/cmdb-sync/status` | 已登录 | 各 CI 类型的同步状态 |
| GET | `/cmdb-sync/logs` | 已登录 | 同步日志（支持 ci_type/direction/batch_id/limit 过滤） |

## 配置项

存储在 `settings` 表（非密）和 `credentials` 表（密钥，AES-256-GCM 加密）：

| Key | 存储 | 默认值 | 说明 |
|-----|------|--------|------|
| `ITOP_API_BASE` | settings | - | iTop rest.php 完整 URL |
| `ITOP_AUTH_USER` | settings | `admin` | 认证用户名 |
| `ITOP_SYNC_ENABLED` | settings | `false` | 是否启用定时同步 |
| `ITOP_SYNC_INTERVAL_MINUTES` | settings | `30` | 同步间隔（1~1440 分钟） |
| `ITOP_TIMEOUT_MS` | settings | `30000` | API 超时（毫秒） |
| `itop` (provider) | credentials | - | iTop 登录密码或 Token（加密） |

## 同步语义

- **依赖顺序**：`Location → Rack → Server → DatacenterDevice`（Rack 需要关联到已同步的 Location）
- **ID 映射**：`cmdb_sync_state.itop_id_map` 存储 `{ itopId: platformId }` 的 JSON，支持增量同步（已映射的走 UPDATE，未映射的走 INSERT）
- **事务**：每个 CI 类型的「数据写入 + idMap 更新」在同一个 `db.transaction` 内，失败时整体回滚
- **幂等**：重复同步不会创建重复记录（依赖 idMap）
- **冲突处理**：
  - `dc_racks.room_id` 为 NOT NULL，缺机房时记 error 跳过（不 INSERT null）
  - `network_devices.ip_address` 为 UNIQUE，冲突时关联到已有设备
  - `servers.ip_address` 无 UNIQUE 约束，直接写入
- **日志**：每次同步生成 `batchId`，所有操作写入 `cmdb_sync_log`（保留 30 天）

## 启动时机

由 `serviceRegistry.ts` 在容器初始化时判断 `ITOP_SYNC_ENABLED === 'true'` 决定是否调用 `itopSyncService.startSync()`。启用后启动 10 秒先跑一次，之后按间隔定时执行。

## 前端

设置页 `frontend/src/modules/settings/pages/settings/ITopSyncSettings.tsx`，作为「系统设置」的一个 tab。
