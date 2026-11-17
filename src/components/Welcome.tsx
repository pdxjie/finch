import { ArrowRight, Check, Clock3, Command, Database, Plus, Search, Sparkles } from 'lucide-react';
import { useStore } from '../store';
import { Logo } from './Logo';
import { Kbd, StatusDot } from './ui';
import { formatDuration, splitSqlPreview, timeAgo } from '../lib/format';

function greeting() {
  const hour = new Date().getHours();
  if (hour < 6) return '夜深了，还在查数据？';
  if (hour < 12) return '早上好，今天想查点什么？';
  if (hour < 18) return '下午好，今天想查点什么？';
  return '晚上好，今天想查点什么？';
}

export function Welcome() {
  const connections = useStore((state) => state.connections);
  const sessions = useStore((state) => state.sessions);
  const history = useStore((state) => state.history);
  const newQuery = useStore((state) => state.newQuery);
  const connect = useStore((state) => state.connect);
  const openHistory = useStore((state) => state.openHistory);
  const setModal = useStore((state) => state.setModal);
  const setPaletteOpen = useStore((state) => state.setPaletteOpen);

  const connected = Object.values(sessions).filter((session) => session.status === 'connected');
  const recentConnections = [...connections]
    .sort((a, b) => (b.lastConnectedAt || '').localeCompare(a.lastConnectedAt || ''))
    .slice(0, 4);
  const today = new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(new Date());

  return (
    <div className="welcome-v2">
      <div className="welcome-v2-inner">
        <header className="welcome-hero">
          <div className="welcome-eyebrow">
            <Logo size={18} />
            <span>FINCH WORKSPACE</span>
            <span className="welcome-date">{today}</span>
          </div>
          <h1>{greeting()}</h1>
          <p>
            连接保持温暖，SQL 随写随跑。
            {connected.length > 0
              ? ` 当前有 ${connected.length} 个连接在线。`
              : ' 选择一个连接，或先添加一个 MySQL 实例。'}
          </p>
          <div className="welcome-actions">
            <button className="btn btn-primary btn-lg" onClick={() => newQuery()}>
              新建查询 <Kbd>⌘T</Kbd>
            </button>
            <button className="btn btn-ghost btn-lg" onClick={() => setPaletteOpen(true)}>
              <Command size={14} /> 命令面板 <Kbd>⌘K</Kbd>
            </button>
          </div>
        </header>

        {connections.length === 0 ? (
          <button className="welcome-setup" onClick={() => setModal('connection')}>
            <span className="welcome-setup-icon"><Database size={20} /></span>
            <span className="welcome-setup-copy">
              <strong>添加你的第一个 MySQL 连接</strong>
              <small>支持 SSH 隧道、TLS，以及 macOS Keychain 加密凭据</small>
            </span>
            <span className="welcome-setup-action">开始 <ArrowRight size={14} /></span>
          </button>
        ) : (
          <div className="welcome-grid">
            <section className="welcome-section">
              <div className="welcome-section-head">
                <h2>连接</h2>
                <button onClick={() => setModal('connection')}><Plus size={12} /> 添加</button>
              </div>
              <div className="welcome-connection-list">
                {recentConnections.map((connection) => {
                  const session = sessions[connection.id];
                  const online = session?.status === 'connected';
                  return (
                    <button key={connection.id} className="welcome-connection" onClick={() => connect(connection.id)}>
                      <span className="welcome-conn-dot" style={{ background: connection.color }} />
                      <span className="welcome-conn-copy">
                        <strong>{connection.name}</strong>
                        <small>{connection.user}@{connection.host}:{connection.port}</small>
                      </span>
                      <span className={`welcome-conn-status ${online ? 'is-online' : ''}`}>
                        {online ? <><StatusDot status="connected" /> 已连接</> : '连接'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="welcome-section">
              <div className="welcome-section-head">
                <h2>最近查询</h2>
                {history.length > 0 && <span>{history.length}</span>}
              </div>
              {history.length === 0 ? (
                <div className="welcome-empty">
                  <Search size={15} />
                  <span>运行一条查询后，它会出现在这里。</span>
                </div>
              ) : (
                <div className="welcome-query-list">
                  {history.slice(0, 4).map((item) => (
                    <button key={item.id} className="welcome-query" onClick={() => openHistory(item)}>
                      <span className={item.success ? 'welcome-query-ok' : 'welcome-query-fail'}>
                        {item.success ? <Check size={9} /> : <Clock3 size={9} />}
                      </span>
                      <span className="welcome-query-copy">
                        <code>{splitSqlPreview(item.sql, 74)}</code>
                        <small>{item.connectionName} · {item.database || '—'} · {timeAgo(item.createdAt)}</small>
                      </span>
                      <span className="welcome-query-time">{formatDuration(item.durationMs)}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        <div className="welcome-hints">
          <span><Kbd>⌘K</Kbd> 搜索表或执行操作</span>
          <span><Kbd>⌘↵</Kbd> 运行 SQL</span>
          <span><Kbd>⌘B</Kbd> 收起侧栏</span>
          <span className="welcome-hints-spacer" />
          <span className="welcome-local"><Sparkles size={11} /> 本地优先 · 无账号 · 无遥测</span>
        </div>
      </div>
    </div>
  );
}
