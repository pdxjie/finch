// Focused IPC/store regression tests; no desktop, database or network calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
let invoke;
function load(relative) {
  const filename = path.join(root, relative);
  const source = fs.readFileSync(filename, 'utf8').replaceAll('import.meta.env', '({})');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const loaded = new Module(filename, module);
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = (id) => {
    if (id === '@tauri-apps/api/core') return { invoke: (...args) => invoke(...args), Channel: class { onmessage() {} } };
    if (id === '@tauri-apps/api/event') return { listen: async () => () => {} };
    if (id === '@tauri-apps/plugin-dialog') return {};
    if (id === '@tauri-apps/plugin-opener') return {};
    if (id.startsWith('.')) {
      const local = path.resolve(path.dirname(filename), `${id}.ts`);
      if (fs.existsSync(local)) return load(path.relative(root, local));
    }
    return originalRequire(id);
  };
  loaded._compile(outputText, filename);
  return loaded.exports;
}

global.localStorage = { getItem: () => null };
global.window = {};
const originalSetTimeout = global.setTimeout;
const originalClearTimeout = global.clearTimeout;
const timers = new Map();
global.setTimeout = (callback, delay) => { const id = {}; timers.set(id, { callback, delay }); return id; };
global.clearTimeout = (id) => timers.delete(id);
const { tauriApi } = load('src/lib/tauriApi.ts');
const { useStore } = load('src/store.ts');
window.finch = tauriApi;
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const payload = { sessionId: 'local', executionId: 'execution', sql: 'SELECT 1', database: 'test', timeoutMs: 60000 };
const result = {
  executionId: 'execution', durationMs: 1, serverVersion: '8.0', database: 'test', threadId: 42,
  statements: [{ kind: 'rows', rows: Array.from({ length: 31 }, (_, n) => [n]), columns: [], rowCount: 31, durationMs: 1 }],
};

