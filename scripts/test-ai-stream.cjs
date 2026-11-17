// Exercises real API/channel and store code without network, database or desktop access.
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
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.CommonJS } });
  const mod = new Module(filename, module);
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod);
  mod.require = (id) => {
    if (id === '@tauri-apps/api/core') return { invoke:(...args) => invoke(...args), Channel:class { onmessage() {} } };
    if (id === '@tauri-apps/api/event') return { listen:async () => () => {} };
    if (id === '@tauri-apps/plugin-dialog' || id === '@tauri-apps/plugin-opener') return {};
    if (id.startsWith('.')) {
      const local = path.resolve(path.dirname(filename), `${id}.ts`);
      if (fs.existsSync(local)) return load(path.relative(root, local));
    }
    return original(id);
  };
  mod._compile(outputText, filename);
  return mod.exports;
}
global.localStorage = { getItem:() => null };
global.window = {};
const oldSet = global.setTimeout, oldClear = global.clearTimeout;
const timers = new Map();
global.setTimeout = (callback, delay) => { const id = {}; timers.set(id, { callback, delay }); return id; };
global.clearTimeout = (id) => timers.delete(id);
const flush = () => { for (const timer of [...timers.values()]) if (timer.delay === 32) timer.callback(); };
const { tauriApi } = load('src/lib/tauriApi.ts');
const { useStore } = load('src/store.ts');
const { streamedSql } = load('src/lib/aiStreaming.ts');
window.finch = tauriApi;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
let calls = [], channels = new Map(), requests = new Map();
const reset = () => {
  timers.clear(); calls = []; channels = new Map(); requests = new Map();
  useStore.setState({ tabs:[{ id:'a', kind:'query', sessionId:'local', database:'demo', sql:'SELECT original;', title:'A' }],
    activeTabId:'a', sessions:{ local:{ id:'local', status:'connected' } },
    connections:[{ id:'local' }, { id:'other' }], toasts:[] });
  invoke = (command, args) => {
    calls.push({ command, args });
    if (command === 'generate_sql') {
      const request = deferred(); channels.set(args.input.requestId, args.onEvent); requests.set(args.input.requestId, request);
      return request.promise;
    }
    return Promise.resolve(true);
  };
};
const send = (id, delta) => channels.get(id).onmessage({ kind:'delta', delta });
const result = { sql:'SELECT 31;', raw:'SELECT 31;', provider:'mock', model:'test' };

async function main() {
  for (const fragment of ['`', '``', '```sql']) assert.equal(streamedSql(fragment), '');
  assert.equal(streamedSql('```sql\nSELECT `id` FROM `t`\n``'), 'SELECT `id` FROM `t`');
  assert.equal(streamedSql('SELECT `id` FROM `t`'), 'SELECT `id` FROM `t`');

  reset();
  const generated = useStore.getState().generateAiSql('a', '查询 31 行', 'provider');
  const id = useStore.getState().tabs[0].aiRequestId;
  assert.equal(calls[0].args.input.requestId, id);
  channels.get(id).onmessage({ kind:'started' });
  send(id, '`'); send(id, '``sql\nSELECT '); flush();
  assert.equal(useStore.getState().tabs[0].sql, 'SELECT original;\n\nSELECT ', 'delta must appear before completion');
  assert.equal(useStore.getState().tabs[0].aiGenerating, true);
  await useStore.getState().runQuery('a');
  await useStore.getState().switchQueryConnection('a', 'other');
  assert.equal(calls.filter((call) => call.command === 'execute_query' || call.command === 'connect').length, 0);
  send(id, '31;\n```'); requests.get(id).resolve(result);
  assert.equal(await generated, true);
  assert.equal(useStore.getState().tabs[0].sql, 'SELECT original;\n\nSELECT 31;');
  assert.equal(useStore.getState().tabs[0].aiGenerating, false);
  assert.equal(timers.size, 0);

  reset();
  const cancelled = useStore.getState().generateAiSql('a', '查询', 'provider');
  const cancelId = useStore.getState().tabs[0].aiRequestId;
  send(cancelId, 'SELECT '); send(cancelId, 'partial');
  await useStore.getState().cancelAiSql('a');
  const partial = useStore.getState().tabs[0].sql;
  assert.equal(partial, 'SELECT original;\n\nSELECT partial');
  send(cancelId, ' SHOULD NOT APPEAR');
  channels.get(cancelId).onmessage({ kind:'started' });
  assert.ok(calls.filter((call) => call.command === 'cancel_ai').length >= 2, 'early cancellation is resent when registered');
  requests.get(cancelId).resolve(result);
  assert.equal(await cancelled, false);
  assert.equal(useStore.getState().tabs[0].sql, partial);

  reset();
  const failed = useStore.getState().generateAiSql('a', '查询', 'provider');
  const failedId = useStore.getState().tabs[0].aiRequestId;
  send(failedId, 'SELECT partial');
  requests.get(failedId).reject(new Error('stream interrupted'));
  assert.equal(await failed, false);
  assert.equal(useStore.getState().tabs[0].sql, 'SELECT original;\n\nSELECT partial');
  assert.match(useStore.getState().tabs[0].aiError, /stream interrupted/);
  assert.equal(useStore.getState().tabs[0].aiGenerating, false);

  reset();
  useStore.setState({ tabs:[...useStore.getState().tabs, { id:'b', kind:'query', sessionId:'local', database:'demo', sql:'', title:'B' }] });
  const jobA = useStore.getState().generateAiSql('a', 'A', 'provider');
  const idA = useStore.getState().tabs[0].aiRequestId;
  const jobB = useStore.getState().generateAiSql('b', 'B', 'provider');
  const idB = useStore.getState().tabs[1].aiRequestId;
  send(idA, 'SELECT A'); send(idB, 'SELECT B'); flush();
  assert.equal(useStore.getState().tabs[0].sql, 'SELECT original;\n\nSELECT A');
  assert.equal(useStore.getState().tabs[1].sql, 'SELECT B');
  useStore.getState().closeTab('a');
  send(idA, 'late'); requests.get(idA).resolve(result);
  assert.equal(await jobA, false);
  requests.get(idB).resolve({ ...result, sql:'SELECT B;' });
  assert.equal(await jobB, true);
  assert.equal(useStore.getState().tabs.length, 1);
  assert.equal(useStore.getState().tabs[0].sql, 'SELECT B;');
  assert.ok(calls.some((call) => call.command === 'cancel_ai' && call.args.requestId === idA));
  assert.equal(timers.size, 0);
  console.log('PASS: streamed editor updates before completion, split fences, preserved SQL, execution guards, stop/early cancel, partial errors, tab isolation and closed-tab cleanup');
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => { global.setTimeout = oldSet; global.clearTimeout = oldClear; });
