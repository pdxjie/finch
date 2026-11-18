export type ThemeMode = 'light' | 'dark' | 'system';

export interface ConnectionProfile {
  id: string;
  name: string;
  group: string;
  category: 'local' | 'dev' | 'staging' | 'prod';
  color: string;
  host: string;
  port: number;
  user: string;
  database: string;
  sslMode: 'disabled' | 'required' | 'verify';
  sslCaPath: string;
  sslCertPath: string;
  sslKeyPath: string;
  sshEnabled: boolean;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshAuth: 'password' | 'key';
  sshKeyPath: string;
  keepAliveSeconds: number;
  autoReconnect: boolean;
  connectTimeout: number;
  readOnly: boolean;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt?: string;
  hasPassword?: boolean;
  hasSshPassword?: boolean;
  hasSshPassphrase?: boolean;
  hasSslKeyPassphrase?: boolean;
  password?: string;
  sshPassword?: string;
  sshPassphrase?: string;
  sslKeyPassphrase?: string;
}

export interface SessionInfo {
  id: string;
  status: 'connecting' | 'connected' | 'reconnecting' | 'error' | 'offline';
  version: string;
  server?: Record<string, string | number>;
  latency: number | null;
  connectedAt: number;
  reconnectAttempts?: number;
  lastError?: string | null;
}

export interface DatabaseInfo {
  name: string;
  charset: string;
  collation: string;
  isSystem: boolean;
}

export interface TableInfo {
  name: string;
  tableType: string;
  engine: string | null;
  rowEstimate: number | null;
  comment: string;
  dataLength: number;
  indexLength: number;
  collation: string | null;
  createTime: string | null;
}

export interface ColumnInfo {
  name: string;
  columnType: string;
  dataType: string;
  nullable: 'YES' | 'NO';
  defaultValue: string | null;
  extra: string;
  columnKey: string;
  comment: string;
  position: number;
  charset: string | null;
  collation: string | null;
  generationExpression: string;
}

export interface IndexInfo {
  name: string;
  column: string;
  unique: boolean;
  sequence: number;
  cardinality: number | null;
  type: string;
  nullable: boolean;
  comment: string;
}

export interface ForeignKeyInfo {
  name: string;
  columnName: string;
  refDatabase: string;
  refTable: string;
  refColumn: string;
  onUpdate: string;
  onDelete: string;
}

export interface TableDetails {
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  triggers: { name: string; event: string; timing: string; statement: string }[];
  ddl: string;
  primaryKeys: string[];
}

export interface ResultColumn {
  name: string;
  orgName: string;
  table: string;
  database: string;
  type: string;
  length: number;
  flags: number;
  decimals: number;
}

export interface QueryError {
  message: string;
  code: string;
  errno: number;
  sqlState: string;
  sql: string;
}

export interface BlobValue {
  __finchType: 'blob';
  size: number;
  preview: string;
}

export type CellValue = string | number | null | BlobValue;

export interface StatementResult {
  kind: 'rows' | 'command' | 'error';
  sql: string;
  columns: ResultColumn[];
  rows: CellValue[][];
  rowCount: number;
  truncated?: boolean;
  truncatedReason?: 'rows' | 'bytes' | null;
  durationMs: number;
  affectedRows?: number;
  insertId?: string | null;
  changedRows?: number;
  info?: string;
  warnings?: number;
  error?: QueryError;
}

export interface QueryResult {
  executionId: string;
  statements: StatementResult[];
  durationMs: number;
  cancelled?: boolean;
  serverVersion: string;
  database: string;
  threadId: number;
  timings?: {
    connectionMs: number;
    prepareMs: number;
    executionMs: number;
  };
}

export interface TableData {
  columns: ResultColumn[];
  rows: CellValue[][];
  total: number | null;
  limit: number;
  offset: number;
  primaryKeys: string[];
  columnMeta: ColumnInfo[];
  orderBy: string | null;
  orderDir: 'asc' | 'desc';
}

export interface TableFilter {
  column: string;
  op: string;
  value: string;
  value2?: string;
}

export interface TableQuery {
  limit: number;
  offset: number;
  filters: TableFilter[];
  search: string;
  orderBy: string | null;
  orderDir: 'asc' | 'desc';
}

export type TabKind = 'query' | 'table' | 'dashboard' | 'database';
export type ResultView = 'data' | 'structure';

