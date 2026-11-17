import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Check,
  Columns3,
  Copy,
  Database,
  Download,
  Eye,
  FileJson,
  FileSpreadsheet,
  FileText,
  Filter,
  KeyRound,
  Layers,
  Loader2,
  Lock,
  PencilLine,
  Plus,
  RefreshCw,
  Search,
  Table2,
  Trash2,
  X,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useStore } from '../store';
import type { CellValue, ColumnInfo, ResultColumn, TableDetails, TableFilter, WorkspaceTab } from '../types';
import { formatBytes, formatNumber, isJsonLike, prettyJson, quoteIdentifier } from '../lib/format';
import { FILTER_OPERATORS, filterIsMultiValue, filterNeedsSecondValue, filterNeedsValue, filterOperatorLabel } from '../lib/filters';
import { ResultGrid } from './ResultGrid';
import { Select } from './Select';
import { DdlViewer } from './DdlViewer';
import { formatCreateTable } from '../lib/ddlFormat';
import { Modal } from './Modal';
import { IconButton, Kbd, Segmented, Spinner } from './ui';

const PAGE_SIZE = 200;

export function TableWorkspace({ tab }: { tab: WorkspaceTab }) {
  const loadTable = useStore((state) => state.loadTable);
  const loadStructure = useStore((state) => state.loadStructure);
  const setTableView = useStore((state) => state.setTableView);
  const updateCell = useStore((state) => state.updateCell);
  const deleteTableRows = useStore((state) => state.deleteTableRows);
  const insertTableRow = useStore((state) => state.insertTableRow);
  const toast = useStore((state) => state.toast);
  const session = useStore((state) => state.sessions[tab.sessionId]);
  const profile = useStore((state) => state.connections.find((item) => item.id === tab.sessionId));
  const tableMeta = useStore((state) =>
    (state.tables[`${tab.sessionId}::${tab.database}`] || []).find((item) => item.name === tab.table),
  );
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [searchDraft, setSearchDraft] = useState(tab.tableQuery?.search || '');
  const [draftFilters, setDraftFilters] = useState<TableFilter[]>([]);
  const [selectedCell, setSelectedCell] = useState<{ row: number; col: number } | null>(null);
  const [textViewOpen, setTextViewOpen] = useState(false);
  const [insertOpen, setInsertOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);
  const data = tab.tableData;
  const query = tab.tableQuery || { limit: PAGE_SIZE, offset: 0, filters: [], search: '', orderBy: null, orderDir: 'asc' as const };
  const readOnly = Boolean(profile?.readOnly);
  const openTableTool = useStore((state) => state.openTableTool);
  const devView = useStore((state) => state.appInfo?.devView);
  const autoFilter = devView === 'filter';
  const [filterOpen, setFilterOpen] = useState(autoFilter);

  useEffect(() => {
    setSelectedRows(new Set());
    setSelectedCell(null);
    setTextViewOpen(false);
  }, [data]);

  useEffect(() => {
    if (!autoFilter || !data || draftFilters.length > 0) return;
    setDraftFilters([{ column: data.columns[0]?.name || '', op: '=', value: '' }]);
  }, [autoFilter, data, draftFilters.length]);

  useEffect(() => {
    setSearchDraft(tab.tableQuery?.search || '');
  }, [tab.id]);

  useEffect(() => {
    if (searchDraft === (tab.tableQuery?.search || '')) return;
    const timer = setTimeout(() => {
      loadTable(tab.id, { search: searchDraft, offset: 0 });
    }, 320);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDraft]);

  useEffect(() => {
    if (!exportOpen) return;
    const close = (event: MouseEvent) => {
      if (!exportRef.current?.contains(event.target as Node)) setExportOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [exportOpen]);

  const toggleRow = (index: number) => {
    setSelectedRows((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };
  const toggleAll = () => {
    setSelectedRows((current) => {
      if (data && current.size === data.rows.length) return new Set();
      return new Set((data?.rows || []).map((_, index) => index));
    });
  };

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / query.limit));
  const page = Math.floor(query.offset / query.limit) + 1;

  const beginFilter = () => {
    if (filterOpen) {
      setFilterOpen(false);
      return;
    }
    const columns = data?.columns.map((column) => column.name) || [];
    setDraftFilters(
      query.filters.length
        ? query.filters.map((filter) => ({ ...filter }))
        : [{ column: columns[0] || '', op: '=', value: '' }],
    );
    setFilterOpen(true);
  };

  const addDraftFilter = () => {
    const columns = data?.columns.map((column) => column.name) || [];
    setDraftFilters((current) => [...current, { column: columns[0] || '', op: '=', value: '' }]);
  };

  const updateDraftFilter = (index: number, patch: Partial<TableFilter>) => {
    setDraftFilters((current) => current.map((filter, i) => (i === index ? { ...filter, ...patch } : filter)));
  };

  const removeDraftFilter = (index: number) => {
    setDraftFilters((current) => current.filter((_, i) => i !== index));
  };

  const applyFilters = () => {
    const filters = draftFilters.filter((filter) => {
      if (!filter.column) return false;
      if (!filterNeedsValue(filter.op)) return true;
      if (filterNeedsSecondValue(filter.op)) return Boolean(filter.value || filter.value2);
      return filter.value !== '' || filter.op === '=' || filter.op === '!=';
    });
    setDraftFilters(filters);
    loadTable(tab.id, { filters, offset: 0 });
  };

  const clearFilters = () => {
    setDraftFilters([]);
    loadTable(tab.id, { filters: [], offset: 0 });
  };

  const addFilter = (column: string, op: string, value: string) => {
    if (!column) return;
    const next: TableFilter = { column, op, value };
    const filters = [...query.filters.filter((item) => !(item.column === column && item.op === op)), next];
    setDraftFilters(filters);
    loadTable(tab.id, { filters, offset: 0 });
    setFilterOpen(true);
  };

  const removeFilter = (index: number) => {
    const filters = query.filters.filter((_, i) => i !== index);
    setDraftFilters(filters);
    loadTable(tab.id, { filters, offset: 0 });
  };

  const selectedValue: CellValue | undefined = selectedCell && data
    ? data.rows[selectedCell.row]?.[selectedCell.col]
    : undefined;
  const selectedColumn = selectedCell && data ? data.columns[selectedCell.col] : undefined;
  const canViewText =
    selectedValue === null || typeof selectedValue === 'string' || typeof selectedValue === 'number';

  const exportRows = async (format: 'csv' | 'json' | 'sql') => {
    if (!data) return;
    const rowsToExport = selectedRows.size
      ? data.rows.filter((_, index) => selectedRows.has(index))
      : data.rows;
    const result = await window.finch.exportData({
      format,
      columns: data.columns,
      rows: rowsToExport,
      filename: `${tab.table}-${new Date().toISOString().slice(0, 10)}`,
      table: tab.table,
    });
    setExportOpen(false);
    if (result.saved) toast('success', '导出完成', `${rowsToExport.length} 行 · ${result.filePath}`);
  };

  return (
    <div className="table-workspace">
      <div className="table-head">
        <div className="table-identity">
          <span className="table-identity-icon">
            {tab.tableView === 'structure' ? <Layers size={17} /> : <Table2 size={17} />}
          </span>
          <div>
            <div className="table-title-line">
              <h2>{tab.table}</h2>
              {tableMeta?.tableType === 'VIEW' && <span className="view-badge">VIEW</span>}
              {readOnly && <span className="readonly-badge"><Lock size={9} /> 只读</span>}
            </div>
            <span className="table-subtitle">
              <Database size={10} /> {tab.database}
              {tableMeta?.engine && <><span>·</span>{tableMeta.engine}</>}
              {tableMeta?.collation && <><span>·</span>{tableMeta.collation}</>}
              {tableMeta?.rowEstimate !== null && tableMeta?.rowEstimate !== undefined && (
                <><span>·</span>~{formatNumber(tableMeta.rowEstimate)} rows</>
              )}
            </span>
          </div>
        </div>

        <div className="table-head-actions">
          <Segmented
            value={tab.tableView === 'structure' ? 'structure' : 'data'}
            options={[
              { value: 'data', label: '数据' },
              { value: 'structure', label: '结构' },
            ]}
            onChange={(value) => setTableView(tab.id, value as 'data' | 'structure')}
          />
          <div className="toolbar-divider" />
          {tab.tableView === 'structure' ? (
            <>
              <button className="btn btn-ghost btn-sm" onClick={() => openTableTool({ mode: 'edit', sessionId: tab.sessionId, database: tab.database, table: tab.table! })}>
                <PencilLine size={13} /> 编辑表
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => openTableTool({ mode: 'dump', sessionId: tab.sessionId, database: tab.database, table: tab.table })}>
                <Download size={13} /> 转储
              </button>
              <IconButton icon={RefreshCw} label="刷新结构" size={15} onClick={() => loadStructure(tab.id, true)} />
            </>
          ) : (
            <>
              <IconButton icon={RefreshCw} label="刷新数据" size={15} onClick={() => loadTable(tab.id)} />
              <button className="btn btn-ghost btn-sm" onClick={() => setInsertOpen(true)} disabled={readOnly}>
                <Plus size={13} /> 新增行
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setDeleteOpen(true)}
                disabled={readOnly || selectedRows.size === 0}
              >
                <Trash2 size={13} /> 删除 {selectedRows.size > 0 ? selectedRows.size : ''}
              </button>
              <div className="export-wrap" ref={exportRef}>
                <button className="btn btn-ghost btn-sm" onClick={() => setExportOpen((open) => !open)}>
                  <Download size={13} /> 导出 <ChevronDown size={11} />
                </button>
                {exportOpen && (
                  <div className="popover-menu export-menu align-right">
                    <div className="export-scope">
                      <span className="mini-check is-on" />
                      {selectedRows.size
                        ? `仅导出选中的 ${selectedRows.size} 行`
                        : `导出当前页 ${data?.rows.length || 0} 行`}
                    </div>
                    <div className="context-divider" />
                    <button onClick={() => exportRows('csv')}>
                      <FileSpreadsheet size={14} /> CSV
                    </button>
                    <button onClick={() => exportRows('json')}>
                      <FileJson size={14} /> JSON
                    </button>
                    <button onClick={() => exportRows('sql')}>
                      <FileText size={14} /> SQL INSERT
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {tab.tableView === 'structure' ? (
        <StructureView tab={tab} />
      ) : (
        <>
          <div className="table-toolbar">
            <div className="table-search">
              <Search size={13} />
              <input
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
                placeholder={`在 ${tab.table} 中搜索…`}
                spellCheck={false}
              />
              {searchDraft && (
                <button onClick={() => setSearchDraft('')} aria-label="Clear">
                  <X size={12} />
                </button>
              )}
            </div>
            <button
              className={clsx('btn btn-ghost btn-sm filter-btn', (filterOpen || query.filters.length > 0) && 'is-active')}
              onClick={beginFilter}
              aria-expanded={filterOpen}
            >
              <Filter size={13} /> 筛选 {query.filters.length > 0 && <span className="filter-count">{query.filters.length}</span>}
            </button>
            <button
              className={clsx('btn btn-ghost btn-sm filter-btn', textViewOpen && 'is-active')}
              onClick={() => setTextViewOpen((open) => !open)}
              disabled={!canViewText}
              aria-expanded={textViewOpen}
              title={canViewText ? `在底部查看 ${selectedColumn?.name} 的完整文本` : '先点击一个文本单元格'}
            >
              <FileText size={13} /> 查看文本
            </button>
            <div className="table-toolbar-spacer" />
            {data?.primaryKeys.length ? (
              <span className="table-key-hint"><KeyRound size={11} /> PK: {data.primaryKeys.join(', ')}</span>
            ) : (
              <span className="table-key-hint is-warn"><AlertTriangle size={11} /> 无主键 · 行内编辑已禁用</span>
            )}
          </div>

          <div className={clsx('filter-panel', filterOpen && 'is-open')}>
            <div className="filter-panel-content">
              <div className="filter-panel-head">
                <span className="filter-panel-title"><Filter size={11} /> 筛选条件</span>
                <span className="filter-panel-logic">所有条件同时满足（AND）</span>
                <span className="filter-panel-spacer" />
                <button className="filter-clear" onClick={clearFilters}>清除全部</button>
              </div>
              <div className="filter-rows">
                {draftFilters.length === 0 && (
                  <div className="filter-empty">还没有条件，点击「添加条件」开始筛选。</div>
                )}
                {draftFilters.map((filter, index) => (
                  <div className="filter-row" key={`${filter.column}-${index}`}>
                    <Select
                      className="filter-select filter-column"
                      value={filter.column}
                      onChange={(value) => updateDraftFilter(index, { column: value })}
                      ariaLabel="筛选字段"
                      size="sm"
                      width={150}
                      options={(data?.columns || []).map((column) => ({ value: column.name, label: column.name }))}
                    />
                    <Select
                      className="filter-select filter-operator"
                      value={filter.op}
                      onChange={(value) => updateDraftFilter(index, { op: value })}
                      ariaLabel="筛选条件"
                      size="sm"
                      width={108}
                      options={FILTER_OPERATORS.map((operator) => ({ value: operator.value, label: operator.label }))}
                    />
                    {filterNeedsValue(filter.op) && (
                      <input
                        className="filter-control filter-value"
                        value={filter.value}
                        onChange={(event) => updateDraftFilter(index, { value: event.target.value })}
                        placeholder={filterIsMultiValue(filter.op) ? '值1, 值2' : filterNeedsSecondValue(filter.op) ? '起始值' : '值'}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') applyFilters();
                        }}
                        spellCheck={false}
                      />
                    )}
                    {filterNeedsSecondValue(filter.op) && (
                      <>
                        <span className="filter-between-label">和</span>
                        <input
                          className="filter-control filter-value"
                          value={filter.value2 || ''}
                          onChange={(event) => updateDraftFilter(index, { value2: event.target.value })}
                          placeholder="结束值"
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') applyFilters();
                          }}
                          spellCheck={false}
                        />
                      </>
                    )}
                    <button className="filter-row-remove" onClick={() => removeDraftFilter(index)} aria-label="删除条件">
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="filter-panel-actions">
                <button className="btn btn-ghost btn-sm" onClick={addDraftFilter}>
                  <Plus size={12} /> 添加条件
                </button>
                <span className="filter-panel-spacer" />
                <button className="btn btn-ghost btn-sm" onClick={() => setFilterOpen(false)}>收起</button>
                <button className="btn btn-primary btn-sm" onClick={applyFilters}>
                  <Check size={12} /> 应用筛选
                </button>
              </div>
            </div>
          </div>

          {!filterOpen && query.filters.length > 0 && (
            <div className="filter-chips">
              {query.filters.map((filter, index) => (
                <span key={`${filter.column}-${index}`} className="filter-chip">
                  <Filter size={10} />
                  <strong>{filter.column}</strong>
                  <span>{filterOperatorLabel(filter.op)}</span>
                  {filterNeedsValue(filter.op) && <span className="filter-chip-value">{filter.value}{filter.value2 ? ` 和 ${filter.value2}` : ''}</span>}
                  <button onClick={() => removeFilter(index)} aria-label="Remove filter"><X size={10} /></button>
                </span>
              ))}
              <button className="filter-clear" onClick={clearFilters}>清除全部</button>
            </div>
          )}

          <div className="table-grid-area">
            {tab.tableLoading ? (
              <TableSkeleton />
            ) : tab.error ? (
              <div className="table-error">
                <AlertTriangle size={20} />
                <h4>读取失败</h4>
                <p>{tab.error}</p>
                <button className="btn btn-ghost btn-sm" onClick={() => loadTable(tab.id)}>重试</button>
              </div>
            ) : data ? (
              <ResultGrid
                columns={data.columns}
                rows={data.rows}
                primaryKeys={data.primaryKeys}
                editable={!readOnly && data.primaryKeys.length > 0}
                selectable
                selectedRows={selectedRows}
                onToggleRow={toggleRow}
                onToggleAll={toggleAll}
                onEdit={(row, column, value) => updateCell(tab.id, row, column, value)}
                onFilterValue={(column, value) => addFilter(column, '=', value)}
                onViewText={(row, column) => {
                  setSelectedCell({ row, col: column });
                  setTextViewOpen(true);
                }}
                onSelectCell={(row, column) => setSelectedCell({ row, col: column })}
                emptyLabel="这张表还没有数据"
              />
            ) : null}
          </div>

          <TextDrawer
            open={textViewOpen}
            onClose={() => setTextViewOpen(false)}
            column={selectedColumn}
            value={selectedValue}
            table={`${tab.database}.${tab.table}`}
          />

          <div className="table-pagination">
            <span>
              {data?.total !== null && data?.total !== undefined
                ? `${(query.offset + 1).toLocaleString()}–${Math.min(query.offset + query.limit, data.total).toLocaleString()} / ${data.total.toLocaleString()}`
                : `${query.offset + 1}–${query.offset + (data?.rows.length || 0)}`}
            </span>
            <div className="pagination-controls">
              <button
                className="page-btn"
                disabled={page <= 1}
                onClick={() => loadTable(tab.id, { offset: Math.max(0, query.offset - query.limit) })}
              >
                <ChevronLeft size={13} />
              </button>
              <span className="page-number">{page} <span>/ {pages}</span></span>
              <button
                className="page-btn"
                disabled={page >= pages}
                onClick={() => loadTable(tab.id, { offset: query.offset + query.limit })}
              >
                <ChevronRight size={13} />
              </button>
            </div>
            <div className="table-limit">
              <span>每页</span>
              <Select
                value={query.limit}
                onChange={(value) => loadTable(tab.id, { limit: Number(value), offset: 0 })}
                size="sm"
                width={66}
                ariaLabel="每页行数"
                align="right"
                options={[100, 200, 500, 1000].map((value) => ({ value: String(value), label: String(value) }))}
              />
            </div>
          </div>

          <div className="table-statusbar">
            <span className={clsx('status-dot', session?.status === 'connected' ? 'status-connected' : 'status-offline')} />
            <span>{session?.status === 'connected' ? '已连接' : '未连接'}</span>
            <span className="result-status-sep">·</span>
            <span>{tab.database}.{tab.table}</span>
            <span className="result-status-spacer" />
            <span>{data?.rows.length ?? 0} rows on this page</span>
            <span>·</span>
            <span>{profile?.user}@{profile?.host}</span>
            {readOnly && <><span>·</span><span>只读模式</span></>}
          </div>

          {insertOpen && data && (
            <InsertRowModal
              open={insertOpen}
              onClose={() => setInsertOpen(false)}
              columns={data.columnMeta}
              table={tab.table!}
              onInsert={async (values) => {
                const ok = await insertTableRow(tab.id, values);
                if (ok) setInsertOpen(false);
              }}
            />
          )}

          <Modal
            open={deleteOpen}
            onClose={() => setDeleteOpen(false)}
            title="删除选中行"
            subtitle={`将从 ${tab.database}.${tab.table} 中永久删除 ${selectedRows.size} 行`}
            icon={<Trash2 size={18} />}
            size="sm"
            footer={
              <>
                <button className="btn btn-ghost" onClick={() => setDeleteOpen(false)}>取消</button>
                <button
                  className="btn btn-danger"
                  onClick={async () => {
                    const ok = await deleteTableRows(tab.id, [...selectedRows]);
                    if (ok) {
                      setDeleteOpen(false);
                      setSelectedRows(new Set());
                    }
                  }}
                >
                  确认删除
                </button>
              </>
            }
          >
            <div className="confirm-copy">
              <div className="danger-callout">
                <AlertTriangle size={16} />
                <span>此操作不可撤销。如果有外键约束，删除可能被数据库拒绝。</span>
              </div>
              <p>将根据主键（{data?.primaryKeys.join(', ')}）逐行删除，每行只会删除一次。</p>
            </div>
          </Modal>

        </>
      )}
    </div>
  );
}

function TextDrawer({
  open,
  onClose,
  column,
  value,
  table,
}: {
  open: boolean;
  onClose: () => void;
  column?: ResultColumn;
  value?: CellValue;
  table: string;
}) {
  const toast = useStore((state) => state.toast);
  const text =
    value === undefined
      ? ''
      : value === null
        ? 'NULL'
        : typeof value === 'object'
          ? `BLOB · ${value.size} bytes`
          : String(value);
  const json = typeof value === 'string' && isJsonLike(value);
  const [mode, setMode] = useState<'pretty' | 'raw'>('pretty');

  useEffect(() => {
    setMode(json ? 'pretty' : 'raw');
  }, [text, json]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const formatted = json && value !== undefined ? prettyJson(value) : null;
  const content = json && mode === 'pretty' && formatted ? formatted : text;
  const lines = content ? content.split('\n').length : 0;

  return (
    <div className={clsx('text-drawer', open && 'is-open')} aria-hidden={!open}>
      <div className="text-drawer-inner">
        <div className="text-drawer-head">
          <span className="text-drawer-title">
            <FileText size={12} />
            {column?.name || '单元格'}
          </span>
          <span className="text-drawer-meta">
            {table} · {column?.type || 'TEXT'} · {lines.toLocaleString()} 行 · {text.length.toLocaleString()} 字符
          </span>
          <span className="text-drawer-spacer" />
          {json ? (
            <Segmented
              value={mode}
              options={[
                { value: 'pretty', label: '格式化 JSON' },
                { value: 'raw', label: '原始文本' },
              ]}
              onChange={(next) => setMode(next as 'pretty' | 'raw')}
            />
          ) : (
            <span className="text-drawer-kind">纯文本</span>
          )}
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              navigator.clipboard.writeText(content);
              toast('success', '文本已复制');
            }}
          >
            <Copy size={12} /> 复制
          </button>
          <button className="text-drawer-close" onClick={onClose} aria-label="收起">
            <X size={13} />
          </button>
        </div>
        <pre className="text-drawer-content">{content || '（空文本）'}</pre>
      </div>
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="table-skeleton">
      <div className="skeleton-head"><span /><span /><span /><span /><span /></div>
      {Array.from({ length: 12 }).map((_, index) => (
        <div className="skeleton-row" key={index}>
          <span style={{ width: `${24 + ((index * 13) % 30)}%` }} />
          <span style={{ width: `${30 + ((index * 7) % 45)}%` }} />
          <span style={{ width: `${18 + ((index * 17) % 25)}%` }} />
          <span style={{ width: `${28 + ((index * 11) % 35)}%` }} />
        </div>
      ))}
    </div>
  );
}

function InsertRowModal({
  open,
  onClose,
  columns,
  table,
  onInsert,
}: {
  open: boolean;
  onClose: () => void;
  columns: ColumnInfo[];
  table: string;
  onInsert: (values: Record<string, string | null>) => Promise<void>;
}) {
  const editable = columns.filter((column) => !/GENERATED/i.test(column.extra));
  const [values, setValues] = useState<Record<string, string>>({});
  const [nulls, setNulls] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const basic = editable.filter((column) => !column.extra.toLowerCase().includes('auto_increment'));
  const advanced = editable.filter((column) => column.extra.toLowerCase().includes('auto_increment'));
  const visible = showAdvanced ? [...basic, ...advanced] : basic;

  const submit = async () => {
    const payload: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue;
      if (nulls.has(key)) payload[key] = null;
      else if (value !== '') payload[key] = value;
    }
    for (const key of nulls) payload[key] = null;
    setSaving(true);
    try {
      await onInsert(payload);
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, values, nulls]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`新增数据 · ${table}`}
      subtitle="留空的字段将使用数据库默认值；点击 ∅ 显式写入 NULL"
      icon={<Plus size={17} />}
      size="lg"
      footer={
        <>
          <span className="modal-foot-hint"><Kbd>⌘↵</Kbd> 提交</span>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? <Spinner size={13} /> : <Plus size={14} />} 插入行
          </button>
        </>
      }
    >
      <div className="insert-form">
        {visible.map((column) => {
          const isNull = nulls.has(column.name);
          return (
            <div className={clsx('insert-field', isNull && 'is-null')} key={column.name}>
              <div className="insert-label">
                <span className="insert-name">{column.name}</span>
                <span className="insert-type">{column.columnType}</span>
                {column.columnKey === 'PRI' && <span className="grid-pk">PK</span>}
                {column.nullable === 'YES' && (
                  <button
                    className={clsx('null-toggle', isNull && 'is-on')}
                    onClick={() => {
                      setNulls((current) => {
                        const next = new Set(current);
                        if (next.has(column.name)) next.delete(column.name);
                        else next.add(column.name);
                        return next;
                      });
                    }}
                    title="写入 NULL"
                  >
                    ∅ NULL
                  </button>
                )}
              </div>
              {isNull ? (
                <div className="insert-null-value">NULL</div>
              ) : /TEXT|JSON|BLOB/i.test(column.dataType) ? (
                <textarea
                  rows={2}
                  value={values[column.name] ?? ''}
                  onChange={(event) => setValues((current) => ({ ...current, [column.name]: event.target.value }))}
                  placeholder={column.defaultValue ?? column.comment ?? ''}
                  spellCheck={false}
                />
              ) : (
                <input
                  value={values[column.name] ?? ''}
                  onChange={(event) => setValues((current) => ({ ...current, [column.name]: event.target.value }))}
                  placeholder={column.defaultValue ?? column.comment ?? (column.extra || '')}
                  spellCheck={false}
                />
              )}
            </div>
          );
        })}
        {advanced.length > 0 && (
          <button className="advanced-toggle" onClick={() => setShowAdvanced((value) => !value)}>
            <ChevronDown size={12} className={showAdvanced ? 'is-open' : ''} />
            {showAdvanced ? '隐藏' : '显示'}自增字段 ({advanced.length})
          </button>
        )}
      </div>
    </Modal>
  );
}

