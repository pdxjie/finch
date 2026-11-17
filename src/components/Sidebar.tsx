import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowLeftRight,
  BookMarked,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Command,
  Database,
  Download,
  Eye,
  History,
  KeyRound,
  Layers,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Search,
  Server,
  Sparkles,
  Table2,
  Trash2,
  Unplug,
  X,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useStore, type SidebarMode } from '../store';
import type { ConnectionProfile, DatabaseInfo, TableInfo } from '../types';
import { formatDuration, formatNumber, relativePath, splitSqlPreview, timeAgo } from '../lib/format';
import { IconButton, Kbd, Spinner, StatusDot } from './ui';
import { ContextMenu, type ContextMenuItem, type ContextMenuState } from './ContextMenu';

const SYSTEM_DBS = new Set(['information_schema', 'performance_schema', 'mysql', 'sys']);
const CATEGORY_ORDER = ['local', 'dev', 'staging', 'prod'];
const CATEGORY_LABELS: Record<string, string> = {
  local: '本地',
  dev: '开发',
  staging: '预发',
  prod: '生产',
};

export function Sidebar() {
  const mode = useStore((state) => state.sidebarMode);
  const setSidebarMode = useStore((state) => state.setSidebarMode);
  const setModal = useStore((state) => state.setModal);
  const setPaletteOpen = useStore((state) => state.setPaletteOpen);
  const connections = useStore((state) => state.connections);
  const history = useStore((state) => state.history);
  const snippets = useStore((state) => state.snippets);
  const sessions = useStore((state) => state.sessions);
  const activeConnectionId = useStore((state) => state.activeConnectionId);
  const openDashboard = useStore((state) => state.openDashboard);
  const setSyncOpen = useStore((state) => state.setSyncOpen);
  const toast = useStore((state) => state.toast);
  const sessionId = activeConnectionId || Object.keys(sessions).find((id) => sessions[id].status === 'connected');

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <nav className="sidebar-mode-tabs">
          <button className={mode === 'explorer' ? 'is-active' : ''} onClick={() => setSidebarMode('explorer')}>
            连接
            {connections.length > 0 && <span>{connections.length}</span>}
          </button>
          <button className={mode === 'history' ? 'is-active' : ''} onClick={() => setSidebarMode('history')}>
            历史
            {history.length > 0 && <span>{history.length > 99 ? '99+' : history.length}</span>}
          </button>
          <button className={mode === 'saved' ? 'is-active' : ''} onClick={() => setSidebarMode('saved')}>
            收藏
            {snippets.length > 0 && <span>{snippets.length}</span>}
          </button>
        </nav>
        <button className="sidebar-add" onClick={() => setModal('connection')} aria-label="新建连接">
          <Plus size={15} />
        </button>
      </div>

      {mode === 'explorer' && <Explorer />}
      {mode === 'history' && <HistoryPanel />}
      {mode === 'saved' && <SavedPanel />}

      <div className="sidebar-bottom">
        <button className="sidebar-command" onClick={() => setPaletteOpen(true)}>
          <Command size={13} />
          <span>命令面板</span>
          <Kbd>⌘K</Kbd>
        </button>
        <button
          className="sidebar-tool-btn"
          aria-label="数据同步"
          title="数据同步"
          onClick={() => setSyncOpen(true)}
        >
          <ArrowLeftRight size={14} />
        </button>
        <button
          className="sidebar-tool-btn"
          aria-label="服务器概览"
          title="服务器概览"
          onClick={() => {
            if (sessionId && sessions[sessionId]?.status === 'connected') openDashboard(sessionId);
            else toast('info', '先连接一个数据库', '服务器概览需要一条活动连接。');
          }}
        >
          <Activity size={14} />
        </button>
      </div>
    </aside>
  );
}