export interface WorkspaceTab {
  id: string;
  kind: TabKind;
  title: string;
  sessionId: string;
  database: string;
  table?: string;
  sql: string;
  savedQueryId?: string;
  createdAt: number;
  running?: boolean;
  switchingConnection?: boolean;
  preparingQuery?: boolean;
  aiGenerating?: boolean;
  aiRequestId?: string;
  aiError?: string;
  executionId?: string;
  result?: QueryResult | null;
  resultIndex?: number;
  error?: string | null;
  tableData?: TableData | null;
  tableDetails?: TableDetails | null;
  tableQuery?: TableQuery;
  tableView?: ResultView;
  tableLoading?: boolean;
  structureLoading?: boolean;
  lastRunMs?: number;
  /** Database browser view state, kept on the tab so it survives tab switches. */
  dbKind?: 'table' | 'view';
  dbFilter?: string;
  dbSort?: 'name' | 'rows' | 'size';
  dbSelected?: string | null;
  dbChecked?: string[];
}

export interface HistoryItem {
  id: string;
  connectionId: string;
  connectionName: string;
  database: string;
  sql: string;
  durationMs: number;
  statementCount: number;
  rowCount: number;
  success: boolean;
  error: string;
  createdAt: string;
}

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  connectionId: string | null;
  database: string;
  createdAt: string;
  updatedAt: string;
}

export type AiProtocol = 'chat' | 'responses' | 'anthropic';

export interface AiProvider {
  id: string;
  name: string;
  kind: 'openai' | 'anthropic' | 'deepseek' | 'custom';
  protocol: AiProtocol;
  baseUrl: string;
  model: string;
  hasKey: boolean;
}

export interface AiGenerateResult {
  sql: string;
  raw: string;
  provider: string;
  model: string;
}

export type AiStreamEvent = { kind: 'started' } | { kind: 'delta'; delta: string };

export interface SyncTableOption {
  name: string;
  rows: number | null;
  bytes: number;
  exists: boolean;
}

export interface SyncPreview {
  tables: SyncTableOption[];
  targetCategory: string;
  targetName: string;
}

export interface SyncTableRequest {
  name: string;
  mode: 'upsert' | 'append' | 'replace';
  columns: string[];
}

export interface SyncRequest {
  sourceId: string;
  targetId: string;
  sourceDatabase: string;
  targetDatabase: string;
  tables: SyncTableRequest[];
  createMissing: boolean;
  batchSize: number;
  concurrency: number;
}

export interface SyncTableResult {
  table: string;
  created: boolean;
  read: number;
  written: number;
  skippedColumns: string[];
  error: string | null;
  shards?: number;
}

export interface SyncResult {
  tables: SyncTableResult[];
  createdTables: string[];
  durationMs: number;
}

export interface DdlColumn {
  name: string;
  columnType: string;
  nullable: boolean;
  defaultValue: string | null;
  autoIncrement: boolean;
  primary: boolean;
  comment: string;
  after?: string | null;
}

export interface DdlIndex {
  name: string;
  columns: string[];
  unique: boolean;
  indexType: string;
}

export interface CreateTableRequest {
  sessionId: string;
  database: string;
  table: string;
  columns: DdlColumn[];
  engine: string;
  charset: string;
  indexes: DdlIndex[];
}

export interface AlterTableRequest {
  prodConfirmed?: boolean;
  sessionId: string;
  database: string;
  table: string;
  add: DdlColumn[];
  modify: DdlColumn[];
  dropColumns: string[];
  renameTo: string | null;
  addIndexes: DdlIndex[];
  modifyIndexes: DdlIndex[];
  dropIndexes: string[];
}

export interface DumpRequest {
  sessionId: string;
  database: string;
  path: string;
  structure: boolean;
  data: boolean;
  tables: string[];
  splitFiles?: boolean;
}

export interface SyncProgress {
  type: string;
  table: string;
  index: number;
  total: number;
  read: number;
  written: number;
  created?: boolean;
  error?: string;
  shards?: number;
}

export interface AppSettings {
  theme: ThemeMode;
  showSystemSchemas: boolean;
  maxRows: number;
  confirmDestructive: boolean;
  autoLimitSelects: boolean;
  queryTimeoutSeconds: number;
  editorFontSize: number;
  uiFont: string;
  monoFont: string;
  uiFontSize: number;
  accentColor: string;
  motion: 'full' | 'reduced' | 'off';
  gridDensity: 'compact' | 'comfortable';
  zoomFactor: number;
  lastConnectionId: string | null;
}

export interface AppInfo {
  version: string;
  name: string;
  platform: string;
  arch: string;
  electron: string;
  chrome: string;
  node: string;
  dataDir: string;
  devView?: string;
  devTable?: string;
}

export type ToastLevel = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: string;
  level: ToastLevel;
  title: string;
  message?: string;
}

