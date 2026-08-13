/**
 * cmdb-sync 模块路由聚合
 */

import { Router } from 'express';
import configRoutes from './config';
import syncRoutes from './sync';

const router = Router();

router.use('/cmdb-sync', configRoutes);
router.use('/cmdb-sync', syncRoutes);

// 健康检查
router.get('/cmdb-sync/health', (_req, res) => {
  res.json({ success: true, message: 'CMDB sync routes OK' });
});

export default router;
