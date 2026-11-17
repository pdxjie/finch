import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpRight,
  Clock3,
  Database,
  Gauge,
  HardDrive,
  Loader2,
  MemoryStick,
  Network,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
  Users,
  Zap,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useStore } from '../store';
import type { ProcessInfo, ServerOverview, WorkspaceTab } from '../types';
import { formatBytes, formatNumber, formatUptime } from '../lib/format';
import { Modal } from './Modal';
import { IconButton, Sparkline, StatusDot } from './ui';

export function Dashboard({ tab }: { tab: WorkspaceTab }) {
  const profile = useStore((state) => state.connections.find((item) => item.id === tab.sessionId));
  const session = useStore((state) => state.sessions[tab.sessionId]);
  const toast = useStore((state) => state.toast);
  const [overview, setOverview] = useState<ServerOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [auto, setAuto] = useState(true);
  const [qpsHistory, setQpsHistory] = useState<number[]>([]);
  const [killTarget, setKillTarget] = useState<ProcessInfo | null>(null);
  const [killing, setKilling] = useState(false);
  const previous = useRef<{ time: number; queries: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const data = await window.finch.server.overview(tab.sessionId);
        if (cancelled) return;
        setOverview(data);
        setError(null);
        const now = data.sampledAt;
        const prev = previous.current;
        let qps = data.status.qpsAvg;
        if (prev && now > prev.time) {
          qps = Math.max(0, (data.status.queries - prev.queries) / ((now - prev.time) / 1000));
        }
        previous.current = { time: now, queries: data.status.queries };
        setQpsHistory((history) => [...history.slice(-47), Number(qps.toFixed(2))]);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    if (auto) {
      const tick = () => {
        timer = setTimeout(async () => {
          if (!cancelled) {
            if (!document.hidden) await load();
            tick();
          }
        }, 4000);
      };
      tick();
    }
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [tab.sessionId, auto, refreshKey]);

  const killProcess = async () => {
    if (!killTarget) return;
    setKilling(true);
    try {
      await window.finch.server.kill({ sessionId: tab.sessionId, threadId: killTarget.id });
      toast('success', '已终止查询', `线程 ${killTarget.id} 已被 KILL。`);
      setKillTarget(null);
      setRefreshKey((value) => value + 1);
    } catch (err) {
      toast('error', '终止失败', err instanceof Error ? err.message : String(err));
    } finally {
      setKilling(false);
    }
  };

  if (!session || session.status !== 'connected') {
    return (
      <div className="dashboard-empty">
        <Server size={28} />
        <h3>服务器未连接</h3>
        <p>重新连接后即可查看实时指标与进程列表。</p>
        <button className="btn btn-primary" onClick={() => useStore.getState().connect(tab.sessionId)}>
          重新连接
        </button>
      </div>
    );
  }

  const qps = qpsHistory[qpsHistory.length - 1] ?? overview?.status.qpsAvg ?? 0;
  const maxConnections = Number(overview?.variables.max_connections || 0);
  const connectionRatio = maxConnections ? overview!.status.threadsConnected / maxConnections : 0;
  const slowRatio = overview?.status.queries ? (overview.status.slowQueries / overview.status.queries) * 100 : 0;
  const topBytes = Math.max(1, ...(overview?.topTables.map((table) => table.bytes) || [1]));

  return (
    <div className="dashboard">
      <div className="dashboard-head">
        <div className="dashboard-title">
          <span className="dashboard-icon"><Server size={18} /></span>
          <div>
            <div className="dashboard-title-line">
              <h2>{profile?.name || 'MySQL Server'}</h2>
              <span className="live-badge"><span /> LIVE</span>
            </div>
            <span className="dashboard-subtitle">
              <StatusDot status="connected" /> MySQL {overview?.version || session.version}
              <span>·</span>
              {profile?.host}:{profile?.port}
              <span>·</span>
              Uptime {formatUptime(overview?.status.uptime || 0)}
            </span>
          </div>
        </div>
        <div className="dashboard-actions">
          <label className="auto-refresh">
            <input type="checkbox" checked={auto} onChange={(event) => setAuto(event.target.checked)} />
            <span className="auto-dot" />
            自动刷新
          </label>
          <IconButton icon={RefreshCw} label="立即刷新" size={15} onClick={() => setRefreshKey((value) => value + 1)} />
        </div>
      </div>

      {error && (
        <div className="dashboard-error">
          <AlertTriangle size={14} />
          <span>{error}</span>
          <button onClick={() => setRefreshKey((value) => value + 1)}>重试</button>
        </div>
      )}

      <div className="metric-grid">
        <div className="metric-card metric-hero">
          <div className="metric-head">
            <span className="metric-label"><Zap size={13} /> Queries / second</span>
            <span className="metric-trend is-up"><ArrowUpRight size={11} /> live</span>
          </div>
          <div className="metric-value">{qps.toFixed(1)}</div>
          <Sparkline values={qpsHistory.length ? qpsHistory : [0]} width={280} height={50} />
          <span className="metric-foot">平均 {overview?.status.qpsAvg.toFixed(2) ?? '—'} qps · 累计 {formatNumber(overview?.status.queries || 0)} 次查询</span>
        </div>

        <div className="metric-card">
          <div className="metric-head">
            <span className="metric-label"><Users size={13} /> Connections</span>
            <span className="metric-trend">{maxConnections ? `${Math.round(connectionRatio * 100)}%` : '—'}</span>
          </div>
          <div className="metric-value">{overview?.status.threadsConnected ?? '—'}</div>
          <div className="metric-progress"><span style={{ width: `${Math.min(100, connectionRatio * 100)}%` }} /></div>
          <span className="metric-foot">
            {overview?.status.threadsRunning ?? 0} 个运行中 · 上限 {maxConnections || '—'}
          </span>
        </div>

        <div className="metric-card">
          <div className="metric-head">
            <span className="metric-label"><Gauge size={13} /> Slow queries</span>
            <span className={clsx('metric-trend', slowRatio > 1 && 'is-warn')}>{slowRatio.toFixed(2)}%</span>
          </div>
          <div className="metric-value">{formatNumber(overview?.status.slowQueries || 0)}</div>
          <div className="metric-substats">
            <div><strong>{formatNumber(overview?.status.slowQueries || 0)}</strong><span>累计慢查询</span></div>
            <div><strong>{formatNumber(overview?.status.abortedConnects || 0)}</strong><span>中止连接</span></div>
          </div>
          <div className="metric-progress slow-progress"><span style={{ width: `${Math.min(100, slowRatio * 12)}%` }} /></div>
          <span className="metric-foot">慢查询占比 · 上限由 long_query_time 决定</span>
        </div>

        <div className="metric-card">
          <div className="metric-head">
            <span className="metric-label"><HardDrive size={13} /> Data size</span>
            <span className="metric-trend">{overview?.databaseStats.schemaCount ?? 0} schemas</span>
          </div>
          <div className="metric-value">{formatBytes(overview?.databaseStats.bytes || 0)}</div>
          <div className="metric-split">
            <span><MemoryStick size={10} /> Buffer pool {formatBytes(overview?.status.innodbBufferPoolSize || 0)}</span>
            <span><Database size={10} /> ~{formatNumber(overview?.databaseStats.rowEstimate || 0)} rows</span>
          </div>
          <span className="metric-foot">网络 ↓ {formatBytes(overview?.status.bytesReceived || 0)} · ↑ {formatBytes(overview?.status.bytesSent || 0)}</span>
        </div>
      </div>

      <div className="dashboard-main">
        <div className="dashboard-panel process-panel">
          <div className="dashboard-panel-head">
            <div>
              <h3><Activity size={14} /> 进程列表</h3>
              <p>{overview?.processes.length ?? 0} 个线程 · 每 4 秒刷新</p>
            </div>
            <span className="panel-live"><span />{auto ? 'LIVE' : 'PAUSED'}</span>
          </div>
          <div className="process-table-wrap">
            <table className="process-table">
              <thead>
                <tr>
                  <th>ID</th><th>用户</th><th>来源</th><th>数据库</th><th>命令</th><th>时间</th><th>状态 / SQL</th><th />
                </tr>
              </thead>
              <tbody>
                {(overview?.processes || []).map((process) => (
                  <tr key={process.id}>
                    <td className="mono">{process.id}</td>
                    <td>{process.user}</td>
                    <td className="mono muted">{process.host}</td>
                    <td>{process.db || <span className="muted">—</span>}</td>
                    <td>
                      <span className={clsx('command-badge', process.command === 'Query' && 'is-query')}>{process.command}</span>
                    </td>
                    <td className="mono">{process.time}s</td>
                    <td className="process-info" title={process.info}>
                      <span>{process.state || '—'}</span>
                      {process.info && <code>{process.info}</code>}
                    </td>
                    <td>
                      {process.command !== 'Sleep' && (
                        <button className="kill-btn" title="KILL 线程" onClick={() => setKillTarget(process)}>
                          <Trash2 size={12} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {loading && !overview && (
              <div className="process-loading"><Loader2 size={17} className="spin" /> 正在读取服务器指标…</div>
            )}
          </div>
        </div>

        <div className="dashboard-side">
          <div className="dashboard-panel">
            <div className="dashboard-panel-head compact">
              <h3><HardDrive size={14} /> 最大的表</h3>
            </div>
            <div className="top-tables">
              {(overview?.topTables || []).map((table) => (
                <div className="top-table" key={`${table.db}.${table.name}`}>
                  <div className="top-table-line">
                    <span title={table.name}>{table.name}</span>
                    <span>{formatBytes(table.bytes)}</span>
                  </div>
                  <div className="top-table-bar"><span style={{ width: `${Math.max(3, (table.bytes / topBytes) * 100)}%` }} /></div>
                  <div className="top-table-meta">{table.db} · ~{formatNumber(table.rowsEstimate)} rows</div>
                </div>
              ))}
              {!overview?.topTables.length && <div className="panel-empty">没有可展示的表</div>}
            </div>
          </div>

          <div className="dashboard-panel">
            <div className="dashboard-panel-head compact">
              <h3><ShieldCheck size={14} /> 服务器信息</h3>
            </div>
            <div className="server-facts">
              <div><span>Version</span><strong>{overview?.version || session.version}</strong></div>
              <div><span>Charset</span><strong>{overview?.variables.character_set_server || '—'}</strong></div>
              <div><span>Collation</span><strong>{overview?.variables.collation_server || '—'}</strong></div>
              <div><span>Hostname</span><strong>{overview?.variables.hostname || '—'}</strong></div>
              <div><span>Max used</span><strong>{overview?.status.maxUsedConnections ?? '—'}</strong></div>
              <div><span>Replication</span><strong>{overview?.replication ? (overview.replication.Replica_IO_Running === 'Yes' ? '健康' : '需检查') : '未启用'}</strong></div>
            </div>
          </div>

          <div className="dashboard-panel network-card">
            <div className="network-row">
              <span className="network-icon"><Network size={14} /></span>
              <div><span>接收流量</span><strong>{formatBytes(overview?.status.bytesReceived || 0)}</strong></div>
            </div>
            <div className="network-row">
              <span className="network-icon is-up"><ArrowUpRight size={14} /></span>
              <div><span>发送流量</span><strong>{formatBytes(overview?.status.bytesSent || 0)}</strong></div>
            </div>
            <div className="network-row">
              <span className="network-icon is-clock"><Clock3 size={14} /></span>
              <div><span>运行时长</span><strong>{formatUptime(overview?.status.uptime || 0)}</strong></div>
            </div>
          </div>
        </div>
      </div>

      <Modal
        open={Boolean(killTarget)}
        onClose={() => setKillTarget(null)}
        title="终止数据库线程"
        subtitle="KILL 会立即中断正在执行的查询"
        icon={<AlertTriangle size={17} />}
        size="sm"
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setKillTarget(null)}>取消</button>
            <button className="btn btn-danger" onClick={killProcess} disabled={killing}>
              {killing ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />} 终止线程 {killTarget?.id}
            </button>
          </>
        }
      >
        <div className="confirm-copy">
          <div className="danger-callout">
            <AlertTriangle size={16} />
            <span>未提交的事务会回滚，正在执行的应用请求可能失败。</span>
          </div>
          <p>线程 <strong>{killTarget?.id}</strong>（{killTarget?.user}@{killTarget?.host}）已运行 {killTarget?.time}s。</p>
          {killTarget?.info && <pre className="kill-sql">{killTarget.info}</pre>}
        </div>
      </Modal>
    </div>
  );
}
