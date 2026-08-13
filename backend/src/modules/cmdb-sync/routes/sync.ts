/**
 * iTop CMDB 同步 — 同步操作路由
 * POST   /cmdb-sync/trigger   手动触发一次同步
 * GET    /cmdb-sync/status    获取各 CI 类型的同步状态
 * GET    /cmdb-sync/logs      查看同步日志
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireRole } from '../../../middleware/auth';
import { validateQuery } from '../../../middleware/validation';
import { getErrorMessage } from '../../../utils/errorHelpers';
import { logger } from '../../../utils/logger';
import { cmdbSyncStateRepo, cmdbSyncLogRepo } from '../../../repositories';
import { itopSyncService } from '../services/itopSyncService';

const router = Router();

// POST /cmdb-sync/trigger — 手动触发一次同步
router.post('/trigger', requireRole('admin', 'operator'), async (_req: Request, res: Response) => {
  try {
    // 异步触发，不阻塞请求
    const result = await itopSyncService.syncAll();
    res.json({ success: result.success, data: result, message: result.message });
  } catch (error) {
    logger.error('CMDB sync trigger failed:', error as Error);
    res.status(500).json({ success: false, message: getErrorMessage(error) });
  }
});

// GET /cmdb-sync/status — 获取同步状态
router.get('/status', (_req: Request, res: Response) => {
  try {
    const states = cmdbSyncStateRepo.listAll();
    const syncing = itopSyncService.isSyncing();
    res.json({ success: true, data: { states, syncing } });
  } catch (error) {
    logger.error('Failed to get CMDB sync status:', error as Error);
    res.status(500).json({ success: false, message: getErrorMessage(error) });
  }
});

// GET /cmdb-sync/logs — 查看同步日志
const logsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  ci_type: z.string().max(64).optional(),
  direction: z.enum(['pull', 'push']).optional(),
  batch_id: z.string().max(64).optional(),
});

router.get('/logs', validateQuery(logsQuerySchema), (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
    const ciType = req.query.ci_type as string | undefined;
    const direction = req.query.direction as string | undefined;
    const batchId = req.query.batch_id as string | undefined;

    const logs = cmdbSyncLogRepo.list({ ci_type: ciType, direction, batch_id: batchId, limit });
    res.json({ success: true, data: logs });
  } catch (error) {
    logger.error('Failed to get CMDB sync logs:', error as Error);
    res.status(500).json({ success: false, message: getErrorMessage(error) });
  }
});

export default router;