function Explorer() {
  const connections = useStore((state) => state.connections);
  const sessions = useStore((state) => state.sessions);
  const pending = useStore((state) => state.pendingConnections);
  const databases = useStore((state) => state.databases);
  const tables = useStore((state) => state.tables);
  const views = useStore((state) => state.views);
  const expanded = useStore((state) => state.expanded);
  const settings = useStore((state) => state.settings);
  const activeConnectionId = useStore((state) => state.activeConnectionId);
  const setModal = useStore((state) => state.setModal);
  const connect = useStore((state) => state.connect);
  const disconnect = useStore((state) => state.disconnect);
  const loadDatabases = useStore((state) => state.loadDatabases);
  const loadTables = useStore((state) => state.loadTables);
  const loadRoutines = useStore((state) => state.loadRoutines);
  const toggleExpanded = useStore((state) => state.toggleExpanded);
  const openTable = useStore((state) => state.openTable);
  const openDatabase = useStore((state) => state.openDatabase);
  const newQuery = useStore((state) => state.newQuery);
  const refreshSchema = useStore((state) => state.refreshSchema);
  const deleteConnection = useStore((state) => state.deleteConnection);
  const toggleFavorite = useStore((state) => state.toggleFavorite);
  const askConfirm = useStore((state) => state.askConfirm);
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  const groups = useMemo(() => {
    const map = new Map<string, ConnectionProfile[]>();
    for (const connection of connections) {
      const category = connection.category || 'local';
      const list = map.get(category) || [];
      list.push(connection);
      map.set(category, list);
    }
    return [...map.entries()].sort(
      (a, b) => CATEGORY_ORDER.indexOf(a[0]) - CATEGORY_ORDER.indexOf(b[0]),
    );
  }, [connections]);

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const result: { connection: ConnectionProfile; database: string; table: TableInfo; kind: 'table' | 'view' }[] = [];
    const pushCache = (cache: Record<string, TableInfo[]>, kind: 'table' | 'view') => {
      for (const [key, list] of Object.entries(cache)) {
        const split = key.indexOf('::');
        const sessionId = key.slice(0, split);
        const database = key.slice(split + 2);
        const connection = connections.find((item) => item.id === sessionId);
        if (!connection) continue;
        for (const table of list) {
          if (table.name.toLowerCase().includes(q) || database.toLowerCase().includes(q)) {
            result.push({ connection, database, table, kind });
          }
        }
      }
    };
    pushCache(tables, 'table');
    pushCache(views, 'view');
    return result.slice(0, 80);
  }, [query, tables, views, connections]);

  const matchingConnections = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return connections;
    return connections.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.host.toLowerCase().includes(q) ||
        item.user.toLowerCase().includes(q),
    );
  }, [connections, query]);

  const openMenu = (event: React.MouseEvent, items: ContextMenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  const expandDatabase = (sessionId: string, database: string) => {
    const key = `db:${sessionId}:${database}`;
    toggleExpanded(key);
    if (!expanded[key]) {
      loadTables(sessionId, database);
      loadTables(sessionId, database, 'view');
      loadRoutines(sessionId, database);
    }
  };

  return (
    <>
      <div className="sidebar-search-row">
        <div className="sidebar-search">
          <Search size={13} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索连接或表"
            spellCheck={false}
          />
          {query && (
            <button onClick={() => setQuery('')} aria-label="Clear">
              <X size={12} />
            </button>
          )}
        </div>
        <button
          className="sidebar-tool-btn"
          title="刷新连接"
          aria-label="刷新"
          onClick={() => {
            const id = activeConnectionId || Object.keys(sessions)[0];
            if (id) refreshSchema(id);
          }}
        >
          <RefreshCw size={13} />
        </button>
      </div>

      <div className="sidebar-scroll">
        {query ? (
          <div className="search-results">
            {matchingConnections.length > 0 && (
              <div className="tree-section-label">连接</div>
            )}
            {matchingConnections.map((connection) => (
              <button
                key={connection.id}
                className="search-connection"
                onClick={() => {
                  connect(connection.id);
                  setQuery('');
                }}
              >
                <span className="connection-swatch" style={{ background: connection.color }} />
                <span>{connection.name}</span>
                <span className="search-connection-host">{connection.host}</span>
              </button>
            ))}
            {searchResults.length > 0 && <div className="tree-section-label">表与视图</div>}
            {searchResults.map(({ connection, database, table, kind }) => (
              <button
                key={`${connection.id}-${database}-${table.name}`}
                className="search-table"
                onClick={() => {
                  connect(connection.id).then((session) => {
                    if (session) openTable(connection.id, database, table.name);
                  });
                  setQuery('');
                }}
              >
                {kind === 'view' ? <Eye size={13} /> : <Table2 size={13} />}
                <span className="search-table-name">{table.name}</span>
                <span className="search-table-db">{database}</span>
              </button>
            ))}
            {searchResults.length === 0 && matchingConnections.length === 0 && (
              <div className="sidebar-empty-search">
                <CircleHelp size={18} />
                <p>没有匹配的连接或已加载的表</p>
              </div>
            )}
          </div>
        ) : connections.length === 0 ? (
          <div className="sidebar-empty">
            <div className="sidebar-empty-icon">
              <Database size={22} />
            </div>
            <h4>还没有连接</h4>
            <p>点击右上角 + 或左侧卡片添加 MySQL 连接。</p>
          </div>
        ) : (
          groups.map(([group, list]) => (
            <div key={group} className="tree-group">
              {groups.length > 1 && (
                <button
                  className="tree-group-head"
                  onClick={() => setCollapsedGroups((state) => ({ ...state, [group]: !state[group] }))}
                >
                  {collapsedGroups[group] ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                  <span>{CATEGORY_LABELS[group] || group}</span>
                  <span className="tree-group-count">{list.length}</span>
                </button>
              )}
              {(groups.length === 1 || !collapsedGroups[group]) &&
                list.map((connection) => {
                  const session = sessions[connection.id];
                  const status = pending[connection.id] ? 'connecting' : session?.status || 'offline';
                  const isExpanded = expanded[`connection:${connection.id}`];
                  const isActive = activeConnectionId === connection.id;
                  const dbs = databases[connection.id] || [];
                  const visibleDbs = settings.showSystemSchemas ? dbs : dbs.filter((db) => !db.isSystem);
                  return (
                    <div key={connection.id} className="tree-connection">
                      <div
                        className={clsx('connection-row', isActive && 'is-active')}
                        onClick={() => {
                          if (status === 'connected') toggleExpanded(`connection:${connection.id}`);
                          else if (status !== 'connecting') connect(connection.id);
                        }}
                        onContextMenu={(event) =>
                          openMenu(event, [
                            {
                              label: '编辑连接',
                              icon: Pencil,
                              onClick: () => setModal('connection', connection),
                            },
                            {
                              label: status === 'connected' ? '断开连接' : '连接',
                              icon: status === 'connected' ? Unplug : Power,
                              onClick: () => (status === 'connected' ? disconnect(connection.id) : connect(connection.id)),
                            },
                            {
                              label: '新建查询',
                              icon: Sparkles,
                              onClick: () => {
                                connect(connection.id).then(() => newQuery({ sessionId: connection.id }));
                              },
                            },
                            {
                              label: '刷新数据库',
                              icon: RefreshCw,
                              onClick: () => refreshSchema(connection.id),
                            },
                            { divider: true },
                            {
                              label: connection.favorite ? '取消收藏' : '收藏连接',
                              icon: BookMarked,
                              onClick: () => toggleFavorite(connection.id),
                            },
                            {
                              label: '复制主机地址',
                              icon: Server,
                              onClick: () => navigator.clipboard.writeText(`${connection.host}:${connection.port}`),
                            },
                            { divider: true },
                            {
                              label: '删除连接',
                              icon: Trash2,
                              danger: true,
                              onClick: () =>
                                askConfirm({
                                  title: '删除连接',
                                  message: `删除 “${connection.name}”？`,
                                  detail: '保存的密码也会从 macOS Keychain 中移除。',
                                  confirmLabel: '删除连接',
                                  onConfirm: () => deleteConnection(connection.id),
                                }),
                            },
                          ])
                        }
                      >
                        <button
                          className="tree-chevron"
                          onClick={(event) => {
                            event.stopPropagation();
                            if (status === 'connected') toggleExpanded(`connection:${connection.id}`);
                          }}
                        >
                          {status === 'connecting' ? (
                            <Spinner size={11} />
                          ) : isExpanded ? (
                            <ChevronDown size={12} />
                          ) : (
                            <ChevronRight size={12} />
                          )}
                        </button>
                        <span className="connection-avatar" style={{ background: `${connection.color}1f`, color: connection.color }}>
                          {connection.name.slice(0, 1).toUpperCase()}
                          <span className={clsx('connection-presence', `presence-${status}`)} />
                        </span>
                        <div className="connection-copy">
                          <div className="connection-name-line">
                            <span className="connection-name">{connection.name}</span>
                            <span className={`conn-env conn-env-${connection.category || 'local'}`}>
                              {CATEGORY_LABELS[connection.category || 'local'] || connection.category}
                            </span>
                            {connection.favorite && <span className="favorite-dot">●</span>}
                          </div>
                          <span className="connection-host">
                            {connection.user}@{connection.host}
                            {connection.port !== 3306 ? `:${connection.port}` : ''}
                          </span>
                        </div>
                        <div className="connection-actions">
                          {status === 'error' && <span className="connection-error-dot" title={session?.lastError || '连接失败'} />}
                          {status === 'connected' && (
                            <button
                              className="connection-power"
                              title="断开连接（停止心跳与隧道）"
                              onClick={(event) => {
                                event.stopPropagation();
                                disconnect(connection.id);
                              }}
                            >
                              <Unplug size={13} />
                            </button>
                          )}
                          <button
                            className="connection-more"
                            title="更多"
                            onClick={(event) =>
                              openMenu(event, [
                                {
                                  label: '编辑连接',
                                  icon: Pencil,
                                  onClick: () => setModal('connection', connection),
                                },
                                {
                                  label: '新建查询',
                                  icon: Sparkles,
                                  onClick: () => {
                                    connect(connection.id).then(() => newQuery({ sessionId: connection.id }));
                                  },
                                },
                                {
                                  label: '复制连接信息',
                                  icon: Server,
                                  onClick: () =>
                                    navigator.clipboard.writeText(
                                      `${connection.user}@${connection.host}:${connection.port}`,
                                    ),
                                },
                                { divider: true },
                                {
                                  label: status === 'connected' ? '断开连接' : '连接',
                                  icon: status === 'connected' ? Unplug : Power,
                                  onClick: () => (status === 'connected' ? disconnect(connection.id) : connect(connection.id)),
                                },
                              ])
                            }
                          >
                            <MoreHorizontal size={14} />
                          </button>
                        </div>
                      </div>

                      {isExpanded && status === 'connected' && (
                        <div className="tree-databases">
                          {dbs.length === 0 && (
                            <div className="tree-loading">
                              <Loader2 size={12} className="spin" /> 正在读取数据库…
                            </div>
                          )}
                          {visibleDbs.map((db) => {
                            return (
                              <DatabaseNode
                                key={db.name}
                                connection={connection}
                                database={db}
                                sessionId={connection.id}
                                expanded={expanded}
                                tables={tables[`${connection.id}::${db.name}`]}
                                views={views[`${connection.id}::${db.name}`]}
                                onToggle={() => expandDatabase(connection.id, db.name)}
                                onOpen={() => {
                                  if (!expanded[`db:${connection.id}:${db.name}`]) expandDatabase(connection.id, db.name);
                                  openDatabase(connection.id, db.name);
                                }}
                                onOpenTable={(table) => openTable(connection.id, db.name, table)}
                                onMenu={openMenu}
                                onNewQuery={() => {
                                  connect(connection.id).then(() =>
                                    newQuery({
                                      sessionId: connection.id,
                                      database: db.name,
                                      sql: `-- ${db.name}\nSELECT * FROM ${db.name === '' ? '' : `\`${db.name}\`.`} LIMIT 100;`,
                                    }),
                                  );
                                }}
                              />
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          ))
        )}
      </div>

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </>
  );
}

function DatabaseNode({
  connection,
  database,
  sessionId,
  expanded,
  tables,
  views,
  onToggle,
  onOpen,
  onOpenTable,
  onMenu,
  onNewQuery,
}: {
  connection: ConnectionProfile;
  database: DatabaseInfo;
  sessionId: string;
  expanded: Record<string, boolean>;
  tables?: TableInfo[];
  views?: TableInfo[];
  onToggle: () => void;
  onOpen: () => void;
  onOpenTable: (table: string) => void;
  onMenu: (event: React.MouseEvent, items: ContextMenuItem[]) => void;
  onNewQuery: () => void;
}) {
  const open = expanded[`db:${sessionId}:${database.name}`];
  const [section, setSection] = useState<{ tables: boolean; views: boolean }>({ tables: true, views: false });
  const openTable = useStore((state) => state.openTable);
  const activeTab = useStore((state) => state.tabs.find((tab) => tab.id === state.activeTabId));
  const highlighted = activeTab?.kind === 'database' && activeTab.sessionId === sessionId && activeTab.database === database.name;

  return (
    <div className="tree-db">
      <div
        className={clsx('db-row', highlighted && 'is-active')}
        onClick={onOpen}
        title={`浏览 ${database.name} 的表`}
        onContextMenu={(event) =>
          onMenu(event, [
            { label: '浏览这张数据库的表', icon: Database, onClick: onOpen },
            { divider: true },
            { label: '新建查询', icon: Sparkles, onClick: onNewQuery },
            {
              label: '新建表',
              icon: Table2,
              onClick: () => useStore.getState().openTableTool({ mode: 'create', sessionId, database: database.name }),
            },
            {
              label: '转储数据库',
              icon: Download,
              onClick: () => useStore.getState().openTableTool({ mode: 'dump', sessionId, database: database.name }),
            },
            { label: '刷新数据库', icon: RefreshCw, onClick: onToggle },
            { divider: true },
            {
              label: '复制数据库名',
              icon: Database,
              onClick: () => navigator.clipboard.writeText(database.name),
            },
          ])
        }
      >
        <button
          className="tree-chevron"
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          aria-label={open ? '收起' : '展开'}
        >
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </button>
        <Database size={13} className="db-icon" />
        <span className={clsx('db-name', database.isSystem && 'is-system')}>{database.name}</span>
        {tables && <span className="db-count">{tables.length}</span>}
      </div>

      {open && (
        <div className="db-children">
          <button className="tree-section" onClick={() => setSection((state) => ({ ...state, tables: !state.tables }))}>
            {section.tables ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            <Table2 size={11} />
            <span>表</span>
            <span className="tree-section-count">{tables?.length ?? '—'}</span>
          </button>
          {section.tables && (
            <div className="table-list">
              {!tables && (
                <div className="tree-loading">
                  <Loader2 size={11} className="spin" /> 加载中…
                </div>
              )}
              {tables?.length === 0 && <div className="tree-none">没有表</div>}
              {tables?.map((table) => (
                <button
                  key={table.name}
                  className="table-row"
                  onClick={() => onOpenTable(table.name)}
                  onContextMenu={(event) =>
                    onMenu(event, [
                      { label: '打开表数据', icon: Table2, onClick: () => openTable(sessionId, database.name, table.name) },
                      {
                        label: '查看表结构',
                        icon: Layers,
                        onClick: () => openTable(sessionId, database.name, table.name, 'structure'),
                      },
                      {
                        label: '在新查询中打开',
                        icon: Sparkles,
                        onClick: () =>
                          useStore.getState().newQuery({
                            sessionId,
                            database: database.name,
                            sql: `SELECT * FROM \`${database.name}\`.\`${table.name}\` LIMIT 100;`,
                          }),
                      },
                      {
                        label: '编辑表结构',
                        icon: Pencil,
                        onClick: () =>
                          useStore.getState().openTableTool({
                            mode: 'edit',
                            sessionId,
                            database: database.name,
                            table: table.name,
                          }),
                      },
                      {
                        label: '转储这张表',
                        icon: Download,
                        onClick: () =>
                          useStore.getState().openTableTool({
                            mode: 'dump',
                            sessionId,
                            database: database.name,
                            table: table.name,
                          }),
                      },
                      { divider: true },
                      {
                        label: '复制表名',
                        icon: Table2,
                        onClick: () => navigator.clipboard.writeText(table.name),
                      },
                    ])
                  }
                >
                  <Table2 size={12} className="table-icon" />
                  <span className="table-name" title={table.name}>{table.name}</span>
                  {table.comment && <span className="table-comment">{table.comment}</span>}
                  <span className="table-rows">{formatNumber(table.rowEstimate)}</span>
                </button>
              ))}
            </div>
          )}

          <button className="tree-section" onClick={() => setSection((state) => ({ ...state, views: !state.views }))}>
            {section.views ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            <Eye size={11} />
            <span>视图</span>
            <span className="tree-section-count">{views?.length ?? '—'}</span>
          </button>
          {section.views && (
            <div className="table-list">
              {!views && <div className="tree-loading">加载中…</div>}
              {views?.length === 0 && <div className="tree-none">没有视图</div>}
              {views?.map((view) => (
                <button key={view.name} className="table-row" onClick={() => onOpenTable(view.name)}>
                  <Eye size={12} className="table-icon" />
                  <span className="table-name">{view.name}</span>
                  <span className="table-rows">VIEW</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function HistoryPanel() {
  const history = useStore((state) => state.history);
  const openHistory = useStore((state) => state.openHistory);
  const clearHistory = useStore((state) => state.clearHistory);
  const toast = useStore((state) => state.toast);
  const askConfirm = useStore((state) => state.askConfirm);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return history;
    return history.filter(
      (item) => item.sql.toLowerCase().includes(q) || item.connectionName.toLowerCase().includes(q),
    );
  }, [history, query]);

  return (
    <>
      <div className="sidebar-search-row">
        <div className="sidebar-search">
          <Search size={13} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索历史" spellCheck={false} />
        </div>
        <button
          className="sidebar-tool-btn"
          title="清空历史"
          aria-label="清空历史"
          onClick={() =>
            askConfirm({
              title: '清空查询历史',
              message: '清空全部查询历史？',
              detail: '此操作无法撤销，但不会影响数据库中的数据。',
              confirmLabel: '清空历史',
              onConfirm: () => clearHistory(),
            })
          }
        >
          <Trash2 size={13} />
        </button>
      </div>
      <div className="sidebar-scroll">
        {filtered.length === 0 ? (
          <div className="sidebar-empty">
            <div className="sidebar-empty-icon">
              <History size={22} />
            </div>
            <h4>{history.length ? '没有匹配结果' : '还没有查询历史'}</h4>
            <p>运行过的 SQL 会自动保存在这里，只存在你的 Mac 上。</p>
          </div>
        ) : (
          <div className="history-list">
            {filtered.slice(0, 120).map((item) => (
              <div key={item.id} className="history-item" onClick={() => openHistory(item)}>
                <div className="history-top">
                  <span className={clsx('history-state', item.success ? 'is-ok' : 'is-error')} />
                  <span className="history-connection">{item.connectionName}</span>
                  {item.database && <span className="history-db">{item.database}</span>}
                  <span className="history-time">{timeAgo(item.createdAt)}</span>
                </div>
                <code className="history-sql">{splitSqlPreview(item.sql, 160)}</code>
                <div className="history-meta">
                  <span>
                    <Clock3 size={10} /> {formatDuration(item.durationMs)}
                  </span>
                  <span>{item.rowCount} rows</span>
                  {!item.success && <span className="history-error">ERROR</span>}
                  <button
                    className="history-copy"
                    onClick={(event) => {
                      event.stopPropagation();
                      navigator.clipboard.writeText(item.sql);
                      toast('success', 'SQL 已复制');
                    }}
                  >
                    复制
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function SavedPanel() {
  const snippets = useStore((state) => state.snippets);
  const openSaved = useStore((state) => state.openSaved);
  const deleteSaved = useStore((state) => state.deleteSaved);
  const requestSaveQuery = useStore((state) => state.requestSaveQuery);
  const askConfirm = useStore((state) => state.askConfirm);
  const activeTab = useStore((state) => state.tabs.find((tab) => tab.id === state.activeTabId));
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return snippets;
    return snippets.filter((item) => item.name.toLowerCase().includes(q) || item.sql.toLowerCase().includes(q));
  }, [snippets, query]);

  return (
    <>
      <div className="sidebar-search-row">
        <div className="sidebar-search">
          <Search size={13} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索已保存查询" spellCheck={false} />
        </div>
        <button
          className="sidebar-tool-btn"
          title="保存当前查询"
          aria-label="保存当前查询"
          onClick={() => {
            if (activeTab?.kind === 'query') requestSaveQuery(activeTab.id);
          }}
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="sidebar-scroll">
        {filtered.length === 0 ? (
          <div className="sidebar-empty">
            <div className="sidebar-empty-icon">
              <BookMarked size={22} />
            </div>
            <h4>{snippets.length ? '没有匹配结果' : '还没有保存的查询'}</h4>
            <p>把常用 SQL 收藏起来，随时一键调用。</p>
            {activeTab?.kind === 'query' && (
              <button className="btn btn-primary btn-sm" onClick={() => requestSaveQuery(activeTab.id)}>
                <Plus size={14} /> 保存当前查询
              </button>
            )}
          </div>
        ) : (
          <div className="saved-list">
            {filtered.map((item) => (
              <div key={item.id} className="saved-item" onClick={() => openSaved(item)}>
                <div className="saved-top">
                  <BookMarked size={12} />
                  <span className="saved-name">{item.name}</span>
                  <button
                    className="saved-delete"
                    onClick={(event) => {
                      event.stopPropagation();
                      askConfirm({
                        title: '删除保存的查询',
                        message: `删除 “${item.name}”？`,
                        detail: '这条 SQL 会从本机移除。',
                        confirmLabel: '删除',
                        onConfirm: () => deleteSaved(item.id),
                      });
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
                <code>{splitSqlPreview(item.sql, 110)}</code>
                <span className="saved-meta">
                  {item.database || 'default'} · {timeAgo(item.updatedAt)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