async function main() {
  let calls = [];
  let pending = deferred();
  invoke = (command, args) => { calls.push({ command, args }); return pending.promise; };
  const request = tauriApi.query.execute(payload);
  assert.equal(timers.size, 1);
  pending.resolve(result);
  assert.equal(await request, result);
  assert.equal(timers.size, 0, 'completed request must clear its watchdog');
  assert.equal(calls.length, 1);

  calls = [];
  pending = deferred();
  invoke = (command, args) => { calls.push({ command, args }); return command === 'cancel_query' ? Promise.resolve({ cancelled: true }) : pending.promise; };
  const stalled = tauriApi.query.execute(payload);
  const timer = [...timers.values()][0];
  assert.equal(timer.delay, 65000);
  timer.callback();
  await assert.rejects(stalled, /超过时间上限/);
  assert.equal(calls[1].command, 'cancel_query');
  assert.deepEqual(calls[1].args, { executionId: 'execution', sessionId: 'local' });
  assert.equal(timers.size, 0);
  pending.resolve(result); // A late reply must not resurrect the rejected request.

  pending = deferred();
  invoke = () => pending.promise;
  const unlimited = tauriApi.query.execute({ ...payload, timeoutMs: 0 });
  assert.equal(timers.size, 0, 'disabling timeout must remain supported');
  pending.resolve(result);
  await unlimited;

  const resetStore = () => useStore.setState({
    tabs: [{ id: 'tab', kind: 'query', sessionId: 'local', database: 'test', sql: 'SELECT 1', title: 'test' }],
    sessions: { local: { id: 'local', status: 'connected' } }, toasts: [],
  });
  resetStore();
  calls = [];
  pending = deferred();
  invoke = (command, args) => {
    calls.push({ command, args });
    return command === 'execute_query' ? pending.promise : Promise.resolve([]);
  };
  const first = useStore.getState().runQuery('tab');
  await useStore.getState().runQuery('tab');
  assert.equal(calls.filter((call) => call.command === 'execute_query').length, 1, 'repeated Run must not start concurrent copies');
  pending.resolve(result);
  await first;
  assert.equal(useStore.getState().tabs[0].running, false);
  assert.equal(useStore.getState().tabs[0].result.statements[0].rows.length, 31);

  resetStore();
  pending = deferred();
  const stale = useStore.getState().runQuery('tab');
  useStore.getState().updateTab('tab', { executionId: 'new-execution', running: true });
  pending.resolve(result);
  await stale;
  assert.equal(useStore.getState().tabs[0].executionId, 'new-execution');
  assert.equal(useStore.getState().tabs[0].running, true);

  // Switching a query changes only its execution context, preserving its SQL.
  const profiles = [
    { id: 'local', name: 'Local', database: 'test' },
    { id: 'remote', name: 'Remote', database: 'remote_default' },
  ];
  resetStore();
  useStore.setState({ connections: profiles, activeTabId: 'tab', activeConnectionId: 'local',
    sessions: { local: { id: 'local', status: 'connected' }, remote: { id: 'remote', status: 'connected' } } });
  let databases = [{ name: 'remote_default' }, { name: 'other' }];
  calls = [];
  invoke = (command, args) => {
    calls.push({ command, args });
    return Promise.resolve(command === 'list_databases' ? databases : command === 'execute_query' ? result : []);
  };
  useStore.getState().updateTab('tab', { result, lastRunMs: 123 });
  await useStore.getState().switchQueryConnection('tab', 'remote');
  let tab = useStore.getState().tabs[0];
  assert.equal(tab.sessionId, 'remote');
  assert.equal(tab.database, 'remote_default');
  assert.equal(tab.sql, 'SELECT 1');
  assert.equal(tab.result, null, 'old connection results must be cleared');
  assert.equal(tab.lastRunMs, undefined);
  assert.equal(useStore.getState().activeConnectionId, 'remote');
  await useStore.getState().runQuery('tab');
  const execution = calls.find((call) => call.command === 'execute_query');
  assert.equal(execution.args.payload.sessionId, 'remote');
  assert.equal(execution.args.payload.database, 'remote_default');

  // Preserve a database only when it is also present on the destination.
  databases = [{ name: 'remote_default' }, { name: 'test' }];
  useStore.getState().updateTab('tab', { sessionId: 'local', database: 'test', running: false });
  await useStore.getState().switchQueryConnection('tab', 'remote');
  assert.equal(useStore.getState().tabs[0].database, 'test');

  useStore.getState().updateTab('tab', { running: true });
  await useStore.getState().switchQueryConnection('tab', 'local');
  assert.equal(useStore.getState().tabs[0].sessionId, 'remote', 'running query cannot switch');
  useStore.getState().updateTab('tab', { running: false });
  const switchPending = deferred();
  calls = [];
  invoke = (command, args) => { calls.push({ command, args }); return switchPending.promise; };
  const switching = useStore.getState().switchQueryConnection('tab', 'local');
  await Promise.resolve();
  assert.equal(useStore.getState().tabs[0].switchingConnection, true);
  await useStore.getState().runQuery('tab');
  await useStore.getState().switchQueryConnection('tab', 'remote');
  assert.equal(calls.filter((call) => call.command === 'execute_query').length, 0);
  switchPending.resolve([{ name: 'test' }]);
  await switching;
  assert.equal(useStore.getState().tabs[0].sessionId, 'local');
  assert.equal(useStore.getState().tabs[0].switchingConnection, false);

  // A failed destination connection leaves the original query usable.
  useStore.setState({ sessions: { local: { id: 'local', status: 'connected' } }, pendingConnections: {} });
  invoke = () => Promise.reject(new Error('destination unavailable'));
  await useStore.getState().switchQueryConnection('tab', 'remote');
  assert.equal(useStore.getState().tabs[0].sessionId, 'local');
  assert.equal(useStore.getState().tabs[0].database, 'test');
  assert.equal(useStore.getState().tabs[0].sql, 'SELECT 1');
  assert.equal(useStore.getState().tabs[0].switchingConnection, false);

  useStore.setState({ sessions: { local: { id: 'local', status: 'connected' }, remote: { id: 'remote', status: 'connected' } } });
  invoke = () => Promise.reject(new Error('database list unavailable'));
  await useStore.getState().switchQueryConnection('tab', 'remote');
  assert.equal(useStore.getState().tabs[0].sessionId, 'local', 'schema failure must retain the old execution context');

  calls = [];
  useStore.setState({ sessions: { local: { id: 'local', status: 'connected' } }, pendingConnections: {} });
  invoke = (command, args) => {
    calls.push({ command, args });
    return Promise.resolve(command === 'connect' ? { id: 'remote', status: 'connected' }
      : command === 'list_databases' ? [{ name: 'remote_default' }] : []);
  };
  await useStore.getState().switchQueryConnection('tab', 'remote');
  assert.equal(useStore.getState().tabs[0].sessionId, 'remote');
  assert.equal(calls.filter((call) => call.command === 'connect').length, 1, 'disconnected destination is connected automatically');

  // Cancel while establishing a connection must not execute SQL after the handshake finishes.
  resetStore();
  useStore.setState({ sessions: {}, pendingConnections: {}, connections: profiles });
  calls = [];
  const connecting = deferred();
  invoke = (command, args) => {
    calls.push({ command, args });
    return command === 'connect' ? connecting.promise
      : Promise.resolve(command === 'list_databases' ? [{ name: 'test' }] : []);
  };
  const preparing = useStore.getState().runQuery('tab');
  assert.equal(useStore.getState().tabs[0].running, true);
  await useStore.getState().switchQueryConnection('tab', 'remote');
  assert.equal(useStore.getState().tabs[0].sessionId, 'local');
  await useStore.getState().cancelQuery('tab');
  connecting.resolve({ id: 'local', status: 'connected' });
  await preparing;
  assert.equal(calls.filter((call) => call.command === 'execute_query').length, 0);
  assert.equal(useStore.getState().tabs[0].running, false);

  useStore.setState({ sessions: { local: { id: 'local', status: 'error', lastError: 'lost connection' } } });
  useStore.getState().handleEvent({ type: 'session:status', id: 'local', status: 'connected', error: '' });
  assert.equal(useStore.getState().sessions.local.lastError, '');
  console.log('PASS: query IPC/watchdog/cancel regression; switch context, target execution, valid database, busy guards, failure rollback, disconnected destination, handshake cancellation and recovered status');
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  global.setTimeout = originalSetTimeout;
  global.clearTimeout = originalClearTimeout;
});
