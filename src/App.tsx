import { useEffect, useRef } from 'react';
import { AlertTriangle, Copy, Loader2, RefreshCw } from 'lucide-react';
import { useStore } from './store';
import { Titlebar } from './components/Titlebar';
import { Sidebar } from './components/Sidebar';
import { TabBar } from './components/TabBar';
import { Welcome } from './components/Welcome';
import { QueryWorkspace } from './components/QueryWorkspace';
import { TableWorkspace } from './components/TableWorkspace';
import { DatabaseWorkspace } from './components/DatabaseWorkspace';
import { Dashboard } from './components/Dashboard';
import { CommandPalette } from './components/CommandPalette';
import { ConnectionModal } from './components/ConnectionModal';
import { SettingsModal, ShortcutsModal, SaveQueryModal } from './components/SettingsModal';
import { SyncModal } from './components/SyncModal';
import { LanIncomingDialog, LanSessionDialog } from './components/Lan';
import { TableDesignerModal, DumpModal } from './components/TableTools';
import { Toasts } from './components/Toasts';
import { ConfirmDialog } from './components/ConfirmDialog';
import { InstantTooltips } from './components/Tooltips';
import { Logo } from './components/Logo';
import { EmptyState } from './components/ui';

export default function App() {
  const ready = useStore((state) => state.ready);
  const bootError = useStore((state) => state.bootError);
  const tabs = useStore((state) => state.tabs);
  const activeTabId = useStore((state) => state.activeTabId);
  const sidebarVisible = useStore((state) => state.sidebarVisible);
  const sidebarMode = useStore((state) => state.sidebarMode);
  const modal = useStore((state) => state.modal);
  const syncOpen = useStore((state) => state.syncOpen);
  const appInfo = useStore((state) => state.appInfo);
  const activeConnectionId = useStore((state) => state.activeConnectionId);
  const sessions = useStore((state) => state.sessions);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) || null;
  const autoViewDone = useRef(false);

  useEffect(() => {
    useStore.getState().init();
  }, []);

  useEffect(() => {
    if (!ready || autoViewDone.current) return;
    const view = appInfo?.devView || (import.meta.env.VITE_FINCH_VIEW || '');
    if (!view) return;
    const store = useStore.getState();
    const tab = store.tabs.find((item) => item.id === store.activeTabId);
    const sessionId =
      tab?.sessionId ||
      store.activeConnectionId ||
      Object.values(store.sessions).find((session) => session.status === 'connected')?.id;
    if (!sessionId) return;
    if (sessions[sessionId]?.status !== 'connected') return;
    const profile = store.connections.find((connection) => connection.id === sessionId);
    const database = tab?.database || profile?.database || store.databases[sessionId]?.find((db) => !db.isSystem)?.name || '';
    if (view === 'sync') {
      autoViewDone.current = true;
      store.setSyncOpen(true);
    } else if (view === 'designer' && database) {
      autoViewDone.current = true;
      store.openTableTool({ mode: 'create', sessionId, database });
    } else if (view === 'dump' && database) {
      autoViewDone.current = true;
      store.openTableTool({ mode: 'dump', sessionId, database });
    } else if (view === 'ai' && database) {
      autoViewDone.current = true;
      store.newQuery({
        sessionId,
        database,
        title: 'AI 查询',
        sql: '-- 用自然语言生成 SQL，然后在编辑器中检查并运行。',
      });
      store.setAiOpen(true);
    } else if (view === 'database' && database) {
      autoViewDone.current = true;
      store.openDatabase(sessionId, database);
    } else if ((view === 'table' || view === 'filter') && database) {
      autoViewDone.current = true;
      store.openTable(sessionId, database, appInfo?.devTable || 'orders');
    } else if (view === 'query' && database) {
      autoViewDone.current = true;
      const sql = "SELECT o.status, COUNT(*) AS orders, ROUND(SUM(o.total), 2) AS revenue\nFROM orders o\nWHERE o.placed_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)\nGROUP BY o.status\nORDER BY revenue DESC;";
      store.newQuery({ sessionId, database, title: '查询', sql }).then((id) => {
        if (id) setTimeout(() => store.runQuery(id, sql), 300);
      });
    }
  }, [ready, activeTabId, appInfo, activeConnectionId, sessions]);

  useEffect(() => {
    const removeEvent = window.finch.onEvent((event) => useStore.getState().handleEvent(event));
    const lastAction = new Map<string, number>();

    const perform = (action: string) => {
      const now = Date.now();
      if (now - (lastAction.get(action) || 0) < 260) return;
      lastAction.set(action, now);
      const store = useStore.getState();
      const active = store.tabs.find((tab) => tab.id === store.activeTabId);
      const dispatch = (command: string) =>
        window.dispatchEvent(new CustomEvent('finch:command', { detail: { action: command } }));
      switch (action) {
        case 'settings':
          store.setModal('settings');
          break;
        case 'palette':
          store.setPaletteOpen(true);
          break;
        case 'new-query':
          store.newQuery();
          break;
        case 'new-connection':
          store.setModal('connection');
          break;
        case 'shortcuts':
          store.setModal('shortcuts');
          break;
        case 'ai': {
          if (active?.kind === 'query') {
            store.setAiOpen(true);
          } else {
            const sessionId =
              active?.sessionId ||
              store.activeConnectionId ||
              Object.values(store.sessions).find((session) => session.status === 'connected')?.id;
            if (!sessionId) {
              store.setModal('connection');
              store.toast('info', '先创建一个连接', '连接 MySQL 后才能使用 AI 生成 SQL。');
            } else {
              store
                .newQuery({
                  sessionId,
                  database: active?.database,
                  title: 'AI 查询',
                  sql: '-- 用自然语言生成 SQL，然后在编辑器中检查并运行。',
                })
                .then((id) => {
                  if (id) store.setAiOpen(true);
                });
            }
          }
          break;
        }
        case 'toggle-sidebar':
          store.toggleSidebar();
          break;
        case 'toggle-theme':
          store.toggleTheme();
          break;
        case 'save-query':
          if (active?.kind === 'query') store.requestSaveQuery(active.id);
          else store.toast('info', '保存查询', '先打开一个 SQL 标签页。');
          break;
        case 'open-file':
          window.finch.app
            .openFile({ title: '打开 SQL 文件', filters: [{ name: 'SQL', extensions: ['sql', 'txt'] }] })
            .then((result) => {
              if (result.opened && result.content !== undefined) {
                const name = (result.filePath || '').split('/').pop()?.replace(/\.sql$/i, '') || '导入的查询';
                store.newQuery({
                  sql: result.content,
                  title: name,
                  sessionId: active?.sessionId,
                  database: active?.database,
                });
              }
            });
          break;
        case 'close-tab':
          if (active) store.closeTab(active.id);
          break;
        case 'close-window':
          window.close();
          break;
        case 'run':
        case 'run-all':
        case 'explain':
        case 'format':
        case 'cancel':
          if (active?.kind === 'query') dispatch(action);
          else if (action === 'run' || action === 'run-all')
            store.toast('info', '没有活动的查询', '打开一个 SQL 标签页后再运行。');
          break;
        default:
          break;
      }
    };

    const removeMenu = window.finch.onMenu((event) => perform(event.action));
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.isComposing) return;
      const key = event.key.toLowerCase();
      let action: string | null = null;
      if (key === 'k' && !event.shiftKey) action = 'palette';
      else if (key === 't' && !event.shiftKey) action = 'new-query';
      else if (key === 'w' && !event.shiftKey) action = 'close-tab';
      else if (key === 'w' && event.shiftKey) action = 'close-window';
      else if (key === 'enter' && !event.shiftKey) action = 'run';
      else if (key === 'enter' && event.shiftKey) action = 'run-all';
      else if (key === 'e' && !event.shiftKey) action = 'explain';
      else if (key === 'f' && event.shiftKey) action = 'format';
      else if (key === 'a' && event.shiftKey) action = 'ai';
      else if (key === 's' && !event.shiftKey) action = 'save-query';
      else if (key === 'b' && !event.shiftKey) action = 'toggle-sidebar';
      else if (key === ',' && !event.shiftKey) action = 'settings';
      else if (key === '.' && !event.shiftKey) action = 'cancel';
      else if (key === 'l' && event.shiftKey) action = 'toggle-theme';
      else if (key === 'n' && event.shiftKey) action = 'new-connection';
      else if (key === 'p' && !event.shiftKey) action = 'ai';
      else if (key === 'o' && !event.shiftKey) action = 'open-file';
      else if (event.shiftKey && (key === '?' || event.code === 'Slash')) action = 'shortcuts';
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      perform(action);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      removeEvent();
      removeMenu();
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const title = activeTab ? `${activeTab.title} — Finch` : 'Finch — MySQL, without the wait';
    window.finch.app.setTitle(title).catch(() => {});
  }, [activeTab?.title, ready]);

  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      localStorage.setItem(
        'finch.workspace.v1',
        JSON.stringify({
          tabs: tabs
            .filter((tab) => tab.kind === 'query')
            .map((tab) => ({
              id: tab.id,
              kind: tab.kind,
              title: tab.title,
              sessionId: tab.sessionId,
              database: tab.database,
              sql: tab.sql,
              savedQueryId: tab.savedQueryId,
              createdAt: tab.createdAt,
            })),
          activeTabId,
          sidebarMode,
          sidebarVisible,
        }),
      );
    }, 350);
    return () => clearTimeout(timer);
  }, [tabs, activeTabId, sidebarMode, sidebarVisible, ready]);

  if (!ready) {
    return (
      <div className="splash">
        <div className="splash-glow" />
        <div className="splash-mark"><Logo size={64} /></div>
        <h1>Finch</h1>
        <span className="splash-tagline">MySQL, without the wait.</span>
        <div className="splash-loading"><Loader2 size={14} className="spin" /> 正在准备你的工作区…</div>
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="splash boot-error">
        <div className="splash-mark"><AlertTriangle size={32} /></div>
        <h1>工作区加载失败</h1>
        <p>{bootError}</p>
        <div className="boot-error-actions">
          <button className="btn btn-primary" onClick={() => location.reload()}><RefreshCw size={14} /> 重试</button>
          <button className="btn btn-ghost" onClick={() => navigator.clipboard.writeText(bootError)}><Copy size={14} /> 复制错误</button>
        </div>
      </div>
    );
  }

  return (
    <div className={`app-shell ${sidebarVisible ? '' : 'is-sidebar-hidden'}`}>
      <Titlebar />
      <div className="app-body">
        {sidebarVisible && <Sidebar />}
        <main className="workspace">
          {tabs.length > 0 && <TabBar />}
          <div className="workspace-content">
            {!activeTab ? (
              <Welcome />
            ) : activeTab.kind === 'query' ? (
              <QueryWorkspace tab={activeTab} />
            ) : activeTab.kind === 'table' ? (
              <TableWorkspace key={activeTab.id} tab={activeTab} />
            ) : activeTab.kind === 'database' ? (
              <DatabaseWorkspace key={activeTab.id} tab={activeTab} />
            ) : activeTab.kind === 'dashboard' ? (
              <Dashboard key={activeTab.id} tab={activeTab} />
            ) : (
              <EmptyState title="未知标签页" description="关闭这个标签页后重试。" />
            )}
          </div>
        </main>
      </div>

      <CommandPalette />
      {modal === 'connection' && <ConnectionModal />}
      {modal === 'settings' && <SettingsModal />}
      {modal === 'shortcuts' && <ShortcutsModal />}
      {modal === 'save-query' && <SaveQueryModal />}
      {syncOpen && <SyncModal onClose={() => useStore.getState().setSyncOpen(false)} />}
      <LanIncomingDialog />
      <LanSessionDialog />
      <TableDesignerModal />
      <DumpModal />
      <ConfirmDialog />
      <InstantTooltips />
      <Toasts />
    </div>
  );
}
