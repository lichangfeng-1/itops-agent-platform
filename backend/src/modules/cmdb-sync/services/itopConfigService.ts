/**
 * itopConfigService — iTop CMDB 同步配置管理
 *
 * 非密配置 → settings 表（ITOP_API_BASE, ITOP_SYNC_ENABLED, ITOP_SYNC_INTERVAL_MINUTES）
 * 密钥     → credentials 表（provider='itop'，AES-256-GCM 加密）
 */

import { settingsRepository } from '../../../repositories';
import { credentialService } from '../../auth/services/credentialService';
import { itopClient } from './itopClient';
import type { ITopClientConfig } from './itopClient';

// ============================================================
// 类型定义
// ============================================================

export interface ITopConfigOutput {
  apiBase: string;
  authUser: string;
  syncEnabled: boolean;
  syncIntervalMinutes: number;
  timeoutMs: number;
  tokenConfigured: boolean; // 是否已配置认证信息（不返回明文）
}

export interface ITopConfigInput {
  apiBase?: string;
  authUser?: string;
  authToken?: string; // 可选：不传则不修改
  syncEnabled?: boolean;
  syncIntervalMinutes?: number;
  timeoutMs?: number;
}

export interface ITopTestResult {
  success: boolean;
  message: string;
  latencyMs?: number;
}

// ============================================================
// 配置管理
// ============================================================

export const itopConfigService = {
  /**
   * 获取当前 iTop 配置（token 掩码显示）
   */
  getConfig(): ITopConfigOutput {
    const apiBase = settingsRepository.getValue('ITOP_API_BASE') ?? '';
    const authUser = settingsRepository.getValue('ITOP_AUTH_USER') ?? 'admin';
    const syncEnabledStr = settingsRepository.getValue('ITOP_SYNC_ENABLED');
    const syncIntervalStr = settingsRepository.getValue('ITOP_SYNC_INTERVAL_MINUTES');
    const timeoutStr = settingsRepository.getValue('ITOP_TIMEOUT_MS');
    const token = credentialService.getCredential('itop');

    return {
      apiBase,
      authUser,
      syncEnabled: syncEnabledStr === 'true',
      syncIntervalMinutes: syncIntervalStr ? parseInt(syncIntervalStr, 10) : 30,
      timeoutMs: timeoutStr ? parseInt(timeoutStr, 10) : 30000,
      tokenConfigured: !!token,
    };
  },

  /**
   * 保存 iTop 配置
   */
  saveConfig(input: ITopConfigInput): ITopConfigOutput {
    const updates: Record<string, string> = {};

    if (input.apiBase !== undefined) {
      updates.ITOP_API_BASE = input.apiBase;
    }
    if (input.authUser !== undefined) {
      updates.ITOP_AUTH_USER = input.authUser;
    }
    if (input.syncEnabled !== undefined) {
      updates.ITOP_SYNC_ENABLED = input.syncEnabled ? 'true' : 'false';
    }
    if (input.syncIntervalMinutes !== undefined) {
      updates.ITOP_SYNC_INTERVAL_MINUTES = String(input.syncIntervalMinutes);
    }
    if (input.timeoutMs !== undefined) {
      updates.ITOP_TIMEOUT_MS = String(input.timeoutMs);
    }

    if (Object.keys(updates).length > 0) {
      settingsRepository.upsertMany(updates);
    }

    // 认证信息单独存储（加密）
    if (input.authToken !== undefined && input.authToken !== '') {
      credentialService.setCredential('itop', input.authToken);
    }

    return this.getConfig();
  },

  /**
   * 测试 iTop API 连通性
   */
  async testConnection(overrideConfig?: {
    apiBase?: string;
    authUser?: string;
    authToken?: string;
  }): Promise<ITopTestResult> {
    // 如果传入了覆盖配置，用覆盖值测试；否则用已存储配置
    if (overrideConfig?.apiBase && overrideConfig?.authToken) {
      const config: ITopClientConfig = {
        apiUrl: overrideConfig.apiBase,
        authUser: overrideConfig.authUser ?? 'admin',
        authPwd: overrideConfig.authToken,
      };
      const start = Date.now();
      const result = await itopClient.testWithConfig(config);
      const latencyMs = Date.now() - start;

      return {
        success: result.success,
        message: result.success
          ? `连接成功，响应时间 ${latencyMs}ms`
          : result.error ?? '连接失败',
        latencyMs,
      };
    }

    // 用已存储的配置测试
    const apiUrl = settingsRepository.getValue('ITOP_API_BASE');
    const authPwd = credentialService.getCredential('itop');
    if (!apiUrl || !authPwd) {
      return {
        success: false,
        message: 'iTop 未配置：请先设置 API 地址和认证信息',
      };
    }

    const start = Date.now();
    const timeoutStr = settingsRepository.getValue('ITOP_TIMEOUT_MS');
    const timeoutMs = timeoutStr ? parseInt(timeoutStr, 10) : 30000;
    const result = await itopClient.testWithConfig({
      apiUrl,
      authUser: settingsRepository.getValue('ITOP_AUTH_USER') ?? 'admin',
      authPwd,
      timeoutMs,
    });
    const latencyMs = Date.now() - start;

    return {
      success: result.success,
      message: result.success
        ? `连接成功，响应时间 ${latencyMs}ms`
        : result.error ?? '连接失败',
      latencyMs,
    };
  },

  /**
   * 同步是否已启用
   */
  isSyncEnabled(): boolean {
    return settingsRepository.getValue('ITOP_SYNC_ENABLED') === 'true';
  },

  /**
   * 获取同步间隔（分钟）
   */
  getSyncIntervalMinutes(): number {
    const str = settingsRepository.getValue('ITOP_SYNC_INTERVAL_MINUTES');
    return str ? parseInt(str, 10) : 30;
  },
};

export default itopConfigService;
