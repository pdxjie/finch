import { Channel, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import type {
  AppInfo,
  AppSettings,
  CellValue,
  ColumnInfo,
  ConnectionProfile,
  DatabaseInfo,
  FinchyAPI,
  HistoryItem,
  IndexInfo,
  ProcessInfo,
  QueryResult,
  ResultColumn,
  SavedQuery,
  ServerOverview,
  SessionInfo,
  TableData,
  TableDetails,
  TableFilter,
  TableInfo,
  AiProvider,
  AiGenerateResult,
  AiStreamEvent,
  SyncPreview,
  SyncRequest,
  SyncResult,
  CreateTableRequest,
  AlterTableRequest,
  DumpRequest,
  ThemeMode,
  ToastLevel,
} from '../types';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function invokeSafe<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args);
}

function backendError(error: unknown): Error {
  if (typeof error === 'string') return new Error(error);
  if (error instanceof Error) return error;
  return new Error(String(error));
}

function wrap<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((error) => {
    throw backendError(error);
  });
}

async function executeQuery(payload: Parameters<FinchyAPI['query']['execute']>[0]): Promise<QueryResult> {
  const request = wrap(invokeSafe<QueryResult>('execute_query', { payload }));
  // The Rust deadline is authoritative. This watchdog also settles the UI if
  // native IPC fails to deliver a reply (e.g. a task panic or broken webview).
  if (!payload.timeoutMs || payload.timeoutMs <= 0) return request;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      invokeSafe('cancel_query', { executionId: payload.executionId, sessionId: payload.sessionId }).catch(() => {});
      reject(new Error('查询响应超过时间上限，已请求取消。请核对数据库状态后再重试。'));
    }, Math.max(10000, payload.timeoutMs! + 5000));
  });
  try {
    return await Promise.race([request, watchdog]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function csvEscape(value: CellValue): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildExportContent(
  format: 'csv' | 'json' | 'sql',
  columns: ResultColumn[],
  rows: CellValue[][],
  tableName: string,
): string {
  if (format === 'json') {
    return JSON.stringify(
      rows.map((row) => Object.fromEntries(columns.map((column, index) => [column.name, row[index]]))),
      null,
      2,
    );
  }
  if (format === 'sql') {
    const names = columns.map((column) => `\`${column.name.replace(/`/g, '``')}\``).join(', ');
    const literal = (value: CellValue): string => {
      if (value === null) return 'NULL';
      if (typeof value === 'number') return String(value);
      if (typeof value === 'object') return `'${JSON.stringify(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
      return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
    };
    return rows
      .map(
        (row) =>
          `INSERT INTO \`${tableName.replace(/`/g, '``')}\` (${names}) VALUES (${row.map(literal).join(', ')});`,
      )
      .join('\n');
  }
  const header = columns.map((column) => csvEscape(column.name)).join(',');
  const body = rows.map((row) => row.map(csvEscape).join(',')).join('\n');
  return `\uFEFF${header}\n${body}`;
}

