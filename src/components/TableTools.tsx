import { useEffect, useMemo, useState } from 'react';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import {
  AlertTriangle,
  Check,
  Download,
  FileCode2,
  FolderOpen,
  Loader2,
  Plus,
  Table2,
  Trash2,
  X,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useStore } from '../store';
import type { DdlColumn, DdlIndex, TableInfo, WorkspaceTab } from '../types';
import { formatNumber } from '../lib/format';
import { formatCreateTable } from '../lib/ddlFormat';
import { Select } from './Select';
import { Modal } from './Modal';
import { Segmented, Switch } from './ui';
import { DdlViewer } from './DdlViewer';
import { isProdProfile } from '../lib/prodConfirm';

type EditableColumn = DdlColumn & {
  key: string;
  original?: DdlColumn;
  removed?: boolean;
};

type EditableIndex = DdlIndex & {
  key: string;
  original?: DdlIndex;
  removed?: boolean;
};

const TYPES = [
  'BIGINT', 'INT', 'INT UNSIGNED', 'SMALLINT', 'TINYINT', 'DECIMAL(12,2)',
  'VARCHAR(255)', 'VARCHAR(64)', 'TEXT', 'LONGTEXT', 'DATETIME', 'TIMESTAMP',
  'DATE', 'TIME', 'JSON', 'BOOLEAN', 'BLOB',
];

let seq = 0;
function newColumn(partial: Partial<DdlColumn> = {}): EditableColumn {
  seq += 1;
  return {
    key: `new-${seq}`,
    name: partial.name || '',
    columnType: partial.columnType || 'VARCHAR(255)',
    nullable: partial.nullable ?? true,
    defaultValue: partial.defaultValue ?? null,
    autoIncrement: partial.autoIncrement ?? false,
    primary: partial.primary ?? false,
    comment: partial.comment || '',
    after: partial.after || null,
  };
}

function indexId() {
  seq += 1;
  return `idx-${seq}`;
}

function newIndex(partial: Partial<DdlIndex> = {}): EditableIndex {
  return {
    key: indexId(),
    name: partial.name || '',
    columns: partial.columns ? [...partial.columns] : [],
    unique: partial.unique ?? false,
    indexType: partial.indexType || 'BTREE',
  };
}

function sameIndex(a: DdlIndex, b: DdlIndex) {
  return a.name === b.name
    && a.unique === b.unique
    && (a.indexType || 'BTREE').toUpperCase() === (b.indexType || 'BTREE').toUpperCase()
    && a.columns.join(',') === b.columns.join(',');
}

function indexKindValue(index: DdlIndex) {
  const type = (index.indexType || 'BTREE').toUpperCase();
  if (type === 'FULLTEXT' || type === 'SPATIAL') return type;
  return index.unique ? 'UNIQUE' : 'BTREE';
}

function indexKindPatch(kind: string): Pick<DdlIndex, 'unique' | 'indexType'> {
  if (kind === 'UNIQUE') return { unique: true, indexType: 'BTREE' };
  if (kind === 'FULLTEXT') return { unique: false, indexType: 'FULLTEXT' };
  if (kind === 'SPATIAL') return { unique: false, indexType: 'SPATIAL' };
  return { unique: false, indexType: 'BTREE' };
}

function sameColumn(a: DdlColumn, b: DdlColumn) {
  return a.name === b.name
    && a.columnType === b.columnType
    && a.nullable === b.nullable
    && (a.defaultValue ?? '') === (b.defaultValue ?? '')
    && a.autoIncrement === b.autoIncrement
    && a.comment === b.comment;
}

