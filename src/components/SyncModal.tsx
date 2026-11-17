import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Search,
  ArrowRight,
  Check,
  Database,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Table2,
  XCircle,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useStore } from '../store';
import type {
  ConnectionProfile,
  DatabaseInfo,
  SyncPreview,
  SyncProgress,
  SyncResult,
  SyncTableOption,
} from '../types';
import { formatBytes, formatNumber } from '../lib/format';
import { fuzzyMatch } from '../lib/fuzzy';
import { Select } from './Select';
import { Modal } from './Modal';
import { Spinner, Switch } from './ui';

const TARGET_CATEGORIES = ['local', 'dev'];
const CATEGORY_LABELS: Record<string, string> = {
  local: '本地',
  dev: '开发',
  staging: '预发',
  prod: '生产',
};

export function SyncModal({ onClose }: { onClose: () => void }) {
  const connections = useStore((state) => state.connections);
  const sessions = useStore((state) => state.sessions);
  const activeConnectionId = useStore((state) => state.activeConnectionId);
  const connect = useStore((state) => state.connect);
  const refreshSchema = useStore((state) => state.refreshSchema);
  const toast = useStore((state) => state.toast);
  const [sourceId, setSourceId] = useState(activeConnectionId || connections[0]?.id || '');
  const targets = connections.filter((connection) => TARGET_CATEGORIES.includes(connection.category || 'local'));
  const [targetId, setTargetId] = useState(targets.find((connection) => connection.id !== sourceId)?.id || targets[0]?.id || '');
  const [sourceDbs, setSourceDbs] = useState<DatabaseInfo[]>([]);
  const [targetDbs, setTargetDbs] = useState<DatabaseInfo[]>([]);
  const [sourceDb, setSourceDb] = useState('');
  const [targetDb, setTargetDb] = useState('');
  const [preview, setPreview] = useState<SyncPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<'upsert' | 'append' | 'replace'>('upsert');
  const [createMissing, setCreateMissing] = useState(true);
  const [batchSize, setBatchSize] = useState(2000);
  const [concurrency, setConcurrency] = useState(4);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [progress, setProgress] = useState<Record<string, SyncProgress>>({});
  const [error, setError] = useState('');
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    unlistenRef.current = window.finch.onEvent((event) => {
      if (event.type === 'sync:progress' || event.type === 'sync:table') {
        const item = event as unknown as SyncProgress;
        setProgress((current) => ({ ...current, [item.table]: item }));
      }
    });
    return () => unlistenRef.current?.();
  }, []);

  const sourceProfile = connections.find((connection) => connection.id === sourceId);
  const targetProfile = connections.find((connection) => connection.id === targetId);

  const ensureConnected = async (id: string) => {
    if (!id) return false;
    if (sessions[id]?.status === 'connected') return true;
    return Boolean(await connect(id, { silent: true, focus: false }));
  };

  const loadSource = async (id: string) => {
    if (!id) return;
    if (!(await ensureConnected(id))) return;
    const dbs = await window.finch.schema.databases(id);
    setSourceDbs(dbs);
    const preferred = dbs.find((db) => db.name === sourceProfile?.database) || dbs.find((db) => !db.isSystem);
    setSourceDb(preferred?.name || '');
  };

  const loadTarget = async (id: string) => {
    if (!id) return;
    if (!(await ensureConnected(id))) return;
    const dbs = await window.finch.schema.databases(id);
    setTargetDbs(dbs);
    const preferred = dbs.find((db) => db.name === targetProfile?.database) || dbs.find((db) => !db.isSystem);
    setTargetDb(preferred?.name || '');
  };

  useEffect(() => {
    if (sessions[sourceId]?.status === 'connecting') return;
    loadSource(sourceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, sessions[sourceId]?.status]);

  useEffect(() => {
    if (sessions[targetId]?.status === 'connecting') return;
    loadTarget(targetId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId, sessions[targetId]?.status]);

  useEffect(() => {
    if (!sourceId || !targetId || !sourceDb || !targetDb) return;
    setLoading(true);
    setError('');
    setPreview(null);
    window.finch.sync
      .preview({ sourceId, targetId, sourceDatabase: sourceDb, targetDatabase: targetDb })
      .then((data) => {
        setPreview(data);
        setSelected(new Set(data.tables.map((table) => table.name)));
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, targetId, sourceDb, targetDb]);

  const allRows = useMemo(() => preview?.tables || [], [preview]);
  const [filter, setFilter] = useState('');
  const rows = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return allRows;
    return allRows.filter((table) => fuzzyMatch(table.name, query));
  }, [allRows, filter]);
  const totalBytes = allRows.filter((table) => selected.has(table.name)).reduce((sum, table) => sum + table.bytes, 0);
  const missing = allRows.filter((table) => !table.exists && selected.has(table.name)).length;

  const run = async () => {
    if (!preview || selected.size === 0) return;
    setRunning(true);
    setError('');
    setResult(null);
    setProgress({});
    try {
      const response = await window.finch.sync.run({
        sourceId,
        targetId,
        sourceDatabase: sourceDb,
        targetDatabase: targetDb,
        tables: rows
          .filter((table) => selected.has(table.name))
          .map((table) => ({ name: table.name, mode, columns: [] })),
        createMissing,
        batchSize,
        concurrency,
      });
      setResult(response);
      const errors = response.tables.filter((table) => table.error);
      if (errors.length) {
        toast('warning', '同步完成，但有表失败', `${response.tables.length - errors.length} 张表成功，${errors.length} 张失败`);
      } else {
        toast('success', '数据同步完成', `${response.tables.length} 张表 · ${formatNumber(response.tables.reduce((sum, table) => sum + table.written, 0))} 行`);
      }
      refreshSchema(targetId, targetDb).catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      toast('error', '同步失败', err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const toggle = (name: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <Modal
      open
      onClose={() => {
        if (!running) onClose();
      }}
      title="数据同步"
      subtitle="只同步数据；目标表已存在时不会修改它的 DDL"
      icon={<ArrowRight size={17} />}
      size="xl"
      className="sync-modal"
      footer={
        <>
          <span className="modal-foot-hint"><ShieldCheck size={11} /> 目标仅限本地 / 开发环境</span>
          <span className="modal-foot-spacer" />
          <button className="btn btn-ghost" onClick={onClose} disabled={running}>取消</button>
          <button className="btn btn-primary" onClick={run} disabled={running || loading || selected.size === 0 || !preview}>
            {running ? <Loader2 size={13} className="spin" /> : <ArrowRight size={13} />}
            {running ? '同步中…' : `开始同步 ${selected.size} 张表`}
          </button>
        </>
      }
    >
      <div className="sync-form">
        <div className="sync-connections">
          <div className="sync-side">
            <span className="sync-side-label">源数据库</span>
            <Select
              value={sourceId}
              onChange={setSourceId}
              ariaLabel="源连接"
              options={connections.map((connection) => ({
                value: connection.id,
                label: connection.name,
                hint: CATEGORY_LABELS[connection.category || 'local'],
              }))}
            />
            <Select
              value={sourceDb}
              onChange={setSourceDb}
              ariaLabel="源数据库"
              placeholder="选择数据库"
              options={sourceDbs.filter((db) => !db.isSystem).map((db) => ({ value: db.name, label: db.name }))}
            />
          </div>
          <span className="sync-arrow"><ArrowRight size={16} /></span>
          <div className="sync-side">
            <span className="sync-side-label">目标（只允许本地 / 开发）</span>
            <Select
              value={targetId}
              onChange={setTargetId}
              ariaLabel="目标连接"
              options={targets.map((connection) => ({
                value: connection.id,
                label: connection.name,
                hint: CATEGORY_LABELS[connection.category || 'local'],
              }))}
            />
            <Select
              value={targetDb}
              onChange={setTargetDb}
              ariaLabel="目标数据库"
              placeholder="选择数据库"
              options={targetDbs.filter((db) => !db.isSystem).map((db) => ({ value: db.name, label: db.name }))}
            />
          </div>
        </div>

        {targets.length === 0 && (
          <div className="danger-callout">
            <AlertTriangle size={15} />
            <span>没有「本地」或「开发」分类的连接，无法选择同步目标。请先在连接设置里调整环境分类。</span>
          </div>
        )}

        <div className="sync-options">
          <label className="sync-option">
            <span>写入方式</span>
            <Select
              value={mode}
              onChange={(value) => setMode(value as typeof mode)}
              size="sm"
              width={188}
              ariaLabel="写入方式"
              options={[
                { value: 'upsert', label: '按主键 UPSERT（推荐）' },
                { value: 'append', label: '追加' },
                { value: 'replace', label: '清空目标表后写入' },
              ]}
            />
          </label>
          <label className="sync-option">
            <span>批量大小</span>
            <Select
              value={batchSize}
              onChange={(value) => setBatchSize(Number(value))}
              size="sm"
              width={116}
              ariaLabel="批量大小"
              options={[500, 1000, 2000, 5000, 10000].map((value) => ({
                value: String(value),
                label: `${value} 行 / 批`,
              }))}
            />
          </label>
          <label className="sync-option">
            <span>并发线程</span>
            <Select
              value={concurrency}
              onChange={(value) => setConcurrency(Number(value))}
              size="sm"
              width={72}
              ariaLabel="并发线程"
              options={[1, 2, 4, 8].map((value) => ({ value: String(value), label: String(value) }))}
            />
          </label>
          <label className="sync-option sync-switch">
            <span>目标缺表时自动建表</span>
            <Switch checked={createMissing} onChange={setCreateMissing} />
          </label>
        </div>

        <div className="sync-note">
          <ShieldCheck size={14} />
          <span>
            已存在的目标表 <strong>只写数据、不改结构</strong>；只同步两边都有的字段。
            目标缺少的表会用源表 DDL 创建（仅 CREATE，不 ALTER）。大表会按数字主键自动分片，使用游标翻页并发写入；同一连接会自动限制为 4 并发。
          </span>
        </div>

        {loading && <div className="sync-loading"><Loader2 size={16} className="spin" /> 正在对比表结构…</div>}
        {error && <div className="test-result is-error"><XCircle size={14} /><span>{error}</span></div>}

        {preview && !result && (
          <div className="sync-tables">
            <div className="sync-tables-head">
              <div>
                <strong>{filter ? `${rows.length} / ${allRows.length}` : allRows.length} 张表</strong>
                <span>{formatBytes(totalBytes)} · 已选 {selected.size} 张</span>
              </div>
              <div className="sync-table-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => setSelected((current) => new Set([...current, ...rows.map((table) => table.name)]))}>全选</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>清空</button>
              </div>
            </div>
            <div className="sync-search">
              <Search size={12} />
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="模糊搜索表名，例如 ord 或 oi…"
                spellCheck={false}
              />
              {filter && <button onClick={() => setFilter('')} aria-label="清除搜索"><XCircle size={11} /></button>}
            </div>
            {rows.length === 0 ? (
              <div className="sync-empty">没有匹配的表</div>
            ) : (
            <div className="sync-table-list">
              {rows.map((table) => {
                const checked = selected.has(table.name);
                const progressRow = progress[table.name];
                return (
                  <label key={table.name} className={clsx('sync-table-row', checked && 'is-checked')}>
                    <button
                      className={clsx('grid-check', checked && 'is-checked')}
                      onClick={(event) => {
                        event.preventDefault();
                        toggle(table.name);
                      }}
                    >
                      {checked && <Check size={10} />}
                    </button>
                    <Table2 size={13} />
                    <span className="sync-table-name">{table.name}</span>
                    <span className="sync-table-rows">~{formatNumber(table.rows)} rows</span>
                    <span className={table.exists ? 'sync-exists' : 'sync-missing'}>
                      {table.exists ? '表已存在 · 保留 DDL' : '将创建表'}
                    </span>
                    {progressRow && <span className="sync-progress-inline">{formatNumber(progressRow.written)} 行</span>}
                  </label>
                );
              })}
            </div>
            )}
            {missing > 0 && (
              <p className="sync-hint">其中 {missing} 张目标表不存在，将按源表结构创建后再写入数据。</p>
            )}
          </div>
        )}

        {running && (
          <div className="sync-progress">
            <div className="sync-progress-head">
              <span>同步进行中…</span>
              <span>{Object.keys(progress).length} / {selected.size} 张表</span>
            </div>
            <div className="metric-progress"><span style={{ width: `${Math.min(100, (Object.keys(progress).length / Math.max(1, selected.size)) * 100)}%` }} /></div>
            <div className="sync-progress-list">
              {[...selected].map((table) => {
                const item = progress[table];
                return (
                  <div key={table} className={clsx('sync-progress-row', item?.error && 'is-error')}>
                    <span>{table}</span>
                    <span>{item ? (item.error ? item.error : `${formatNumber(item.written)} 行`) : '等待中'}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {result && (
          <div className="sync-result">
            <div className="sync-result-head">
              <span className="command-icon" style={{ width: 32, height: 32 }}><Check size={18} /></span>
              <div>
                <strong>同步完成</strong>
                <span>{result.tables.length} 张表 · {formatNumber(result.tables.reduce((sum, table) => sum + table.written, 0))} 行 · {result.durationMs} ms</span>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => setResult(null)}><RefreshCw size={12} /> 再同步一次</button>
            </div>
            <div className="sync-result-list">
              {result.tables.map((table) => (
                <div key={table.table} className={clsx('sync-result-row', table.error && 'is-error')}>
                  <span>{table.table}</span>
                  <span>{table.created ? '已建表 · ' : ''}{formatNumber(table.written)} 行{table.shards && table.shards > 1 ? ` · ${table.shards} 分片` : ''}{table.skippedColumns.length ? ` · 跳过 ${table.skippedColumns.join(', ')}` : ''}</span>
                  {table.error && <span className="sync-result-error">{table.error}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