function StructureView({ tab }: { tab: WorkspaceTab }) {
  const loadStructure = useStore((state) => state.loadStructure);
  const details = tab.tableDetails;
  const [section, setSection] = useState<'columns' | 'indexes' | 'relations' | 'ddl'>('columns');
  const [ddlPretty, setDdlPretty] = useState(true);
  const toast = useStore((state) => state.toast);
  const viewDdl = useMemo(() => {
    if (!details?.ddl) return '—';
    if (!ddlPretty) return details.ddl;
    try {
      return formatCreateTable(details.ddl);
    } catch {
      return details.ddl;
    }
  }, [details?.ddl, ddlPretty]);

  if (tab.structureLoading && !details) {
    return (
      <div className="structure-loading">
        <Loader2 size={20} className="spin" />
        <span>正在读取表结构…</span>
      </div>
    );
  }

  if (!details) {
    return (
      <div className="table-error">
        <AlertTriangle size={20} />
        <h4>结构不可用</h4>
        <button className="btn btn-ghost btn-sm" onClick={() => loadStructure(tab.id, true)}>重试</button>
      </div>
    );
  }

  return (
    <div className="structure-view">
      <div className="structure-summary">
        <div className="structure-stat"><span>字段</span><strong>{details.columns.length}</strong></div>
        <div className="structure-stat"><span>索引</span><strong>{new Set(details.indexes.map((item) => item.name)).size}</strong></div>
        <div className="structure-stat"><span>外键</span><strong>{new Set(details.foreignKeys.map((item) => item.name)).size}</strong></div>
        <div className="structure-stat"><span>触发器</span><strong>{details.triggers.length}</strong></div>
        <div className="structure-summary-spacer" />
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            navigator.clipboard.writeText(details.ddl);
            toast('success', 'DDL 已复制');
          }}
        >
          <Copy size={13} /> 复制 DDL
        </button>
      </div>

      <div className="structure-tabs">
        {[
          { id: 'columns', label: '列', icon: Columns3, count: details.columns.length },
          { id: 'indexes', label: '索引', icon: KeyRound, count: new Set(details.indexes.map((item) => item.name)).size },
          { id: 'relations', label: '关系与触发器', icon: Layers, count: details.foreignKeys.length + details.triggers.length },
          { id: 'ddl', label: 'DDL', icon: FileText },
        ].map((item) => (
          <button
            key={item.id}
            className={clsx('structure-tab', section === item.id && 'is-active')}
            onClick={() => setSection(item.id as typeof section)}
          >
            <item.icon size={13} />
            {item.label}
            {item.count !== undefined && <span>{item.count}</span>}
          </button>
        ))}
      </div>

      <div className="structure-body">
        {section === 'columns' && (
          <table className="structure-table">
            <thead>
              <tr>
                <th>#</th><th>名称</th><th>类型</th><th>可空</th><th>默认</th><th>键</th><th>额外</th><th>注释</th>
              </tr>
            </thead>
            <tbody>
              {details.columns.map((column) => (
                <tr key={column.name}>
                  <td className="muted">{column.position}</td>
                  <td><span className="column-name">{column.name}</span>{column.columnKey === 'PRI' && <span className="grid-pk">PK</span>}</td>
                  <td><code>{column.columnType}</code></td>
                  <td>{column.nullable === 'YES' ? <span className="nullable-yes">YES</span> : <span className="nullable-no">NO</span>}</td>
                  <td className="muted">{column.defaultValue === null ? <em>NULL</em> : String(column.defaultValue)}</td>
                  <td>{column.columnKey || '—'}</td>
                  <td className="muted">{column.extra || '—'}</td>
                  <td className="muted">{column.comment || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {section === 'indexes' && (
          <div className="index-list">
            {[...new Map(details.indexes.map((index) => [index.name, details.indexes.filter((item) => item.name === index.name)])).entries()].map(
              ([name, columns]) => (
                <div className="index-card" key={name}>
                  <div className="index-head">
                    <KeyRound size={13} />
                    <strong>{name}</strong>
                    {columns[0]?.unique ? <span className="index-badge is-unique">UNIQUE</span> : <span className="index-badge">INDEX</span>}
                    <span className="index-type">{columns[0]?.type}</span>
                  </div>
                  <div className="index-columns">
                    {columns.map((column) => (
                      <span key={column.column}>{column.column}<em>{column.sequence}</em></span>
                    ))}
                  </div>
                </div>
              ),
            )}
            {details.indexes.length === 0 && <div className="structure-empty">没有索引</div>}
          </div>
        )}

        {section === 'relations' && (
          <div className="relations">
            <h4>外键</h4>
            {details.foreignKeys.length === 0 ? (
              <div className="structure-empty">没有外键</div>
            ) : (
              details.foreignKeys.map((foreignKey) => (
                <div className="relation-card" key={`${foreignKey.name}-${foreignKey.columnName}`}>
                  <div className="relation-name">{foreignKey.name}</div>
                  <div className="relation-path">
                    <code>{foreignKey.columnName}</code>
                    <ChevronRight size={12} />
                    <code>{foreignKey.refDatabase}.{foreignKey.refTable}.{foreignKey.refColumn}</code>
                  </div>
                  <div className="relation-rules">ON UPDATE {foreignKey.onUpdate} · ON DELETE {foreignKey.onDelete}</div>
                </div>
              ))
            )}
            <h4>触发器</h4>
            {details.triggers.length === 0 ? (
              <div className="structure-empty">没有触发器</div>
            ) : (
              details.triggers.map((trigger) => (
                <div className="trigger-card" key={trigger.name}>
                  <div className="relation-name">{trigger.name}</div>
                  <div className="trigger-when">{trigger.timing} {trigger.event}</div>
                  <pre>{trigger.statement}</pre>
                </div>
              ))
            )}
          </div>
        )}

        {section === 'ddl' && (
          <div className="ddl-panel">
            <div className="ddl-head">
              <span>SHOW CREATE TABLE</span>
              <div className="ddl-head-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => setDdlPretty((value) => !value)}>
                  {ddlPretty ? '原始' : '格式化'}
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    navigator.clipboard.writeText(viewDdl);
                    toast('success', 'DDL 已复制');
                  }}
                >
                  <Copy size={12} /> 复制
                </button>
              </div>
            </div>
            <DdlViewer value={viewDdl} />
          </div>
        )}
      </div>
    </div>
  );
}