function createApi(): FinchyAPI {
  return {
    platform: 'macos',
    env: {
      demo: import.meta.env.VITE_FINCH_DEMO === '1' || Boolean(localStorage.getItem('finch.dev.demo')),
      capture: false,
      demoHost: '127.0.0.1',
      demoPort: 3407,
      demoUser: 'root',
      demoPassword: '',
      demoDatabase: 'finch_demo',
      demoTable: 'orders',
    },
    connections: {
      list: () => wrap(invokeSafe<ConnectionProfile[]>('list_connections')),
      save: (input) => wrap(invokeSafe<ConnectionProfile>('save_connection', { input })),
      remove: (id) => wrap(invokeSafe<boolean>('delete_connection', { id })),
      test: (input) =>
        wrap(
          invokeSafe<{
            latency: number;
            version: string;
            charset: string;
            threadId: number;
            host: string;
            port: number;
          }>('test_connection', { input }),
        ),
      connect: (id) => wrap(invokeSafe<SessionInfo>('connect', { id })),
      disconnect: (id) => wrap(invokeSafe<boolean>('disconnect', { id })),
      ping: (id) => wrap(invokeSafe<SessionInfo>('ping', { id })),
    },
    schema: {
      databases: (sessionId) => wrap(invokeSafe<DatabaseInfo[]>('list_databases', { sessionId })),
      tables: (sessionId, database, kind) =>
        wrap(invokeSafe<TableInfo[]>('list_tables', { sessionId, database, kind })),
      columns: (sessionId, database, table) =>
        wrap(invokeSafe<TableDetails['columns']>('list_columns', { sessionId, database, table })),
      tableDetails: (sessionId, database, table) =>
        wrap(invokeSafe<TableDetails>('get_table_details', { sessionId, database, table })),
      routines: (sessionId, database) =>
        wrap(invokeSafe<Awaited<ReturnType<FinchyAPI['schema']['routines']>>>('list_routines', { sessionId, database })),
      allColumns: (sessionId, database) =>
        wrap(invokeSafe<Record<string, ColumnInfo[]>>('list_all_columns', { sessionId, database })),
      refresh: () => Promise.resolve(true),
    },
    query: {
      execute: executeQuery,
      cancel: (executionId, sessionId) =>
        wrap(invokeSafe<{ cancelled: boolean }>('cancel_query', { executionId, sessionId })),
      explain: (payload) => wrap(invokeSafe<Awaited<ReturnType<FinchyAPI['query']['explain']>>>('explain_query', { payload })),
    },
    data: {
      table: (payload) => wrap(invokeSafe<TableData>('get_table_data', { payload })),
      count: (payload) => wrap(invokeSafe<number | null>('count_table_rows', { payload })),
      updateCell: (payload) =>
        wrap(invokeSafe<{ affectedRows: number }>('update_cell', { payload })),
      deleteRows: (payload) =>
        wrap(invokeSafe<{ deleted: number }>('delete_rows', { payload })),
      insertRow: (payload) =>
        wrap(invokeSafe<{ insertId: string | null; affectedRows: number }>('insert_row', { payload })),
    },
    ai: {
      listProviders: () => wrap(invokeSafe<AiProvider[]>('list_ai_providers')),
      saveProvider: (input) => wrap(invokeSafe<AiProvider>('save_ai_provider', { input })),
      deleteProvider: (id) => wrap(invokeSafe<boolean>('delete_ai_provider', { id })),
      generate: (input, onEvent) => {
        const channel = new Channel<AiStreamEvent>();
        channel.onmessage = onEvent || (() => {});
        return wrap(invokeSafe<AiGenerateResult>('generate_sql', { input, onEvent: channel }));
      },
      cancel: (requestId) => wrap(invokeSafe<boolean>('cancel_ai', { requestId })),
    },
    sync: {
      preview: (payload) => wrap(invokeSafe<SyncPreview>('sync_preview', payload)),
      run: (request) => wrap(invokeSafe<SyncResult>('run_sync', { request })),
    },
    ddl: {
      createTable: (request) => wrap(invokeSafe<string>('create_table', { request })),
      alterTable: (request) => wrap(invokeSafe<string>('alter_table', { request })),
      dropTable: (payload) => wrap(invokeSafe<string>('drop_table', payload)),
    },
    dump: (request) => wrap(invokeSafe<Awaited<ReturnType<FinchyAPI['dump']>>>('dump_database', { request })),
    server: {
      overview: (sessionId) => wrap(invokeSafe<ServerOverview>('server_overview', { sessionId })),
      processes: (sessionId) => wrap(invokeSafe<ProcessInfo[]>('server_processes', { sessionId })),
      kill: (payload) => wrap(invokeSafe<{ killed: boolean }>('kill_process', { payload })),
      variables: (sessionId) =>
        wrap(invokeSafe<{ Variable_name: string; Value: string }[]>('server_variables', { sessionId })),
    },
    history: {
      list: () => wrap(invokeSafe<HistoryItem[]>('list_history')),
      clear: () => wrap(invokeSafe<boolean>('clear_history')),
      remove: (id) => wrap(invokeSafe<boolean>('delete_history', { id })),
    },
    snippets: {
      list: () => wrap(invokeSafe<SavedQuery[]>('list_snippets')),
      save: (input) => wrap(invokeSafe<SavedQuery>('save_snippet', { input })),
      remove: (id) => wrap(invokeSafe<boolean>('delete_snippet', { id })),
    },
    exportData: async (payload) => {
      const ext = payload.format === 'json' ? 'json' : payload.format === 'sql' ? 'sql' : 'csv';
      const target = await saveDialog({
        title: '导出查询结果',
        defaultPath: `${payload.filename || 'finch-export'}.${ext}`,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      });
      if (!target) return { saved: false };
      const content = buildExportContent(payload.format, payload.columns, payload.rows, payload.table || 'exported_rows');
      await invokeSafe('write_text_file', { path: target, content });
      return { saved: true, filePath: target };
    },
    app: {
      info: () => wrap(invokeSafe<AppInfo>('app_info')),
      saveFile: async (payload) => {
        const target = await saveDialog({
          title: payload.title || '保存文件',
          defaultPath: payload.defaultPath || payload.filename || 'finch.sql',
          filters: payload.filters,
        });
        if (!target) return { saved: false };
        await invokeSafe('write_text_file', { path: target, content: payload.content });
        return { saved: true, filePath: target };
      },
      openFile: async (payload) => {
        const target = await openDialog({
          title: payload?.title || '打开文件',
          multiple: false,
          directory: false,
          filters: payload?.filters,
        });
        if (!target || Array.isArray(target)) return { opened: false };
        const content = await invokeSafe<string>('read_text_file', { path: target });
        return { opened: true, filePath: target, content };
      },
      openExternal: async (url) => {
        await openUrl(url);
        return true;
      },
      showItem: async (filePath) => {
        await invokeSafe('reveal_path', { path: filePath });
        return true;
      },
      pickFile: async (payload) => {
        const target = await openDialog({
          title: payload?.title || '选择文件',
          multiple: false,
          directory: false,
          filters: payload?.filters,
        });
        if (!target || Array.isArray(target)) return { picked: false };
        return { picked: true, filePath: target };
      },
      getSettings: () => wrap(invokeSafe<AppSettings>('get_settings')),
      setSettings: (patch) => wrap(invokeSafe<AppSettings>('set_settings', { patch })),
      setTheme: (theme: ThemeMode) => wrap(invokeSafe<boolean>('set_theme', { theme })),
      setTitle: (title) => wrap(invokeSafe<boolean>('set_title', { title })),
      setZoom: (scale) => wrap(invokeSafe<boolean>('set_webview_zoom', { scale })),
      ready: () => Promise.resolve(true),
    },
    onEvent: (callback) => {
      if (!isTauri) return () => {};
      let unlisten: (() => void) | undefined;
      listen<Record<string, unknown>>('finch://event', (event) => {
        callback(event.payload as never);
      }).then((fn) => {
        unlisten = fn;
      });
      return () => unlisten?.();
    },
    onMenu: () => () => {},
  };
}

export const tauriApi = createApi();

export function installFinchApi() {
  (window as unknown as { finch: FinchyAPI }).finch = tauriApi;
}

export { isTauri };
