import { create } from 'zustand';
import { streamedSql } from './lib/aiStreaming';
import { applyVisualSettings, visualZoom } from './lib/visual';
import type {
  AppInfo,
  AppSettings,
  ColumnInfo,
  ConnectionProfile,
  DatabaseInfo,
  FinchyEvent,
  HistoryItem,
  ProcessInfo,
  QueryResult,
  SavedQuery,
  SessionInfo,
  TableData,
  TableDetails,
  TableFilter,
  TableInfo,
  TableQuery,
  ThemeMode,
  Toast,
  ToastLevel,
  WorkspaceTab,
} from './types';

const api = () => window.finch;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`);

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  showSystemSchemas: false,
  maxRows: 5000,
  confirmDestructive: true,
  autoLimitSelects: true,
  queryTimeoutSeconds: 60,
  editorFontSize: 13,
  uiFont: '',
  monoFont: '',
  uiFontSize: 13,
  accentColor: '#5068f0',
  motion: 'full',
  gridDensity: 'comfortable',
  zoomFactor: 1,
  lastConnectionId: null,
};

export type SidebarMode = 'explorer' | 'history' | 'saved';
export type ModalKind = 'connection' | 'settings' | 'shortcuts' | 'save-query' | 'row-editor' | null;
export type TableToolState =
  | { mode: 'create'; sessionId: string; database: string }
  | { mode: 'edit'; sessionId: string; database: string; table: string }
  | { mode: 'dump'; sessionId: string; database: string; table?: string; tables?: string[] }
  | null;

interface SaveQueryState {
  tabId: string;
  name: string;
  sql: string;
}

export interface ConfirmOptions {
  title: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
}

interface Store {
  ready: boolean;
  bootError: string | null;
  connections: ConnectionProfile[];
  sessions: Record<string, SessionInfo>;
  pendingConnections: Record<string, boolean>;
  activeConnectionId: string | null;
  databases: Record<string, DatabaseInfo[]>;
  tables: Record<string, TableInfo[]>;
  views: Record<string, TableInfo[]>;
  routines: Record<string, { name: string; type: string; returnType: string; comment: string }[]>;
  columns: Record<string, Record<string, ColumnInfo[]>>;
  expanded: Record<string, boolean>;
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  history: HistoryItem[];
  snippets: SavedQuery[];
  settings: AppSettings;
  appInfo: AppInfo | null;
  sidebarMode: SidebarMode;
  sidebarVisible: boolean;
  paletteOpen: boolean;
  syncOpen: boolean;
  aiOpen: boolean;
  tableTool: TableToolState;
  modal: ModalKind;
  editingConnection: ConnectionProfile | null;
  saveQueryState: SaveQueryState | null;
  confirmState: ConfirmOptions | null;
  toasts: Toast[];
  themeResolved: 'light' | 'dark';

  init: () => Promise<void>;
  setTheme: (mode: ThemeMode) => Promise<void>;
  toggleTheme: () => Promise<void>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;

  connect: (id: string, options?: { silent?: boolean; focus?: boolean }) => Promise<SessionInfo | null>;
  disconnect: (id: string) => Promise<void>;
  toggleConnect: (id: string) => Promise<void>;
  saveConnection: (input: Partial<ConnectionProfile>) => Promise<ConnectionProfile>;
  deleteConnection: (id: string) => Promise<void>;
  toggleFavorite: (id: string) => Promise<void>;

  loadDatabases: (sessionId: string, force?: boolean) => Promise<DatabaseInfo[]>;
  loadTables: (sessionId: string, database: string, kind?: 'table' | 'view', force?: boolean) => Promise<TableInfo[]>;
  loadRoutines: (sessionId: string, database: string) => Promise<void>;
  loadAllColumns: (sessionId: string, database: string, force?: boolean) => Promise<void>;
  refreshSchema: (sessionId: string, database?: string) => Promise<void>;
  toggleExpanded: (key: string) => void;

  newQuery: (options?: { sessionId?: string; database?: string; sql?: string; title?: string }) => Promise<string | undefined>;
  openTable: (sessionId: string, database: string, table: string, view?: 'data' | 'structure') => Promise<void>;
  openDatabase: (sessionId: string, database: string) => Promise<void>;
  openDashboard: (sessionId: string) => void;
  openSaved: (saved: SavedQuery) => Promise<void>;
  openHistory: (item: HistoryItem) => Promise<void>;
  activateTab: (id: string) => void;
  closeTab: (id: string) => void;
  closeOtherTabs: (id: string) => void;
  updateTab: (id: string, patch: Partial<WorkspaceTab>) => void;
  updateSql: (id: string, sql: string) => void;
  switchQueryConnection: (tabId: string, sessionId: string) => Promise<void>;

  runQuery: (tabId: string, sqlOverride?: string) => Promise<void>;
  cancelQuery: (tabId: string) => Promise<void>;
  explainQuery: (tabId: string, sqlOverride?: string) => Promise<void>;
  generateAiSql: (tabId: string, prompt: string, providerId: string) => Promise<boolean>;
  cancelAiSql: (tabId: string) => Promise<void>;

  loadTable: (tabId: string, query?: Partial<TableQuery>) => Promise<void>;
  loadStructure: (tabId: string, force?: boolean) => Promise<void>;
  setTableView: (tabId: string, view: 'data' | 'structure') => Promise<void>;
  updateCell: (tabId: string, rowIndex: number, columnIndex: number, value: string | null) => Promise<boolean>;
  deleteTableRows: (tabId: string, rowIndexes: number[]) => Promise<boolean>;
  insertTableRow: (tabId: string, values: Record<string, string | null>) => Promise<boolean>;

  refreshHistory: () => Promise<void>;
  clearHistory: () => Promise<void>;
  requestSaveQuery: (tabId: string) => void;
  saveQuery: (tabId: string, name: string) => Promise<void>;
  deleteSaved: (id: string) => Promise<void>;

  setSidebarMode: (mode: SidebarMode) => void;
  toggleSidebar: () => void;
  setPaletteOpen: (open: boolean) => void;
  setSyncOpen: (open: boolean) => void;
  setAiOpen: (open: boolean) => void;
  openTableTool: (state: NonNullable<TableToolState>) => void;
  closeTableTool: () => void;
  setModal: (modal: ModalKind, connection?: ConnectionProfile | null) => void;
  setSaveQueryState: (state: SaveQueryState | null) => void;
  askConfirm: (options: ConfirmOptions) => void;
  closeConfirm: () => void;

  toast: (level: ToastLevel, title: string, message?: string) => void;
  dismissToast: (id: string) => void;
  handleEvent: (event: FinchyEvent) => void;
  ensureDemo: () => Promise<void>;
}

let initPromise: Promise<void> | null = null;
const tableLoads = new Map<string, number>();
const columnLoads = new Set<string>();
const aiFlushes = new Map<string, () => void>();

function applyTheme(mode: ThemeMode): 'light' | 'dark' {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const resolved = mode === 'system' ? (media.matches ? 'dark' : 'light') : mode;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  return resolved;
}

function loadWorkspace(): { tabs: WorkspaceTab[]; activeTabId: string | null; sidebarMode: SidebarMode; sidebarVisible: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem('finch.workspace.v1') || '{}');
    const tabs: WorkspaceTab[] = Array.isArray(raw.tabs)
      ? raw.tabs.filter((tab: WorkspaceTab) => tab.kind === 'query' && tab.sessionId).slice(0, 30)
      : [];
    return {
      tabs,
      activeTabId: tabs.some((tab) => tab.id === raw.activeTabId) ? raw.activeTabId : tabs[0]?.id ?? null,
      sidebarMode: ['explorer', 'history', 'saved'].includes(raw.sidebarMode) ? raw.sidebarMode : 'explorer',
      sidebarVisible: raw.sidebarVisible !== false,
    };
  } catch {
    return { tabs: [], activeTabId: null, sidebarMode: 'explorer', sidebarVisible: true };
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error || '未知错误');
}

const DEFAULT_TABLE_QUERY: TableQuery = {
  limit: 200,
  offset: 0,
  filters: [],
  search: '',
  orderBy: null,
  orderDir: 'asc',
};

function tableKey(sessionId: string, database: string, table: string) {
  return `${sessionId}::${database}::${table}`;
}

export const useStore = create<Store>((set, get) => ({
  ready: false,
  bootError: null,
  connections: [],
  sessions: {},
  pendingConnections: {},
  activeConnectionId: null,
  databases: {},
  tables: {},
  views: {},
  routines: {},
  columns: {},
  expanded: {},
  tabs: [],
  activeTabId: null,
  history: [],
  snippets: [],
  settings: DEFAULT_SETTINGS,
  appInfo: null,
  sidebarMode: 'explorer',
  sidebarVisible: true,
  paletteOpen: false,
  syncOpen: false,
  aiOpen: false,
  tableTool: null,
  modal: null,
  editingConnection: null,
  saveQueryState: null,
  confirmState: null,
  toasts: [],
  themeResolved: 'light',

  init: async () => {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      const workspace = loadWorkspace();
      try {
        const [connections, history, snippets, settings, appInfo] = await Promise.all([
          api().connections.list(),
          api().history.list(),
          api().snippets.list(),
          api().app.getSettings(),
          api().app.info(),
        ]);
        const mergedSettings = { ...DEFAULT_SETTINGS, ...settings };
        const themeResolved = applyTheme(mergedSettings.theme);
        applyVisualSettings(mergedSettings);
        api().app.setZoom(visualZoom(mergedSettings)).catch(() => {});
        const validTabs = workspace.tabs.filter((tab) =>
          connections.some((connection) => connection.id === tab.sessionId),
        );
        set({
          connections,
          history,
          snippets,
          settings: mergedSettings,
          appInfo,
          tabs: validTabs,
          activeTabId: validTabs.some((tab) => tab.id === workspace.activeTabId)
            ? workspace.activeTabId
            : validTabs[0]?.id ?? null,
          sidebarMode: workspace.sidebarMode,
          sidebarVisible: workspace.sidebarVisible,
          themeResolved,
          ready: true,
        });
        api().app.setTheme(mergedSettings.theme).catch(() => {});
        const media = window.matchMedia('(prefers-color-scheme: dark)');
        const onScheme = () => {
          if (get().settings.theme === 'system') {
            set({ themeResolved: applyTheme('system') });
          }
        };
        media.addEventListener('change', onScheme);

        if (api().env.demo) {
          await get().ensureDemo();
        } else if (mergedSettings.lastConnectionId && connections.some((item) => item.id === mergedSettings.lastConnectionId)) {
          await get().connect(mergedSettings.lastConnectionId, { silent: true });
        }
      } catch (err) {
        set({ bootError: errorText(err), ready: true, themeResolved: applyTheme('system') });
      } finally {
        setTimeout(() => api().app.ready().catch(() => {}), 400);
      }
    })();
    return initPromise;
  },

  setTheme: async (mode) => {
    const themeResolved = applyTheme(mode);
    set((state) => ({ settings: { ...state.settings, theme: mode }, themeResolved }));
    await api().app.setTheme(mode).catch(() => {});
    await api().app.setSettings({ theme: mode }).catch(() => {});
  },

  toggleTheme: async () => {
    const current = get().themeResolved;
    await get().setTheme(current === 'dark' ? 'light' : 'dark');
  },

  updateSettings: async (patch) => {
    set((state) => ({ settings: { ...state.settings, ...patch } }));
    if (patch.theme) applyTheme(patch.theme);
    const next = { ...get().settings, ...patch };
    applyVisualSettings(next);
    api().app.setZoom(visualZoom(next)).catch(() => {});
    try {
      const saved = await api().app.setSettings(patch);
      set({ settings: { ...DEFAULT_SETTINGS, ...saved } });
    } catch (err) {
      get().toast('error', '设置保存失败', errorText(err));
    }
  },

  connect: async (id, options = {}) => {
    const profile = get().connections.find((item) => item.id === id);
    if (!profile) return null;
    if (get().sessions[id]?.status === 'connected') {
      if (options.focus !== false) set({ activeConnectionId: id });
      return get().sessions[id];
    }
    if (get().pendingConnections[id]) return null;
    set((state) => ({
      pendingConnections: { ...state.pendingConnections, [id]: true },
      sessions: {
        ...state.sessions,
        [id]: {
          id,
          status: 'connecting',
          version: '',
          latency: null,
          connectedAt: Date.now(),
        },
      },
    }));
    try {
      const info = await api().connections.connect(id);
      set((state) => ({
        sessions: { ...state.sessions, [id]: info },
        pendingConnections: { ...state.pendingConnections, [id]: false },
        activeConnectionId: options.focus === false ? state.activeConnectionId : id,
        expanded: { ...state.expanded, [`connection:${id}`]: true },
      }));
      if (!options.silent) {
        get().toast('success', '连接成功', `${profile.name} · MySQL ${info.version} · ${info.latency ?? 0} ms`);
      }
      await get().loadDatabases(id, true);
      const databases = get().databases[id] || [];
      const targetDb = profile.database || databases.find((db) => !db.isSystem)?.name;
      if (targetDb) {
        set((state) => ({
          expanded: { ...state.expanded, [`db:${id}:${targetDb}`]: true },
        }));
        await get().loadTables(id, targetDb);
        get().loadTables(id, targetDb, 'view').catch(() => {});
      }
      return info;
    } catch (err) {
      set((state) => ({
        sessions: {
          ...state.sessions,
          [id]: {
            ...(state.sessions[id] || { id, version: '', latency: null, connectedAt: Date.now() }),
            status: 'error',
            lastError: errorText(err),
          },
        },
        pendingConnections: { ...state.pendingConnections, [id]: false },
      }));
      if (!options.silent) get().toast('error', '连接失败', errorText(err));
      else get().toast('warning', `${profile.name} 暂时无法连接`, errorText(err));
      return null;
    }
  },

  disconnect: async (id) => {
    await api().connections.disconnect(id).catch(() => {});
    set((state) => {
      const sessions = { ...state.sessions };
      delete sessions[id];
      return { sessions, activeConnectionId: state.activeConnectionId === id ? null : state.activeConnectionId };
    });
  },

  toggleConnect: async (id) => {
    if (get().sessions[id]?.status === 'connected') await get().disconnect(id);
    else await get().connect(id);
  },

  saveConnection: async (input) => {
    const saved = await api().connections.save(input);
    set((state) => {
      const exists = state.connections.some((item) => item.id === saved.id);
      return {
        connections: exists
          ? state.connections.map((item) => (item.id === saved.id ? saved : item))
          : [...state.connections, saved],
        activeConnectionId: state.activeConnectionId || saved.id,
      };
    });
    return saved;
  },

  deleteConnection: async (id) => {
    for (const tab of get().tabs) {
      if (tab.sessionId === id && tab.aiGenerating) get().cancelAiSql(tab.id).catch(() => {});
    }
    await api().connections.remove(id);
    await get().disconnect(id);
    set((state) => ({
      connections: state.connections.filter((item) => item.id !== id),
      tabs: state.tabs.filter((tab) => tab.sessionId !== id),
      activeTabId: state.tabs.find((tab) => tab.id === state.activeTabId)?.sessionId === id ? null : state.activeTabId,
    }));
    get().toast('info', '已删除连接', '连接配置已从本机移除。');
  },

  toggleFavorite: async (id) => {
    const profile = get().connections.find((item) => item.id === id);
    if (!profile) return;
    await get().saveConnection({ ...profile, favorite: !profile.favorite });
  },

  loadDatabases: async (sessionId, force = false) => {
    if (!force && get().databases[sessionId]?.length) return get().databases[sessionId];
    try {
      const databases = await api().schema.databases(sessionId);
      set((state) => ({ databases: { ...state.databases, [sessionId]: databases } }));
      return databases;
    } catch (err) {
      get().toast('error', '无法读取数据库列表', errorText(err));
      return [];
    }
  },

  loadAllColumns: async (sessionId, database, force = false) => {
    const key = `${sessionId}::${database}`;
    if (!force && get().columns[key]) return;
    if (columnLoads.has(key)) return;
    columnLoads.add(key);
    try {
      const columns = await api().schema.allColumns(sessionId, database);
      set((state) => ({ columns: { ...state.columns, [key]: columns } }));
    } catch {
      /* autocomplete falls back to opened tables */
    } finally {
      columnLoads.delete(key);
    }
  },

  loadTables: async (sessionId, database, kind = 'table', force = false) => {
    const key = `${sessionId}::${database}`;
    const bucket = kind === 'view' ? get().views : get().tables;
    if (!force && bucket[key]?.length) return bucket[key];
    try {
      const tables = await api().schema.tables(sessionId, database, kind);
      set((state) =>
        kind === 'view'
          ? { views: { ...state.views, [key]: tables } }
          : { tables: { ...state.tables, [key]: tables } },
      );
      return tables;
    } catch (err) {
      get().toast('error', '无法读取表列表', errorText(err));
      return [];
    }
  },

  loadRoutines: async (sessionId, database) => {
    try {
      const routines = await api().schema.routines(sessionId, database);
      set((state) => ({ routines: { ...state.routines, [`${sessionId}::${database}`]: routines } }));
    } catch {
      /* routines are optional */
    }
  },

  refreshSchema: async (sessionId, database) => {
    await api().schema.refresh(sessionId).catch(() => {});
    await get().loadDatabases(sessionId, true);
    if (database) {
      await Promise.all([
        get().loadTables(sessionId, database, 'table', true),
        get().loadTables(sessionId, database, 'view', true),
        get().loadAllColumns(sessionId, database, true),
      ]);
    } else {
      const dbs = (get().databases[sessionId] || []).filter((db) => !db.isSystem).slice(0, 12);
      await Promise.all(
        dbs.flatMap((db) => [
          get().loadTables(sessionId, db.name, 'table', true),
          get().loadTables(sessionId, db.name, 'view', true),
          get().loadAllColumns(sessionId, db.name, true),
        ]),
      );
    }
  },

  toggleExpanded: (key) => {
    set((state) => ({ expanded: { ...state.expanded, [key]: !state.expanded[key] } }));
  },

  newQuery: async (options = {}) => {
    const state = get();
    const connected = Object.values(state.sessions).filter((session) => session.status === 'connected');
    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    let sessionId = options.sessionId || activeTab?.sessionId || state.activeConnectionId || connected[0]?.id;
    if (!sessionId && state.connections[0]) {
      sessionId = state.connections[0].id;
    }
    if (!sessionId) {
      get().setModal('connection');
      get().toast('info', '先创建一个连接', 'Finch 需要一个 MySQL 连接才能开始查询。');
      return;
    }
    const profile = state.connections.find((item) => item.id === sessionId);
    let database = options.database || (activeTab?.sessionId === sessionId ? activeTab.database : '') || '';
    if (!database) database = profile?.database || state.tabs.find((tab) => tab.sessionId === sessionId)?.database || '';
    if (!database) {
      const dbs = state.databases[sessionId] || [];
      database = dbs.find((db) => !db.isSystem)?.name || '';
    }
    const tab: WorkspaceTab = {
      id: uid(),
      kind: 'query',
      title: options.title || '查询',
      sessionId,
      database,
      sql: options.sql || '',
      createdAt: Date.now(),
      result: null,
      resultIndex: 0,
      error: null,
    };
    set((current) => ({
      tabs: [...current.tabs, tab],
      activeTabId: tab.id,
      activeConnectionId: sessionId,
    }));
    return tab.id;
  },

  openTable: async (sessionId, database, table, view = 'data') => {
    const existing = get().tabs.find(
      (tab) => tab.kind === 'table' && tab.sessionId === sessionId && tab.database === database && tab.table === table,
    );
    if (existing) {
      get().activateTab(existing.id);
      if (view === 'structure' && existing.tableView !== 'structure') {
        await get().setTableView(existing.id, 'structure');
      }
      return;
    }
    const tab: WorkspaceTab = {
      id: uid(),
      kind: 'table',
      title: table,
      sessionId,
      database,
      table,
      sql: '',
      createdAt: Date.now(),
      result: null,
      tableData: null,
      tableDetails: null,
      tableQuery: { ...DEFAULT_TABLE_QUERY },
      tableView: view,
      tableLoading: true,
    };
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
      activeConnectionId: sessionId,
    }));
    if (view === 'structure') await get().loadStructure(tab.id);
    else await get().loadTable(tab.id);
  },

  openDatabase: async (sessionId, database) => {
    const existing = get().tabs.find(
      (tab) => tab.kind === 'database' && tab.sessionId === sessionId && tab.database === database,
    );
    if (existing) {
      get().activateTab(existing.id);
      return;
    }
    const tab: WorkspaceTab = {
      id: uid(),
      kind: 'database',
      title: database,
      sessionId,
      database,
      sql: '',
      createdAt: Date.now(),
    };
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
      activeConnectionId: sessionId,
    }));
  },

  openDashboard: (sessionId) => {
    const existing = get().tabs.find((tab) => tab.kind === 'dashboard' && tab.sessionId === sessionId);
    if (existing) {
      get().activateTab(existing.id);
      return;
    }
    const profile = get().connections.find((item) => item.id === sessionId);
    const tab: WorkspaceTab = {
      id: uid(),
      kind: 'dashboard',
      title: '服务器概览',
      sessionId,
      database: '',
      sql: '',
      createdAt: Date.now(),
    };
    set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id, activeConnectionId: sessionId }));
  },

  openSaved: async (saved) => {
    const profile = saved.connectionId
      ? get().connections.find((item) => item.id === saved.connectionId)
      : null;
    const sessionId = profile?.id || get().activeConnectionId || Object.values(get().sessions)[0]?.id;
    if (!sessionId) {
      get().toast('warning', '没有可用连接', '请先连接一个数据库。');
      return;
    }
    await get().newQuery({ sessionId, database: saved.database, sql: saved.sql, title: saved.name });
    const active = get().tabs[get().tabs.length - 1];
    if (active?.kind === 'query') get().updateTab(active.id, { savedQueryId: saved.id });
  },

  openHistory: async (item) => {
    const sessionId = item.connectionId || get().activeConnectionId;
    if (!sessionId) return;
    const database =
      item.database ||
      get().databases[sessionId]?.find((db) => !db.isSystem)?.name ||
      '';
    await get().newQuery({ sessionId, database, sql: item.sql, title: '历史查询' });
  },

  activateTab: (id) => {
    const tab = get().tabs.find((item) => item.id === id);
    set({ activeTabId: id, activeConnectionId: tab?.sessionId || get().activeConnectionId });
    if (tab?.kind === 'table' && !tab.tableData && !tab.tableLoading) get().loadTable(tab.id);
    if (tab?.kind === 'table' && tab.tableView === 'structure' && !tab.tableDetails) get().loadStructure(tab.id);
    if (tab?.kind === 'database') {
      const key = `${tab.sessionId}::${tab.database}`;
      if (!get().tables[key]) get().loadTables(tab.sessionId, tab.database).catch(() => []);
      if (!get().views[key]) get().loadTables(tab.sessionId, tab.database, 'view').catch(() => []);
    }
  },

  closeTab: (id) => {
    const state = get();
    const closing = state.tabs.find((tab) => tab.id === id);
    if (closing?.aiGenerating) get().cancelAiSql(id).catch(() => {});
    if (closing?.running && closing.executionId) {
      api().query.cancel(closing.executionId, closing.sessionId).catch(() => {});
    }
    const index = state.tabs.findIndex((tab) => tab.id === id);
    const tabs = state.tabs.filter((tab) => tab.id !== id);
    let activeTabId = state.activeTabId;
    if (activeTabId === id) activeTabId = tabs[Math.max(0, index - 1)]?.id || tabs[0]?.id || null;
    set({ tabs, activeTabId });
  },

  closeOtherTabs: (id) => {
    const tab = get().tabs.find((item) => item.id === id);
    if (!tab) return;
    for (const other of get().tabs) {
      if (other.id !== id && other.aiGenerating) get().cancelAiSql(other.id).catch(() => {});
    }
    set({ tabs: [tab], activeTabId: id });
  },

  updateTab: (id, patch) => {
    set((state) => ({ tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)) }));
  },

  updateSql: (id, sql) => {
    set((state) => ({ tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, sql } : tab)) }));
  },

  switchQueryConnection: async (tabId, sessionId) => {
    const tab = get().tabs.find((item) => item.id === tabId);
    if (!tab || tab.kind !== 'query' || tab.running || tab.aiGenerating || tab.switchingConnection || tab.sessionId === sessionId) return;
    const profile = get().connections.find((item) => item.id === sessionId);
    if (!profile) return;
    get().updateTab(tabId, { switchingConnection: true });
    try {
      const connected = await get().connect(sessionId, { focus: false });
      if (!connected) return;
      const databases = await api().schema.databases(sessionId);
      set((state) => ({ databases: { ...state.databases, [sessionId]: databases } }));
      const current = get().tabs.find((item) => item.id === tabId);
      if (!current || current.sessionId !== tab.sessionId || current.running) return;
      const hasDatabase = (name?: string) => databases.some((database) => database.name === name);
      const database = hasDatabase(tab.database) ? tab.database
        : hasDatabase(profile.database) ? profile.database
        : databases.find((item) => !item.isSystem)?.name || '';
      set((state) => ({
        tabs: state.tabs.map((item) => item.id === tabId ? {
          ...item, sessionId, database, result: null, resultIndex: 0,
          error: null, lastRunMs: undefined, executionId: undefined,
        } : item),
        activeConnectionId: state.activeTabId === tabId ? sessionId : state.activeConnectionId,
      }));
      if (database) {
        get().loadTables(sessionId, database).catch(() => {});
        get().loadTables(sessionId, database, 'view').catch(() => {});
      }
    } catch (err) {
      get().toast('error', '切换连接失败', errorText(err));
    } finally {
      get().updateTab(tabId, { switchingConnection: false });
    }
  },

  runQuery: async (tabId, sqlOverride) => {
    const tab = get().tabs.find((item) => item.id === tabId);
    if (!tab || tab.running || tab.aiGenerating || tab.switchingConnection) return;
    const sql = sqlOverride ?? tab.sql;
    if (!sql.trim()) {
      get().toast('info', '还没有 SQL', '写一条查询，然后用 ⌘↵ 运行。');
      return;
    }
    if (!tab.sessionId) {
      get().toast('warning', '没有连接', '请先连接一个数据库。');
      return;
    }
    const executionId = uid();
    get().updateTab(tabId, { running: true, executionId, preparingQuery: true, error: null });
    let session = get().sessions[tab.sessionId];
    if (!session || session.status !== 'connected') {
      const connected = await get().connect(tab.sessionId);
      if (!connected) {
        if (get().tabs.find((item) => item.id === tabId)?.executionId === executionId) {
          get().updateTab(tabId, { running: false, executionId: undefined, preparingQuery: false });
        }
        return;
      }
      session = connected;
    }
    if (get().tabs.find((item) => item.id === tabId)?.executionId !== executionId) return;
    get().updateTab(tabId, { preparingQuery: false });
    const started = Date.now();
    try {
      const result = await api().query.execute({
        sessionId: tab.sessionId,
        sql,
        database: tab.database,
        executionId,
        maxRows: get().settings.maxRows,
        autoLimit: get().settings.autoLimitSelects,
        timeoutMs: (get().settings.queryTimeoutSeconds || 0) * 1000,
      });
      if (get().tabs.find((item) => item.id === tabId)?.executionId !== executionId) return;
      let resultIndex = result.statements.findIndex((item) => item.kind === 'rows');
      if (resultIndex < 0) resultIndex = 0;
      get().updateTab(tabId, {
        running: false,
        result,
        resultIndex,
        executionId: undefined,
        error: null,
        lastRunMs: Date.now() - started,
      });
      const failed = result.statements.find((item) => item.kind === 'error');
      if (result.cancelled) {
        get().toast('info', '查询已取消', '已向 MySQL 发送 KILL QUERY。');
      } else if (failed?.error) {
        get().toast('error', 'SQL 执行失败', failed.error.message);
      }
      if (/\b(CREATE|ALTER|DROP|RENAME|TRUNCATE)\b/i.test(sql)) {
        get().refreshSchema(tab.sessionId, tab.database).catch(() => {});
      }
      get().refreshHistory().catch(() => {});
      const rows = result.statements.reduce((sum, item) => sum + (item.kind === 'rows' ? item.rowCount : 0), 0);
      if (!failed && rows === 0 && result.statements.every((item) => item.kind === 'command')) {
        get().toast('success', '执行完成', `${Date.now() - started} ms`);
      }
    } catch (err) {
      if (get().tabs.find((item) => item.id === tabId)?.executionId !== executionId) return;
      get().updateTab(tabId, { running: false, executionId: undefined, error: errorText(err) });
      get().toast('error', 'SQL 执行失败', errorText(err));
    }
  },

  cancelQuery: async (tabId) => {
    const tab = get().tabs.find((item) => item.id === tabId);
    if (!tab?.executionId) return;
    if (tab.preparingQuery) {
      get().updateTab(tabId, { running: false, preparingQuery: false, executionId: undefined });
      return;
    }
    try {
      await api().query.cancel(tab.executionId, tab.sessionId);
      get().toast('info', '正在取消查询', '已向 MySQL 发送 KILL QUERY。');
    } catch (err) {
      get().toast('error', '取消失败', errorText(err));
    }
  },

  explainQuery: async (tabId, sqlOverride) => {
    const tab = get().tabs.find((item) => item.id === tabId);
    if (!tab || tab.running || tab.aiGenerating || tab.switchingConnection) return;
    const sql = (sqlOverride ?? tab.sql).trim();
    if (!sql) return;
    const executionId = uid();
    get().updateTab(tabId, { running: true, executionId });
    try {
      const result = await api().query.explain({ sessionId: tab.sessionId, sql, database: tab.database });
      if (get().tabs.find((item) => item.id === tabId)?.executionId !== executionId) return;
      const mapped: QueryResult = {
        executionId: uid(),
        statements: [
          {
            kind: 'rows',
            sql: `EXPLAIN ${sql}`,
            columns: result.columns,
            rows: result.rows,
            rowCount: result.rows.length,
            durationMs: 0,
            affectedRows: 0,
          },
        ],
        durationMs: 0,
        serverVersion: get().sessions[tab.sessionId]?.version || '',
        database: tab.database,
        threadId: 0,
      };
      get().updateTab(tabId, { result: mapped, resultIndex: 0 });
      if (result.json) {
        get().toast('info', '执行计划已生成', '下方展示 MySQL 优化器选择的访问路径。');
      }
    } catch (err) {
      get().toast('error', '无法生成执行计划', errorText(err));
    } finally {
      if (get().tabs.find((item) => item.id === tabId)?.executionId === executionId) {
        get().updateTab(tabId, { running: false, executionId: undefined });
      }
    }
  },

  generateAiSql: async (tabId, prompt, providerId) => {
    const tab = get().tabs.find((item) => item.id === tabId);
    if (!tab || tab.kind !== 'query' || tab.running || tab.switchingConnection || tab.aiGenerating || !prompt.trim()) return false;
    const requestId = uid();
    const base = tab.sql.trimEnd();
    const prefix = base ? `${base}\n\n` : '';
    let raw = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = () => get().tabs.find((item) => item.id === tabId)?.aiRequestId === requestId;
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      const sql = streamedSql(raw);
      if (current() && sql) get().updateTab(tabId, { sql: prefix + sql });
    };
    aiFlushes.set(tabId, flush);
    get().updateTab(tabId, { aiGenerating: true, aiRequestId: requestId, aiError: undefined });
    try {
      // A new query can invoke AI before its MySQL session is established.
      if (get().sessions[tab.sessionId]?.status !== 'connected') {
        const connected = await get().connect(tab.sessionId, { focus: false });
        if (!current()) return false;
        if (!connected) throw new Error('请先连接 MySQL，再生成 SQL');
      }
      const result = await api().ai.generate({
        requestId, sessionId: tab.sessionId, database: tab.database, prompt: prompt.trim(), providerId,
      }, (event) => {
        if (!current()) {
          // Handles cancellation that arrived before the backend registered the request.
          if (event.kind === 'started') api().ai.cancel(requestId).catch(() => {});
          return;
        }
        if (event.kind === 'delta') {
          const first = raw.length === 0;
          raw += event.delta;
          if (first) flush();
          else if (!timer) timer = setTimeout(flush, 32);
        }
      });
      if (!current()) return false;
      get().updateTab(tabId, { sql: prefix + result.sql, result: null, error: null });
      return true;
    } catch (error) {
      if (!current()) return false;
      flush();
      get().updateTab(tabId, { aiError: errorText(error) });
      return false;
    } finally {
      if (timer) clearTimeout(timer);
      if (aiFlushes.get(tabId) === flush) aiFlushes.delete(tabId);
      if (current()) get().updateTab(tabId, { aiGenerating: false, aiRequestId: undefined });
    }
  },

  cancelAiSql: async (tabId) => {
    const tab = get().tabs.find((item) => item.id === tabId);
    if (!tab?.aiRequestId) return;
    aiFlushes.get(tabId)?.();
    get().updateTab(tabId, { aiGenerating: false, aiRequestId: undefined });
    await api().ai.cancel(tab.aiRequestId).catch(() => {});
  },

  loadTable: async (tabId, patch = {}) => {
    const tab = get().tabs.find((item) => item.id === tabId);
    if (!tab || !tab.table) return;
    const query = { ...(tab.tableQuery || DEFAULT_TABLE_QUERY), ...patch };
    const seq = (tableLoads.get(tabId) || 0) + 1;
    tableLoads.set(tabId, seq);
    get().updateTab(tabId, { tableQuery: query, tableLoading: true });
    const payload = {
      sessionId: tab.sessionId,
      database: tab.database,
      table: tab.table,
      limit: query.limit,
      offset: query.offset,
      filters: query.filters,
      search: query.search,
      orderBy: query.orderBy,
      orderDir: query.orderDir,
    };
    try {
      const data = await api().data.table(payload);
      if (tableLoads.get(tabId) !== seq) return;
      get().updateTab(tabId, { tableData: data, tableLoading: false, error: null });
      // COUNT(*) runs in parallel with the first paint; slow tables no longer
      // block the grid from showing rows.
      api()
        .data.count(payload)
        .then((total) => {
          if (tableLoads.get(tabId) !== seq) return;
          const current = get().tabs.find((item) => item.id === tabId)?.tableData;
          if (!current) return;
          get().updateTab(tabId, { tableData: { ...current, total } });
        })
        .catch(() => {});
    } catch (err) {
      if (tableLoads.get(tabId) !== seq) return;
      get().updateTab(tabId, { tableLoading: false, error: errorText(err) });
      get().toast('error', '无法读取表数据', errorText(err));
    }
  },

  loadStructure: async (tabId, force = false) => {
    const tab = get().tabs.find((item) => item.id === tabId);
    if (!tab || !tab.table) return;
    if (tab.tableDetails && !force) return;
    get().updateTab(tabId, { structureLoading: true });
    try {
      const details = await api().schema.tableDetails(tab.sessionId, tab.database, tab.table);
      get().updateTab(tabId, { tableDetails: details, structureLoading: false });
    } catch (err) {
      get().updateTab(tabId, { structureLoading: false });
      get().toast('error', '无法读取表结构', errorText(err));
    }
  },

  setTableView: async (tabId, view) => {
    get().updateTab(tabId, { tableView: view });
    if (view === 'structure') await get().loadStructure(tabId);
  },

  updateCell: async (tabId, rowIndex, columnIndex, value) => {
    const tab = get().tabs.find((item) => item.id === tabId);
    if (!tab?.tableData || !tab.table) return false;
    const data = tab.tableData;
    const column = data.columns[columnIndex]?.name;
    if (!column) return false;
    if (!data.primaryKeys.length) {
      get().toast('warning', '这张表没有主键', '为避免误改多行，Finch 只对带主键的表启用行内编辑。');
      return false;
    }
    const keys: Record<string, string | number | null> = {};
    for (const key of data.primaryKeys) {
      const keyIndex = data.columns.findIndex((item) => item.name === key);
      if (keyIndex < 0) return false;
      const value = data.rows[rowIndex][keyIndex];
      if (value && typeof value === 'object') {
        get().toast('warning', '无法编辑二进制主键', '请使用 SQL 编辑器修改这一行。');
        return false;
      }
      keys[key] = value;
    }
    try {
      await api().data.updateCell({
        sessionId: tab.sessionId,
        database: tab.database,
        table: tab.table,
        column,
        value,
        keys,
      });
      const rows = data.rows.map((row) => [...row]);
      rows[rowIndex][columnIndex] = value;
      get().updateTab(tabId, { tableData: { ...data, rows } });
      get().toast('success', '已保存', `${column} 已更新。`);
      return true;
    } catch (err) {
      get().toast('error', '保存失败', errorText(err));
      return false;
    }
  },

  deleteTableRows: async (tabId, rowIndexes) => {
    const tab = get().tabs.find((item) => item.id === tabId);
    if (!tab?.tableData || !tab.table) return false;
    const data = tab.tableData;
    if (!data.primaryKeys.length) {
      get().toast('warning', '这张表没有主键', '无法安全地删除行。');
      return false;
    }
    const keys = rowIndexes.map((rowIndex) => {
      const entry: Record<string, string | number | null> = {};
      for (const key of data.primaryKeys) {
        const index = data.columns.findIndex((item) => item.name === key);
        const value = data.rows[rowIndex][index];
        if (value && typeof value === 'object') throw new Error('Binary primary keys are not supported');
        entry[key] = value;
      }
      return entry;
    });
    try {
      const result = await api().data.deleteRows({
        sessionId: tab.sessionId,
        database: tab.database,
        table: tab.table,
        rows: keys,
      });
      get().toast('success', '已删除', `${result.deleted} 行已从 ${tab.table} 删除。`);
      await get().loadTable(tabId);
      return true;
    } catch (err) {
      get().toast('error', '删除失败', errorText(err));
      return false;
    }
  },

  insertTableRow: async (tabId, values) => {
    const tab = get().tabs.find((item) => item.id === tabId);
    if (!tab || !tab.table) return false;
    try {
      const result = await api().data.insertRow({
        sessionId: tab.sessionId,
        database: tab.database,
        table: tab.table,
        values,
      });
      get().toast('success', '已新增一行', result.insertId ? `主键 ${result.insertId}` : '记录已写入。');
      await get().loadTable(tabId);
      return true;
    } catch (err) {
      get().toast('error', '新增失败', errorText(err));
      return false;
    }
  },

  refreshHistory: async () => {
    try {
      const history = await api().history.list();
      set({ history });
    } catch {}
  },
  clearHistory: async () => {
    await api().history.clear();
    set({ history: [] });
    get().toast('info', '历史已清空', '本机查询历史已删除。');
  },

  requestSaveQuery: (tabId) => {
    const tab = get().tabs.find((item) => item.id === tabId);
    if (!tab) return;
    set({
      saveQueryState: {
        tabId,
        name: tab.title === '查询' ? '' : tab.title,
        sql: tab.sql,
      },
      modal: 'save-query',
    });
  },

  saveQuery: async (tabId, name) => {
    const tab = get().tabs.find((item) => item.id === tabId);
    if (!tab) return;
    const saved = await api().snippets.save({
      id: tab.savedQueryId,
      name: name || tab.title || '未命名查询',
      sql: tab.sql,
      connectionId: tab.sessionId,
      database: tab.database,
    });
    set((state) => ({
      snippets: [saved, ...state.snippets.filter((item) => item.id !== saved.id)],
      tabs: state.tabs.map((item) =>
        item.id === tabId ? { ...item, title: saved.name, savedQueryId: saved.id } : item,
      ),
      modal: null,
      saveQueryState: null,
    }));
    get().toast('success', '查询已保存', saved.name);
  },

  deleteSaved: async (id) => {
    await api().snippets.remove(id);
    set((state) => ({ snippets: state.snippets.filter((item) => item.id !== id) }));
  },

  setSidebarMode: (mode) => {
    set({ sidebarMode: mode, sidebarVisible: true });
    if (mode === 'history') get().refreshHistory().catch(() => {});
  },
  toggleSidebar: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setSyncOpen: (open) => set({ syncOpen: open }),
  setAiOpen: (open) => set({ aiOpen: open }),
  openTableTool: (state) => set({ tableTool: state }),
  closeTableTool: () => set({ tableTool: null }),
  setModal: (modal, connection = null) => set({ modal, editingConnection: connection || null }),
  setSaveQueryState: (state) => set({ saveQueryState: state, modal: state ? 'save-query' : null }),
  askConfirm: (options) => set({ confirmState: options }),
  closeConfirm: () => set({ confirmState: null }),

  toast: (level, title, message) => {
    const toast: Toast = { id: uid(), level, title, message };
    set((state) => ({ toasts: [...state.toasts.slice(-3), toast] }));
    setTimeout(() => get().dismissToast(toast.id), level === 'error' ? 7000 : 4200);
  },
  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) })),

  handleEvent: (event) => {
    if (event.type === 'session:status' && event.id) {
      const id = event.id;
      set((state) => {
        const existing = state.sessions[id];
        if (!existing) return {};
        return {
          sessions: {
            ...state.sessions,
            [id]: {
              ...existing,
              status: event.status || existing.status,
              latency: event.latency ?? existing.latency,
              version: event.version || existing.version,
              lastError: event.error ?? (event.status === 'connected' ? undefined : existing.lastError),
              reconnectAttempts: event.attempt ?? existing.reconnectAttempts,
            },
          },
        };
      });
      if (event.status === 'connected' && event.reconnected) {
        get().refreshSchema(event.id).catch(() => {});
      }
    }
    if (event.type === 'session:ping' && event.id) {
      const id = event.id;
      set((state) => {
        const existing = state.sessions[id];
        if (!existing) return {};
        return {
          sessions: { ...state.sessions, [id]: { ...existing, latency: event.latency ?? existing.latency } },
        };
      });
    }
    if (event.type === 'toast' && event.title) {
      get().toast(event.level || 'info', event.title, event.message);
    }
  },

  ensureDemo: async () => {
    const state = get();
    const existing = state.connections.find((item) => item.name.includes('Demo'));
    let profile = existing;
    if (!profile) {
      profile = await api().connections.save({
        name: 'Acme Commerce · Demo',
        group: 'Local',
        color: '#5B7CFA',
        host: api().env.demoHost,
        port: api().env.demoPort,
        user: api().env.demoUser,
        password: api().env.demoPassword,
        database: api().env.demoDatabase,
        keepAliveSeconds: 20,
        autoReconnect: true,
      });
      set((current) => ({ connections: [...current.connections, profile as ConnectionProfile] }));
    }
    await get().connect(profile.id, { silent: true });
    const database = api().env.demoDatabase;
    await get().loadTables(profile.id, database);
    set((current) => ({ expanded: { ...current.expanded, [`db:${profile!.id}:${database}`]: true } }));
    await get().openTable(profile.id, database, api().env.demoTable);
    await new Promise((resolve) => setTimeout(resolve, 500));
  },
}));
