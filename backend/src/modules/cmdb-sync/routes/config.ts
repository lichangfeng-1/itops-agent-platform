/**
 * iTop CMDB 同步 — 配置管理路由
 * GET    /cmdb-sync/config        获取当前配置
 * PUT    /cmdb-sync/config        保存配置（admin）
 * POST   /cmdb-sync/config/test   测试 iTop 连接（admin）
 */

import { Router, type Request, type Response } from 'express';
import { requireRole } from '../../../middleware/auth';
import { getErrorMessage } from '../../../utils/errorHelpers';
import { logger } from '../../../utils/logger';
import { itopConfigService } from '../services/itopConfigService';

const router = Router();

// GET /cmdb-sync/config — 获取当前 iTop 配置
router.get('/config', (_req: Request, res: Response) => {
  try {
    const config = itopConfigService.getConfig();
    res.json({ success: true, data: config });
  } catch (error) {
    logger.error('Failed to get iTop config:', error as Error);
    res.status(500).json({ success: false, message: getErrorMessage(error) });
  }
});

// PUT /cmdb-sync/config — 保存 iTop 配置
router.put('/config', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const saved = itopConfigService.saveConfig(req.body);
    res.json({ success: true, data: saved, message: '配置已保存' });
  } catch (error) {
    logger.error('Failed to save iTop config:', error as Error);
    res.status(500).json({ success: false, message: getErrorMessage(error) });
  }
});

// POST /cmdb-sync/config/test — 测试 iTop 连接
router.post('/config/test', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    // 支持用 body 传入临时配置测试，也支持用已存储配置测试
    const result = await itopConfigService.testConnection(req.body);
    res.json({ success: result.success, data: result });
  } catch (error) {
    logger.error('Failed to test iTop connection:', error as Error);
    res.status(500).json({ success: false, message: getErrorMessage(error) });
  }
});

export default router;
