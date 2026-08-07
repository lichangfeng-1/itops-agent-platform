/**
 * iTop CMDB 同步配置页面
 *
 * 作为"系统设置"的一个 tab，提供：
 *   1. iTop 连接配置（API 地址、认证、同步开关、间隔）
 *   2. 测试连接
 *   3. 同步状态面板（各 CI 类型的同步时间/数量）
 *   4. 手动触发同步
 *   5. 同步日志列表
 *
 * 后端端点: /api/v1/cmdb-sync/*
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Database, Loader2, CheckCircle2, AlertCircle, Wifi, RefreshCw,
  Clock, Activity, Server, HardDrive, MapPin, Zap,
} from 'lucide-react';
import clsx from 'clsx';
import api from '../../../../lib/api';
import { getAxiosErrorMessage } from '../../../../lib/errorHandler';

// ============================================================
// 类型
// ============================================================

interface ITopConfig {
  apiBase: string;
  authUser: string;
  syncEnabled: boolean;
  syncIntervalMinutes: number;
  timeoutMs: number;
  tokenConfigured: boolean;
}

interface SyncStateEntry {
  ci_type: string;
  direction: string;
  last_sync_at: string | null;
  last_sync_duration_ms: number | null;
  last_count: number;
  last_status: string;
  last_error: string | null;
}

interface SyncStatus {
  states: SyncStateEntry[];
  syncing: boolean;
}

interface SyncLog {
  id: string;
  timestamp: string;
  direction: string;
  ci_type: string;
  action: string;
  itop_id: string | null;
  platform_table: string | null;
  success: number;
  message: string | null;
}

interface SyncResult {
  success: boolean;
  batchId: string;
  durationMs: number;
  message: string;
  summary: Record<string, { pulled: number; created: number; updated: number; errors: number }>;
}

// ============================================================
// 常量
// ============================================================

const initialConfig: ITopConfig = {
  apiBase: '',
  authUser: 'admin',
  syncEnabled: false,
  syncIntervalMinutes: 30,
  timeoutMs: 30000,
  tokenConfigured: false,
};

const CI_TYPE_ICONS: Record<string, typeof Server> = {
  Location: MapPin,
  Rack: Database,
  Server: Server,
  DatacenterDevice: Zap,
};

// ============================================================
// 主组件
// ============================================================

export default function ITopSyncSettings() {
  const queryClient = useQueryClient();

  const [config, setConfig] = useState<ITopConfig>(initialConfig);
  const [authToken, setAuthToken] = useState(''); // 单独管理 token 输入
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [syncMessage, setSyncMessage] = useState('');

  // --- 加载配置 ---
  useQuery({
    queryKey: ['itopConfig'],
    queryFn: async () => {
      const { data } = await api.get('/cmdb-sync/config');
      if (data) setConfig(data as ITopConfig);
      return data;
    },
  });

  // --- 加载同步状态 ---
  const { data: syncStatus, refetch: refetchStatus } = useQuery<SyncStatus>({
    queryKey: ['itopSyncStatus'],
    queryFn: async () => {
      const { data } = await api.get('/cmdb-sync/status');
      return data as SyncStatus;
    },
    refetchInterval: 10000, // 每 10 秒刷新
  });

  // --- 加载日志 ---
  const { data: syncLogs } = useQuery<SyncLog[]>({
    queryKey: ['itopSyncLogs'],
    queryFn: async () => {
      const { data } = await api.get('/cmdb-sync/logs', { params: { limit: 30 } });
      return data as SyncLog[];
    },
    refetchInterval: 15000,
  });

  // --- 保存配置 ---
  const configMutation = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        apiBase: config.apiBase,
        authUser: config.authUser,
        syncEnabled: config.syncEnabled,
        syncIntervalMinutes: config.syncIntervalMinutes,
        timeoutMs: config.timeoutMs,
      };
      if (authToken) payload.authToken = authToken;
      const { data } = await api.put('/cmdb-sync/config', payload);
      return data;
    },
    onMutate: () => setSaveStatus('saving'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['itopConfig'] });
      setSaveStatus('saved');
      setAuthToken(''); // 清空 token 输入框
      setTimeout(() => setSaveStatus('idle'), 2000);
    },
    onError: (err: unknown) => {
      setSaveStatus('error');
      setTestMessage(getAxiosErrorMessage(err, '保存失败'));
      setTimeout(() => setSaveStatus('idle'), 3000);
    },
  });

  // --- 测试连接 ---
  const testMutation = useMutation({
    mutationFn: async () => {
      // 如果正在输入新配置，用临时配置测试
      const payload: Record<string, unknown> = {};
      if (config.apiBase) payload.apiBase = config.apiBase;
      if (config.authUser) payload.authUser = config.authUser;
      if (authToken) payload.authToken = authToken;
      const { data } = await api.post('/cmdb-sync/config/test', payload);
      return data;
    },
    onMutate: () => {
      setTestStatus('testing');
      setTestMessage('');
    },
    onSuccess: (data: { success: boolean; message: string }) => {
      setTestStatus(data.success ? 'success' : 'error');
      setTestMessage(data.message);
    },
    onError: (err: unknown) => {
      setTestStatus('error');
      setTestMessage(getAxiosErrorMessage(err, '连接失败'));
    },
  });

  // --- 手动触发同步 ---
  const triggerMutation = useMutation({
    mutationFn: async () => {
      const { data } = await api.post('/cmdb-sync/trigger');
      return data as SyncResult;
    },
    onMutate: () => setSyncMessage(''),
    onSuccess: (data) => {
      setSyncMessage(data.message);
      queryClient.invalidateQueries({ queryKey: ['itopSyncStatus'] });
      queryClient.invalidateQueries({ queryKey: ['itopSyncLogs'] });
      refetchStatus();
    },
    onError: (err: unknown) => {
      setSyncMessage(getAxiosErrorMessage(err, '同步失败'));
    },
  });

  // --- Handlers ---
  const handleTest = () => {
    if (!config.apiBase.trim()) {
      setTestStatus('error');
      setTestMessage('请先填写 iTop API 地址');
      setTimeout(() => setTestStatus('idle'), 3000);
      return;
    }
    testMutation.mutate();
  };

  const handleSave = () => {
    if (config.syncEnabled && !config.apiBase.trim()) {
      setSaveStatus('error');
      setTestMessage('启用同步前请先填写 API 地址');
      setTestStatus('error');
      setTimeout(() => setSaveStatus('idle'), 3000);
      return;
    }
    configMutation.mutate();
  };

  // ============================================================
  // 渲染
  // ============================================================

  return (
    <div className="space-y-6">
      {/* 标题 */}
      <div>
        <h3 className="text-lg font-semibold text-text-primary mb-2 flex items-center gap-2">
          <Database className="w-5 h-5" />
          iTop CMDB 同步
        </h3>
        <p className="text-sm text-text-secondary">
          对接 iTop CMDB 系统，自动同步机房、机柜、服务器和网络设备资产信息
        </p>
      </div>

      {/* === 配置区域 === */}
      <div className="bg-background rounded-lg p-5 border border-border space-y-4">
        {/* API 地址 */}
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">
            iTop API 地址 <span className="text-status-failed">*</span>
          </label>
          <input
            type="text"
            value={config.apiBase}
            onChange={(e) => setConfig({ ...config, apiBase: e.target.value })}
            placeholder="http://itop.example.com/webservices/rest.php"
            className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          <p className="text-xs text-text-tertiary mt-1">
            iTop REST/JSON API 的完整 URL（通常以 /webservices/rest.php 结尾）
          </p>
        </div>

        {/* 认证用户 */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5">
              认证用户
            </label>
            <input
              type="text"
              value={config.authUser}
              onChange={(e) => setConfig({ ...config, authUser: e.target.value })}
              placeholder="admin"
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>

          {/* 认证 Token */}
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5">
              认证密码 / Token{' '}
              {config.tokenConfigured && (
                <span className="text-xs text-status-success ml-1">✓ 已配置</span>
              )}
            </label>
            <input
              type="password"
              value={authToken}
              onChange={(e) => setAuthToken(e.target.value)}
              placeholder={config.tokenConfigured ? '••••••（已保存，输入新值可替换）' : '输入 iTop 登录密码或 Token'}
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>
        </div>

        {/* 同步开关 + 间隔 */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5">
              自动同步
            </label>
            <div className="flex items-center gap-3 py-2">
              <button
                type="button"
                onClick={() => setConfig({ ...config, syncEnabled: !config.syncEnabled })}
                className={clsx(
                  'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
                  config.syncEnabled ? 'bg-primary' : 'bg-border',
                )}
              >
                <span
                  className={clsx(
                    'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
                    config.syncEnabled ? 'translate-x-6' : 'translate-x-1',
                  )}
                />
              </button>
              <span className="text-sm text-text-secondary">
                {config.syncEnabled ? '已启用' : '未启用'}
              </span>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5">
              同步间隔（分钟）
            </label>
            <input
              type="number"
              min={5}
              max={1440}
              value={config.syncIntervalMinutes}
              onChange={(e) => setConfig({ ...config, syncIntervalMinutes: parseInt(e.target.value) || 30 })}
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center justify-between pt-4 border-t border-border">
          {/* 测试连接 */}
          <div className="flex items-center gap-3">
            <button
              onClick={handleTest}
              disabled={testStatus === 'testing'}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-text-primary bg-surface border border-border rounded-lg hover:bg-background disabled:opacity-50 transition-colors"
            >
              {testStatus === 'testing' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : testStatus === 'success' ? (
                <CheckCircle2 className="w-4 h-4 text-status-success" />
              ) : testStatus === 'error' ? (
                <AlertCircle className="w-4 h-4 text-status-failed" />
              ) : (
                <Wifi className="w-4 h-4" />
              )}
              测试连接
            </button>
            {testMessage && (
              <span
                className={clsx(
                  'text-xs',
                  testStatus === 'success' ? 'text-status-success' : 'text-status-failed',
                )}
              >
                {testMessage}
              </span>
            )}
          </div>

          {/* 保存 */}
          <button
            onClick={handleSave}
            disabled={saveStatus === 'saving'}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-primary rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {saveStatus === 'saving' && <Loader2 className="w-4 h-4 animate-spin" />}
            {saveStatus === 'saved' ? '已保存 ✓' : '保存配置'}
          </button>
        </div>
      </div>

      {/* === 同步状态面板 === */}
      <div className="bg-surface rounded-xl border border-border overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-text-secondary" />
            <h4 className="text-sm font-semibold text-text-primary">同步状态</h4>
            {syncStatus?.syncing && (
              <span className="inline-flex items-center gap-1 text-xs text-primary">
                <Loader2 className="w-3 h-3 animate-spin" />
                同步中...
              </span>
            )}
          </div>

          {/* 手动触发 */}
          <button
            onClick={() => triggerMutation.mutate()}
            disabled={triggerMutation.isPending || syncStatus?.syncing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-primary border border-primary/30 rounded-lg hover:bg-primary/5 disabled:opacity-50 transition-colors"
          >
            {triggerMutation.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            手动同步
          </button>
        </div>

        {/* 同步结果消息 */}
        {syncMessage && (
          <div
            className={clsx(
              'px-5 py-2 text-xs border-b border-border',
              triggerMutation.isSuccess ? 'bg-status-success/10 text-status-success' : 'bg-status-failed/10 text-status-failed',
            )}
          >
            {syncMessage}
          </div>
        )}

        {/* CI 类型状态列表 */}
        <div className="divide-y divide-border">
          {(syncStatus?.states ?? []).length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-text-tertiary">
              暂无同步记录，点击"手动同步"开始
            </div>
          ) : (
            (syncStatus?.states ?? []).map((state) => {
              const Icon = CI_TYPE_ICONS[state.ci_type] ?? HardDrive;
              return (
                <div key={state.ci_type} className="flex items-center gap-4 px-5 py-3">
                  <div
                    className={clsx(
                      'w-8 h-8 rounded-lg flex items-center justify-center',
                      state.last_status === 'success'
                        ? 'bg-status-success/10'
                        : state.last_status === 'error'
                          ? 'bg-status-failed/10'
                          : 'bg-background',
                    )}
                  >
                    <Icon className="w-4 h-4 text-text-secondary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-text-primary">{state.ci_type}</div>
                    <div className="text-xs text-text-tertiary">
                      {state.last_sync_at ? (
                        <span className="inline-flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {new Date(state.last_sync_at).toLocaleString('zh-CN')}
                          {state.last_sync_duration_ms !== null && ` · ${state.last_sync_duration_ms}ms`}
                        </span>
                      ) : (
                        '未同步'
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-medium text-text-primary">{state.last_count}</div>
                    <div className="text-xs text-text-tertiary">条记录</div>
                  </div>
                  <div
                    className={clsx(
                      'px-2 py-0.5 text-xs font-medium rounded-full',
                      state.last_status === 'success'
                        ? 'bg-status-success/10 text-status-success'
                        : state.last_status === 'error'
                          ? 'bg-status-failed/10 text-status-failed'
                          : state.last_status === 'partial'
                            ? 'bg-yellow-500/10 text-yellow-600'
                            : 'bg-background text-text-tertiary',
                    )}
                  >
                    {state.last_status}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* === 同步日志 === */}
      <div className="bg-surface rounded-xl border border-border overflow-hidden">
        <div className="px-5 py-3 border-b border-border">
          <h4 className="text-sm font-semibold text-text-primary">最近同步日志</h4>
        </div>
        <div className="max-h-64 overflow-auto">
          {(!syncLogs || syncLogs.length === 0) ? (
            <div className="px-5 py-6 text-center text-sm text-text-tertiary">暂无日志</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-background text-text-tertiary">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">时间</th>
                  <th className="text-left px-4 py-2 font-medium">类型</th>
                  <th className="text-left px-4 py-2 font-medium">操作</th>
                  <th className="text-left px-4 py-2 font-medium">结果</th>
                  <th className="text-left px-4 py-2 font-medium">详情</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {syncLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-background">
                    <td className="px-4 py-2 text-text-secondary whitespace-nowrap">
                      {new Date(log.timestamp).toLocaleString('zh-CN')}
                    </td>
                    <td className="px-4 py-2 text-text-secondary">{log.ci_type}</td>
                    <td className="px-4 py-2">
                      <span
                        className={clsx(
                          'inline-block px-1.5 py-0.5 rounded text-xs font-medium',
                          log.action === 'create'
                            ? 'bg-status-success/10 text-status-success'
                            : log.action === 'update'
                              ? 'bg-primary/10 text-primary'
                              : log.action === 'error'
                                ? 'bg-status-failed/10 text-status-failed'
                                : 'bg-background text-text-tertiary',
                        )}
                      >
                        {log.action}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      {log.success ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-status-success" />
                      ) : (
                        <AlertCircle className="w-3.5 h-3.5 text-status-failed" />
                      )}
                    </td>
                    <td className="px-4 py-2 text-text-secondary max-w-xs truncate">
                      {log.message ?? `${log.platform_table ?? ''}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
