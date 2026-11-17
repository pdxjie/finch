import { Command, Moon, PanelLeft, Search, Settings2, Sun } from 'lucide-react';
import { useStore } from '../store';
import { Logo } from './Logo';
import { IconButton, Spinner, StatusDot } from './ui';

export function Titlebar() {
  const connections = useStore((state) => state.connections);
  const sessions = useStore((state) => state.sessions);
  const activeConnectionId = useStore((state) => state.activeConnectionId);
  const themeResolved = useStore((state) => state.themeResolved);
  const toggleTheme = useStore((state) => state.toggleTheme);
  const setPaletteOpen = useStore((state) => state.setPaletteOpen);
  const setModal = useStore((state) => state.setModal);
  const openDashboard = useStore((state) => state.openDashboard);
  const connect = useStore((state) => state.connect);
  const toggleSidebar = useStore((state) => state.toggleSidebar);

  const activeSession =
    (activeConnectionId && sessions[activeConnectionId]) ||
    Object.values(sessions).find((session) => session.status === 'connected') ||
    null;
  const profile = connections.find((item) => item.id === activeSession?.id);

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-brand" data-tauri-drag-region>
        <Logo size={18} />
        <span className="wordmark">Finch</span>
      </div>

      <button className="command-trigger" onClick={() => setPaletteOpen(true)}>
        <Search size={14} strokeWidth={1.9} />
        <span className="command-placeholder">搜索或执行命令</span>
        <span className="command-kbd">
          <Command size={11} /> K
        </span>
      </button>

      <div className="titlebar-actions">
        {activeSession && profile ? (
          <button
            className="session-pill"
            onClick={() => {
              if (activeSession.status === 'connected') openDashboard(activeSession.id);
              else connect(activeSession.id);
            }}
            title={activeSession.lastError || `${profile.user}@${profile.host}:${profile.port}`}
          >
            {activeSession.status === 'connecting' || activeSession.status === 'reconnecting' ? (
              <Spinner size={12} />
            ) : (
              <StatusDot status={activeSession.status} />
            )}
            <span className="session-name">{profile.name}</span>
            {activeSession.status === 'connected' && activeSession.latency !== null && (
              <span className="session-latency">{activeSession.latency} ms</span>
            )}
          </button>
        ) : (
          <button className="session-pill is-muted" onClick={() => setModal('connection')}>
            <span className="status-dot status-offline" />
            <span className="session-name">未连接</span>
          </button>
        )}

        <IconButton icon={PanelLeft} label="切换侧边栏  ⌘B" size={15} onClick={toggleSidebar} />
        <IconButton
          icon={themeResolved === 'dark' ? Sun : Moon}
          label={themeResolved === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
          size={15}
          onClick={() => toggleTheme()}
        />
        <IconButton icon={Settings2} label="设置" size={15} onClick={() => setModal('settings')} />
      </div>
    </header>
  );
}