export function TableDesignerModal() {
  const state = useStore((store) => store.tableTool);
  const close = useStore((store) => store.closeTableTool);
  const refreshSchema = useStore((store) => store.refreshSchema);
  const openTable = useStore((store) => store.openTable);
  const toast = useStore((store) => store.toast);
  const askConfirm = useStore((store) => store.askConfirm);
  const mode = state?.mode === 'edit' ? 'edit' : 'create';
  const [table, setTable] = useState('');
  const [engine, setEngine] = useState('InnoDB');
  const [charset, setCharset] = useState('utf8mb4');
  const [columns, setColumns] = useState<EditableColumn[]>([]);
  const [indexes, setIndexes] = useState<EditableIndex[]>([]);
  const [section, setSection] = useState<'columns' | 'indexes'>('columns');
  const [loading, setLoading] = useState(mode === 'edit');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [renameTo, setRenameTo] = useState('');

  useEffect(() => {
    if (!state || state.mode === 'dump') return;
    setError('');
    setRenameTo('');
    setSection('columns');
    if (state.mode === 'create') {
      setTable('');
      setIndexes([]);
      setColumns([
        newColumn({ name: 'id', columnType: 'BIGINT', nullable: false, autoIncrement: true, primary: true }),
        newColumn({ name: 'name', columnType: 'VARCHAR(255)' }),
        newColumn({ name: 'created_at', columnType: 'TIMESTAMP', nullable: false, defaultValue: 'CURRENT_TIMESTAMP' }),
      ]);
      setLoading(false);
      return;
    }
    setTable(state.table);
    setLoading(true);
    window.finch.schema
      .tableDetails(state.sessionId, state.database, state.table)
      .then((details) => {
        setColumns(
          details.columns.map((column) => ({
            ...newColumn({
              name: column.name,
              columnType: column.columnType,
              nullable: column.nullable === 'YES',
              defaultValue: column.defaultValue,
              autoIncrement: column.extra.toLowerCase().includes('auto_increment'),
              primary: column.columnKey === 'PRI',
              comment: column.comment,
            }),
            key: `existing-${column.name}`,
            original: {
              name: column.name,
              columnType: column.columnType,
              nullable: column.nullable === 'YES',
              defaultValue: column.defaultValue,
              autoIncrement: column.extra.toLowerCase().includes('auto_increment'),
              primary: column.columnKey === 'PRI',
              comment: column.comment,
              after: null,
            },
          })),
        );
        const grouped = new Map<string, EditableIndex>();
        for (const item of details.indexes) {
          if (item.name.toUpperCase() === 'PRIMARY') continue;
          const existing = grouped.get(item.name);
          if (existing) {
            existing.columns.push(item.column);
          } else {
            grouped.set(
              item.name,
              newIndex({
                name: item.name,
                columns: [item.column],
                unique: item.unique,
                indexType: item.type || 'BTREE',
              }),
            );
          }
        }
        setIndexes([...grouped.values()]);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [state]);

  const changes = useMemo(() => {
    if (mode === 'create') return { add: columns, modify: [], drop: [] };
    const visible = columns.filter((column) => !column.removed);
    const add = visible.filter((column) => !column.original).map(({ key, original, removed, ...column }) => column);
    const modify = visible
      .filter((column) => column.original && !sameColumn(column, column.original))
      .map(({ key, original, removed, ...column }) => column);
    const visibleNames = new Set(visible.map((column) => column.name));
    const drop = columns
      .filter((column) => column.original && !visibleNames.has(column.original.name))
      .map((column) => column.original!.name);
    return { add, modify, drop };
  }, [columns, mode]);

  const indexChanges = useMemo(() => {
    const visible = indexes.filter((index) => !index.removed);
    const add = visible
      .filter((index) => !index.original)
      .map(({ key, original, removed, ...index }) => index);
    const modify = visible
      .filter((index) => index.original && !sameIndex(index, index.original))
      .map(({ key, original, removed, ...index }) => index);
    const drop = indexes
      .filter((index) => index.original && index.removed)
      .map((index) => index.original!.name);
    return { add, modify, drop };
  }, [indexes]);

  const updateIndex = (key: string, patch: Partial<EditableIndex>) => {
    setIndexes((current) => current.map((index) => (index.key === key ? { ...index, ...patch } : index)));
  };

  const removeIndex = (key: string) => {
    setIndexes((current) => {
      const target = current.find((index) => index.key === key);
      if (target?.original) {
        return current.map((index) => (index.key === key ? { ...index, removed: true } : index));
      }
      return current.filter((index) => index.key !== key);
    });
  };

  const addIndex = () => {
    setIndexes((current) => [...current, newIndex()]);
    setSection('indexes');
  };

  const indexColumns = columns
    .filter((column) => !column.removed && column.name.trim())
    .map((column) => column.name.trim());

  if (!state || state.mode === 'dump') return null;

  const update = (key: string, patch: Partial<EditableColumn>) => {
    setColumns((current) => current.map((column) => (column.key === key ? { ...column, ...patch } : column)));
  };

  const removeColumn = (key: string) => {
    setColumns((current) => {
      const target = current.find((column) => column.key === key);
      if (target?.original) return current.map((column) => (column.key === key ? { ...column, removed: true } : column));
      return current.filter((column) => column.key !== key);
    });
  };

  const submit = async () => {
    if (!table.trim()) {
      setError('表名不能为空');
      return;
    }
    if (!columns.some((column) => !column.removed && column.name.trim())) {
      setError('至少需要一个字段');
      return;
    }
    const badIndex = indexes.find((index) => !index.removed && index.columns.length === 0);
    if (badIndex) {
      setSection('indexes');
      setError('有索引还没有选择字段');
      return;
    }
    const names = new Set<string>();
    for (const index of indexes.filter((item) => !item.removed)) {
      const name = (index.name.trim() || `idx_${index.columns.join('_')}`).toLowerCase();
      if (names.has(name)) {
        setSection('indexes');
        setError(`索引名重复: ${name}`);
        return;
      }
      names.add(name);
    }
    setSaving(true);
    setError('');
    try {
      if (mode === 'create') {
        await window.finch.ddl.createTable({
          sessionId: state.sessionId,
          database: state.database,
          table: table.trim(),
          engine,
          charset,
          columns: columns.map(({ key, original, removed, ...column }) => column),
          indexes: indexChanges.add,
        });
        toast('success', '表已创建', `${state.database}.${table.trim()}`);
        await refreshSchema(state.sessionId, state.database);
      } else {
        if (
          !changes.add.length
          && !changes.modify.length
          && !changes.drop.length
          && !indexChanges.add.length
          && !indexChanges.modify.length
          && !indexChanges.drop.length
          && (!renameTo || renameTo === table)
        ) {
          setError('没有检测到结构变化');
          setSaving(false);
          return;
        }
        const prod = isProdProfile(useStore.getState().connections.find((item) => item.id === state.sessionId));
        if (prod) {
          const confirmed = await useStore.getState().confirmProduction({
            title: '生产环境：确认修改表结构',
            message: `即将修改 ${state.database}.${table} 的结构（可能删除字段或索引）。`,
            sql: `ALTER TABLE \`${state.database}\`.\`${table}\` ...`,
          });
          if (!confirmed) return;
        }
        await window.finch.ddl.alterTable({
          sessionId: state.sessionId,
          database: state.database,
          table,
          add: changes.add,
          modify: changes.modify,
          dropColumns: changes.drop,
          renameTo: renameTo.trim() && renameTo.trim() !== table ? renameTo.trim() : null,
          addIndexes: indexChanges.add,
          modifyIndexes: indexChanges.modify,
          dropIndexes: indexChanges.drop,
          prodConfirmed: prod,
        });
        toast('success', '表结构已更新', `${state.database}.${table}`);
        await refreshSchema(state.sessionId, state.database);
      }
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={close}
      title={mode === 'create' ? '新建表' : `编辑表结构 · ${table}`}
      subtitle={`${state.database} · ${mode === 'create' ? '创建新表' : '只修改结构，不自动迁移数据'}`}
      icon={<Table2 size={17} />}
      size="xl"
      className="designer-modal"
      footer={
        <>
          {mode === 'edit' && (
            <button
              className="btn btn-ghost btn-sm danger-text"
              onClick={() =>
                askConfirm({
                  title: '删除表',
                  message: `删除 ${state.database}.${table}？`,
                  detail: '表结构和全部数据都会永久删除。',
                  confirmLabel: '删除表',
                  onConfirm: async () => {
                    let prodConfirmed = false;
                    if (isProdProfile(useStore.getState().connections.find((item) => item.id === state.sessionId))) {
                      prodConfirmed = await useStore.getState().confirmProduction({
                        title: '生产环境：确认删除表',
                        message: `即将永久删除 ${state.database}.${table} 及其全部数据。`,
                        sql: `DROP TABLE \`${state.database}\`.\`${table}\`;`,
                      });
                      if (!prodConfirmed) return;
                    }
                    await window.finch.ddl.dropTable({ sessionId: state.sessionId, database: state.database, table, prodConfirmed });
                    toast('success', '表已删除', table);
                    refreshSchema(state.sessionId, state.database).catch(() => {});
                    close();
                  },
                })
              }
            >
              <Trash2 size={13} /> 删除表
            </button>
          )}
          <span className="modal-foot-spacer" />
          <button className="btn btn-ghost" onClick={close} disabled={saving}>取消</button>
          <button className="btn btn-primary" onClick={submit} disabled={saving || loading}>
            {saving ? <Loader2 size={13} className="spin" /> : <Check size={13} />}
            {mode === 'create' ? '创建表' : '保存结构'}
          </button>
        </>
      }
    >
      {loading ? (
        <div className="designer-loading"><Loader2 size={18} className="spin" /> 正在读取表结构…</div>
      ) : (
        <div className="designer-form">
          <div className="designer-meta">
            <label className="field">
              <span>表名</span>
              <input value={table} onChange={(event) => setTable(event.target.value)} placeholder="new_table" spellCheck={false} />
            </label>
            {mode === 'edit' && (
              <label className="field">
                <span>重命名为 <em>可选</em></span>
                <input value={renameTo} onChange={(event) => setRenameTo(event.target.value)} placeholder={table} spellCheck={false} />
              </label>
            )}
            <label className="field">
              <span>引擎</span>
              <Select
                value={engine}
                onChange={setEngine}
                ariaLabel="存储引擎"
                width={116}
                options={[
                  { value: 'InnoDB', label: 'InnoDB', hint: '事务、行锁，默认' },
                  { value: 'MyISAM', label: 'MyISAM', hint: '无事务，表锁' },
                  { value: 'MEMORY', label: 'MEMORY', hint: '内存表，重启丢失' },
                ]}
              />
            </label>
            <label className="field">
              <span>字符集</span>
              <Select
                value={charset}
                onChange={setCharset}
                ariaLabel="字符集"
                width={116}
                options={[
                  { value: 'utf8mb4', label: 'utf8mb4', hint: '完整 UTF-8，含 emoji' },
                  { value: 'utf8', label: 'utf8', hint: '旧版三字节 UTF-8' },
                  { value: 'latin1', label: 'latin1', hint: '西欧字符集' },
                  { value: 'ascii', label: 'ascii', hint: '仅 ASCII' },
                ]}
              />
            </label>
          </div>

          <div className="designer-sections">
            <button
              className={clsx('designer-tab', section === 'columns' && 'is-active')}
              onClick={() => setSection('columns')}
            >
              字段 <span>{columns.filter((column) => !column.removed).length}</span>
            </button>
            <button
              className={clsx('designer-tab', section === 'indexes' && 'is-active')}
              onClick={() => setSection('indexes')}
            >
              索引 <span>{indexes.filter((index) => !index.removed).length}</span>
            </button>
            <span className="designer-sections-spacer" />
            {section === 'columns' ? (
              <button className="btn btn-ghost btn-sm" onClick={() => setColumns((current) => [...current, newColumn()])}>
                <Plus size={12} /> 添加字段
              </button>
            ) : (
              <button className="btn btn-ghost btn-sm" onClick={addIndex}>
                <Plus size={12} /> 添加索引
              </button>
            )}
          </div>

          {section === 'columns' ? (
            <>
              <div className="designer-columns">
                <div className="designer-columns-head">
                  <span>字段</span><span>类型</span><span>可空</span><span>默认值</span><span>主键</span><span>自增</span><span>注释</span><span />
                </div>
                {columns.filter((column) => !column.removed).map((column) => (
                  <div className="designer-column-row" key={column.key}>
                    <input
                      value={column.name}
                      onChange={(event) => update(column.key, { name: event.target.value })}
                      placeholder="column"
                      spellCheck={false}
                      disabled={Boolean(column.original)}
                      title={column.original ? '已有字段重命名请使用 SQL 编辑器' : '字段名'}
                    />
                    <input
                      value={column.columnType}
                      onChange={(event) => update(column.key, { columnType: event.target.value })}
                      list="ddl-types"
                      spellCheck={false}
                    />
                    <button className={clsx('designer-toggle', column.nullable && 'is-on')} onClick={() => update(column.key, { nullable: !column.nullable })}>
                      {column.nullable ? 'NULL' : 'NOT NULL'}
                    </button>
                    <input value={column.defaultValue ?? ''} onChange={(event) => update(column.key, { defaultValue: event.target.value || null })} placeholder="默认值" spellCheck={false} />
                    <button
                      className={clsx('designer-toggle', column.primary && 'is-on')}
                      disabled={mode === 'edit'}
                      onClick={() => update(column.key, { primary: !column.primary })}
                    >
                      PK
                    </button>
                    <button className={clsx('designer-toggle', column.autoIncrement && 'is-on')} onClick={() => update(column.key, { autoIncrement: !column.autoIncrement })}>
                      AI
                    </button>
                    <input value={column.comment} onChange={(event) => update(column.key, { comment: event.target.value })} placeholder="注释" />
                    <button className="designer-remove" onClick={() => removeColumn(column.key)} title="删除字段">
                      <X size={12} />
                    </button>
                  </div>
                ))}
                <datalist id="ddl-types">
                  {TYPES.map((type) => <option key={type} value={type} />)}
                </datalist>
                <button className="designer-add" onClick={() => setColumns((current) => [...current, newColumn()])}>
                  <Plus size={13} /> 添加字段
                </button>
              </div>
              {mode === 'edit' && (
                <p className="designer-note">
                  修改字段会执行 <code>ALTER TABLE ... MODIFY COLUMN</code>；删除字段会永久删除该列数据。主键变更请使用 SQL 编辑器。
                </p>
              )}
            </>
          ) : (
            <div className="designer-indexes">
              <div className="designer-index-head">
                <span>索引名</span><span>字段（按顺序）</span><span>类型</span><span />
              </div>
              {indexes.filter((index) => !index.removed).length === 0 && (
                <div className="designer-index-empty">还没有索引。添加后会和建表 / 改表语句一起执行。</div>
              )}
              {indexes.filter((index) => !index.removed).map((index) => (
                <div className="designer-index-row" key={index.key}>
                  <input
                    value={index.name}
                    onChange={(event) => updateIndex(index.key, { name: event.target.value })}
                    placeholder={`idx_${index.columns.join('_') || 'name'}`}
                    spellCheck={false}
                    disabled={Boolean(index.original)}
                    title={index.original ? '已有索引请删除后重新创建来改名' : '留空自动命名'}
                  />
                  <div className="index-columns">
                    {index.columns.map((column) => (
                      <span className="index-col" key={column}>
                        {column}
                        <button
                          onClick={() =>
                            updateIndex(index.key, {
                              columns: index.columns.filter((item) => item !== column),
                            })
                          }
                          title="移除"
                        >
                          <X size={9} />
                        </button>
                      </span>
                    ))}
                    <Select
                      value=""
                      onChange={(value) => {
                        if (!value) return;
                        updateIndex(index.key, { columns: [...index.columns, value] });
                      }}
                      size="sm"
                      width={82}
                      ariaLabel="添加索引字段"
                      placeholder="+ 字段"
                      options={indexColumns
                        .filter((column) => !index.columns.includes(column))
                        .map((column) => ({ value: column, label: column }))}
                    />
                  </div>
                  <Select
                    value={indexKindValue(index)}
                    onChange={(value) => updateIndex(index.key, indexKindPatch(value))}
                    size="sm"
                    width={86}
                    ariaLabel="索引类型"
                    options={[
                      { value: 'BTREE', label: '普通' },
                      { value: 'UNIQUE', label: '唯一' },
                      { value: 'FULLTEXT', label: '全文' },
                      { value: 'SPATIAL', label: '空间' },
                    ]}
                  />
                  <button className="designer-remove" onClick={() => removeIndex(index.key)} title="删除索引">
                    <X size={12} />
                  </button>
                </div>
              ))}
              <button className="designer-add" onClick={addIndex}>
                <Plus size={13} /> 添加索引
              </button>
              <p className="designer-note">
                索引名留空会自动生成；字段顺序决定联合索引顺序。主键仍在「字段」里用 PK 设置。
                {mode === 'edit' && ' 修改已有索引会先 DROP 再 ADD。'}
              </p>
            </div>
          )}
          {error && <div className="test-result is-error"><AlertTriangle size={14} /><span>{error}</span></div>}
        </div>
      )}
    </Modal>
  );
}

export function DumpModal() {
  const state = useStore((store) => store.tableTool);
  const close = useStore((store) => store.closeTableTool);
  const toast = useStore((store) => store.toast);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [structure, setStructure] = useState(true);
  const [data, setData] = useState(true);
  const [split, setSplit] = useState(false);
  const [view, setView] = useState<'tables' | 'preview'>('tables');
  const [previews, setPreviews] = useState<{ table: string; ddl: string }[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dumping, setDumping] = useState(false);
  const [current, setCurrent] = useState('');
  const [savedPath, setSavedPath] = useState('');

  useEffect(() => {
    if (!state || state.mode !== 'dump') return;
    window.finch.schema
      .tables(state.sessionId, state.database)
      .then((items) => {
        setTables(items);
        const names = new Set(items.map((table) => table.name));
        const preset = state.tables?.length
          ? state.tables
          : state.table
            ? [state.table]
            : items.map((table) => table.name);
        setSelected(new Set(preset.filter((name) => names.has(name))));
      })
      .catch((err) => toast('error', '读取表失败', err.message))
      .finally(() => setLoading(false));
  }, [state]);

  useEffect(() => {
    if (!state || state.mode !== 'dump') return;
    return window.finch.onEvent((event) => {
      if (event.type === 'dump:progress') setCurrent((event as unknown as { table: string }).table);
    });
  }, [state]);

  if (!state || state.mode !== 'dump') return null;

  const loadPreview = async () => {
    setPreviewLoading(true);
    setView('preview');
    try {
      const items = await Promise.all(
        [...selected].map(async (table) => {
          const details = await window.finch.schema.tableDetails(state.sessionId, state.database, table);
          return { table, ddl: details.ddl };
        }),
      );
      setPreviews(items);
    } catch (err) {
      toast('error', '读取 DDL 失败', err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewLoading(false);
    }
  };

  const start = async () => {
    const path = split
      ? await openDialog({ title: '选择转储目录', directory: true, multiple: false })
      : await saveDialog({
          title: '转储 SQL',
          defaultPath: `${state.database}-${new Date().toISOString().slice(0, 10)}.sql`,
          filters: [{ name: 'SQL', extensions: ['sql'] }],
        });
    if (!path || Array.isArray(path)) return;
    setDumping(true);
    setCurrent('');
    try {
      const result = await window.finch.dump({
        sessionId: state.sessionId,
        database: state.database,
        path,
        structure,
        data,
        tables: [...selected],
        splitFiles: split,
      });
      setSavedPath(result.path);
      toast('success', '转储完成', split ? `${result.tables} 个 SQL 文件 · ${path}` : `${result.tables} 张表 · ${path}`);
    } catch (err) {
      toast('error', '转储失败', err instanceof Error ? err.message : String(err));
    } finally {
      setDumping(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => {
        if (!dumping) close();
      }}
      title="转储 SQL"
      subtitle={`${state.database} · 结构 / 数据，可流式写入本地文件`}
      icon={<Download size={17} />}
      size="lg"
      footer={
        <>
          <span className="modal-foot-hint"><FileCode2 size={11} /> 大表使用流式写出，不会全部进内存</span>
          <span className="modal-foot-spacer" />
          <button className="btn btn-ghost" onClick={close} disabled={dumping}>取消</button>
          <button className="btn btn-primary" onClick={start} disabled={dumping || loading || selected.size === 0 || (!structure && !data)}>
            {dumping ? <Loader2 size={13} className="spin" /> : <Download size={13} />}
            {dumping ? '正在写入…' : split ? '选择目录并转储' : '选择文件并转储'}
          </button>
        </>
      }
    >
      <div className="dump-form">
        <div className="dump-options">
          <label className="sync-option sync-switch"><span>包含结构</span><Switch checked={structure} onChange={setStructure} /></label>
          <label className="sync-option sync-switch"><span>包含数据</span><Switch checked={data} onChange={setData} /></label>
          <div className="dump-split">
            <span>导出方式</span>
            <Segmented
              value={split ? 'split' : 'single'}
              options={[
                { value: 'single', label: '合并为一个文件' },
                { value: 'split', label: '每表一个文件' },
              ]}
              onChange={(value) => setSplit(value === 'split')}
            />
          </div>
          <button
            className="btn btn-ghost btn-sm dump-preview-btn"
            onClick={() => (view === 'preview' ? setView('tables') : loadPreview())}
            disabled={selected.size === 0}
          >
            {view === 'preview' ? <X size={12} /> : <FileCode2 size={12} />}
            {view === 'preview' ? '返回选择' : '预览所选 DDL'}
          </button>
        </div>
        {view === 'preview' ? (
          <div className="dump-preview">
            {previewLoading ? (
              <div className="designer-loading"><Loader2 size={16} className="spin" /> 读取 DDL…</div>
            ) : previews.length === 0 ? (
              <div className="designer-loading">没有可预览的表</div>
            ) : (
              previews.map((item) => (
                <section className="dump-preview-item" key={item.table}>
                  <header>
                    <Table2 size={12} />
                    <strong>{item.table}</strong>
                    <span className="modal-foot-spacer" />
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        navigator.clipboard.writeText(item.ddl);
                        toast('success', 'DDL 已复制', item.table);
                      }}
                    >
                      <FileCode2 size={12} /> 复制
                    </button>
                  </header>
                  <div className="dump-preview-ddl">
                    <DdlViewer value={formatCreateTable(item.ddl)} />
                  </div>
                </section>
              ))
            )}
          </div>
        ) : loading ? (
          <div className="designer-loading"><Loader2 size={16} className="spin" /> 读取表…</div>
        ) : (
          <div className="dump-tables">
            {tables.map((table) => {
              const checked = selected.has(table.name);
              return (
                <label key={table.name} className={clsx('sync-table-row', checked && 'is-checked')}>
                  <button
                    className={clsx('grid-check', checked && 'is-checked')}
                    onClick={(event) => {
                      event.preventDefault();
                      setSelected((current) => {
                        const next = new Set(current);
                        if (next.has(table.name)) next.delete(table.name); else next.add(table.name);
                        return next;
                      });
                    }}
                  >
                    {checked && <Check size={10} />}
                  </button>
                  <Table2 size={13} />
                  <span className="sync-table-name">{table.name}</span>
                  <span className="sync-table-rows">~{formatNumber(table.rowEstimate)} rows</span>
                </label>
              );
            })}
          </div>
        )}
        {dumping && current && <div className="dump-progress"><Loader2 size={14} className="spin" /> 正在写 {current}…</div>}
        {savedPath && (
          <div className="test-result is-success">
            <Check size={14} />
            <span>已保存 {savedPath}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => window.finch.app.showItem(savedPath)}>
              <FolderOpen size={12} /> 在 Finder 中显示
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