export interface ServerOverview {
  version: string;
  variables: Record<string, string>;
  status: {
    uptime: number;
    threadsConnected: number;
    threadsRunning: number;
    queries: number;
    slowQueries: number;
    bytesReceived: number;
    bytesSent: number;
    abortedConnects: number;
    maxUsedConnections: number;
    qpsAvg: number;
    questions: number;
    innodbBufferPoolSize: number;
  };
  databaseStats: { schemaCount: number; rowEstimate: number; bytes: number };
  topTables: { db: string; name: string; bytes: number; rowsEstimate: number }[];
  processes: ProcessInfo[];
  replication: Record<string, string> | null;
  sampledAt: number;
}

export interface ProcessInfo {
  id: number;
  user: string;
  host: string;
  db: string | null;
  command: string;
  time: number;
  state: string | null;
  info: string;
}

export interface FinchyAPI {
  platform: string;
  env: {
    demo: boolean;
    capture: boolean;
    demoHost: string;
    demoPort: number;
    demoUser: string;
    demoPassword: string;
    demoDatabase: string;
    demoTable: string;
  };
  connections: {
    list: () => Promise<ConnectionProfile[]>;
    save: (input: Partial<ConnectionProfile>) => Promise<ConnectionProfile>;
    remove: (id: string) => Promise<boolean>;
    test: (input: Partial<ConnectionProfile>) => Promise<{
      latency: number;
      version: string;
      charset: string;
      threadId: number;
      host: string;
      port: number;
    }>;
    connect: (id: string) => Promise<SessionInfo>;
    disconnect: (id: string) => Promise<boolean>;
    ping: (id: string) => Promise<SessionInfo>;
  };
  schema: {
    databases: (sessionId: string) => Promise<DatabaseInfo[]>;
    tables: (sessionId: string, database: string, kind?: 'table' | 'view') => Promise<TableInfo[]>;
    columns: (sessionId: string, database: string, table: string) => Promise<ColumnInfo[]>;
    tableDetails: (sessionId: string, database: string, table: string) => Promise<TableDetails>;
    routines: (sessionId: string, database: string) => Promise<{ name: string; type: string; returnType: string; comment: string }[]>;
    allColumns: (sessionId: string, database: string) => Promise<Record<string, ColumnInfo[]>>;
    refresh: (sessionId: string) => Promise<boolean>;
  };
  query: {
    execute: (payload: {
      sessionId: string;
      sql: string;
      database: string;
      executionId: string;
      maxRows?: number;
      autoLimit?: boolean;
      timeoutMs?: number;
      prodConfirmed?: boolean;
    }) => Promise<QueryResult>;
    cancel: (executionId: string, sessionId: string) => Promise<{ cancelled: boolean }>;
    explain: (payload: { sessionId: string; sql: string; database: string }) => Promise<{
      columns: ResultColumn[];
      rows: CellValue[][];
      json: string | null;
    }>;
  };
  data: {
    table: (payload: {
      sessionId: string;
      database: string;
      table: string;
      limit: number;
      offset: number;
      filters: TableFilter[];
      search: string;
      orderBy: string | null;
      orderDir: 'asc' | 'desc';
    }) => Promise<TableData>;
    count: (payload: {
      sessionId: string;
      database: string;
      table: string;
      limit: number;
      offset: number;
      filters: TableFilter[];
      search: string;
      orderBy: string | null;
      orderDir: 'asc' | 'desc';
    }) => Promise<number | null>;
    updateCell: (payload: {
      sessionId: string;
      database: string;
      table: string;
      column: string;
      value: CellValue;
      keys: Record<string, CellValue>;
      prodConfirmed?: boolean;
    }) => Promise<{ affectedRows: number }>;
    deleteRows: (payload: {
      sessionId: string;
      database: string;
      table: string;
      rows: Record<string, CellValue>[];
      prodConfirmed?: boolean;
    }) => Promise<{ deleted: number }>;
    updateCells: (payload: {
      sessionId: string;
      database: string;
      table: string;
      column: string;
      value: CellValue;
      rows: Record<string, CellValue>[];
      prodConfirmed?: boolean;
    }) => Promise<{ affectedRows: number }>;
    insertRow: (payload: {
      sessionId: string;
      database: string;
      table: string;
      values: Record<string, CellValue>;
      prodConfirmed?: boolean;
    }) => Promise<{ insertId: string | null; affectedRows: number }>;
  };
  ai: {
    listProviders: () => Promise<AiProvider[]>;
    saveProvider: (input: { provider: Partial<AiProvider>; apiKey?: string }) => Promise<AiProvider>;
    deleteProvider: (id: string) => Promise<boolean>;
    generate: (input: {
      requestId: string;
      sessionId: string;
      database: string;
      prompt: string;
      providerId: string;
    }, onEvent?: (event: AiStreamEvent) => void) => Promise<AiGenerateResult>;
    cancel: (requestId: string) => Promise<boolean>;
  };
  sync: {
    preview: (payload: {
      sourceId: string;
      targetId: string;
      sourceDatabase: string;
      targetDatabase: string;
    }) => Promise<SyncPreview>;
    run: (request: SyncRequest) => Promise<SyncResult>;
  };
  ddl: {
    createTable: (request: CreateTableRequest) => Promise<string>;
    alterTable: (request: AlterTableRequest) => Promise<string>;
    dropTable: (payload: { sessionId: string; database: string; table: string; prodConfirmed?: boolean }) => Promise<string>;
  };
  lan: {
    status: () => Promise<LanStatus>;
    start: () => Promise<LanStatus>;
    stop: () => Promise<boolean>;
    setDeviceName: (name: string) => Promise<boolean>;
    connect: (peerId: string, connectionId: string, database: string) => Promise<LanSessionInfo>;
    respond: (input: {
      requestId: string;
      accept: boolean;
      connectionId: string;
      database: string;
      downloadDir: string;
    }) => Promise<boolean>;
    sendFile: (sessionId: string, path: string) => Promise<boolean>;
    sendTables: (sessionId: string, tables: string[], structure: boolean, data: boolean) => Promise<boolean>;
    disconnect: (sessionId: string) => Promise<boolean>;
  };
  dump: (request: DumpRequest) => Promise<{ saved: boolean; path: string; tables: number; files?: string[]; split?: boolean }>;
  server: {
    overview: (sessionId: string) => Promise<ServerOverview>;
    processes: (sessionId: string) => Promise<ProcessInfo[]>;
    kill: (payload: { sessionId: string; threadId: number }) => Promise<{ killed: boolean }>;
    variables: (sessionId: string) => Promise<{ Variable_name: string; Value: string }[]>;
  };
  history: {
    list: () => Promise<HistoryItem[]>;
    clear: () => Promise<boolean>;
    remove: (id: string) => Promise<boolean>;
  };
  snippets: {
    list: () => Promise<SavedQuery[]>;
    save: (input: Partial<SavedQuery>) => Promise<SavedQuery>;
    remove: (id: string) => Promise<boolean>;
  };
  exportData: (payload: {
    format: 'csv' | 'json' | 'sql';
    columns: ResultColumn[];
    rows: CellValue[][];
    filename?: string;
    table?: string;
  }) => Promise<{ saved: boolean; filePath?: string }>;
  app: {
    info: () => Promise<AppInfo>;
    saveFile: (payload: { title?: string; filename?: string; defaultPath?: string; content: string; filters?: { name: string; extensions: string[] }[] }) => Promise<{ saved: boolean; filePath?: string }>;
    openFile: (payload?: { title?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<{ opened: boolean; filePath?: string; content?: string }>;
    pickFile: (payload?: { title?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<{ picked: boolean; filePath?: string }>;
    showItem: (filePath: string) => Promise<boolean>;
    openExternal: (url: string) => Promise<boolean>;
    getSettings: () => Promise<AppSettings>;
    setSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
    setTheme: (theme: ThemeMode) => Promise<boolean>;
    setTitle: (title: string) => Promise<boolean>;
    setZoom: (scale: number) => Promise<boolean>;
    ready: () => Promise<boolean>;
  };
  onEvent: (callback: (event: FinchyEvent) => void) => () => void;
  onMenu: (callback: (event: { action: string }) => void) => () => void;
}

export interface FinchyEvent {
  type: string;
  id?: string;
  status?: SessionInfo['status'];
  latency?: number;
  version?: string;
  error?: string;
  level?: ToastLevel;
  title?: string;
  message?: string;
  reconnected?: boolean;
  attempt?: number;
}

declare global {
  interface Window {
    finch: FinchyAPI;
  }
}

export interface LanPeer {
  id: string;
  name: string;
  address: string;
  port: number;
}

export interface LanSessionInfo {
  id: string;
  peerName: string;
  peerConnection: string;
  peerDatabase: string;
  myConnectionId: string;
  myDatabase: string;
  downloadDir: string;
}

export interface LanStatus {
  enabled: boolean;
  deviceName: string;
  deviceId: string;
  port: number;
  peers: LanPeer[];
  sessions: LanSessionInfo[];
}

export interface LanRequest {
  id: string;
  peerName: string;
  connectionName: string;
  database: string;
}

export interface LanProgress {
  sessionId: string;
  kind: string;
  name: string;
  done: number;
  total: number;
}
