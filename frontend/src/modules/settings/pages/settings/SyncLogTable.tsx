/**
 * 同步日志表格组件(从 ITopSyncSettings 拆出,避免主文件超 500 行)
 */
import { CheckCircle2, AlertCircle } from 'lucide-react';
import clsx from 'clsx';

export interface SyncLog {
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

export default function SyncLogTable({ logs }: { logs: SyncLog[] | undefined }) {
  return (
    <div className="bg-surface rounded-xl border border-border overflow-hidden">
      <div className="px-5 py-3 border-b border-border">
        <h4 className="text-sm font-semibold text-text-primary">最近同步日志</h4>
      </div>
      <div className="max-h-64 overflow-auto">
        {(!logs || logs.length === 0) ? (
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
              {logs.map((log) => (
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
  );
}
