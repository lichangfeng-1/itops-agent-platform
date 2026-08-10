/**
 * iTop CMDB 同步 — 配置管理路由
 * GET    /cmdb-sync/config        获取当前配置
 * PUT    /cmdb-sync/config        保存配置（admin）
 * POST   /cmdb-sync/config/test   测试 iTop 连接（admin）
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireRole } from '../../../middleware/auth';
import { validateBody } from '../../../middleware/validation';
import { getErrorMessage } from '../../../utils/errorHelpers';
import { logger } from '../../../utils/logger';
import { itopConfigService } from '../services/itopConfigService';

const router = Router();

// PUT /cmdb-sync/config 入参校验
const saveConfigSchema = z.object({
  apiBase: z.string().url('API 地址格式不正确').optional().or(z.literal('')),
  authUser: z.string().max(64).optional(),
  authToken: z.string().max(512).optional(),
  syncEnabled: z.boolean().optional(),
  syncIntervalMinutes: z.number().int().min(1).max(1440).optional(),
  timeoutMs: z.number().int().min(1000).max(300000).optional(),
  sslVerify: z.boolean().optional(),
});

// POST /cmdb-sync/config/test 入参校验（全部可选，允许用已存配置测试）
const testConnectionSchema = z.object({
  apiBase: z.string().optional(),
  authUser: z.string().optional(),
  authToken: z.string().optional(),
  sslVerify: z.boolean().optional(),
});

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
router.put(
  '/config',
  requireRole('admin'),
  validateBody(saveConfigSchema),
  (req: Request, res: Response) => {
    try {
      const saved = itopConfigService.saveConfig(req.body);
      res.json({ success: true, data: saved, message: '配置已保存' });
    } catch (error) {
      logger.error('Failed to save iTop config:', error as Error);
      res.status(500).json({ success: false, message: getErrorMessage(error) });
    }
  },
);

// POST /cmdb-sync/config/test — 测试 iTop 连接
router.post(
  '/config/test',
  requireRole('admin'),
  validateBody(testConnectionSchema),
  async (req: Request, res: Response) => {
    try {
      // 支持用 body 传入临时配置测试，也支持用已存储配置测试
      const result = await itopConfigService.testConnection(req.body);
      res.json({ success: result.success, data: result });
    } catch (error) {
      logger.error('Failed to test iTop connection:', error as Error);
      res.status(500).json({ success: false, message: getErrorMessage(error) });
    }
  },
);

export default router;
