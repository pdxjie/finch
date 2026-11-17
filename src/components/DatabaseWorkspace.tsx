import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  Database,
  Download,
  Eye,
  KeyRound,
  Layers,
  Link2,
  Loader2,
  MoreHorizontal,
  PencilLine,
  Plus,
  RefreshCw,
  Search,
  Table2,
  X,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useStore } from '../store';
import type { TableDetails, TableInfo, WorkspaceTab } from '../types';
import { formatBytes, formatNumber } from '../lib/format';
import { IconButton, Segmented } from './ui';
import { ContextMenu, type ContextMenuState } from './ContextMenu';
import { Select } from './Select';
import { DdlViewer } from './DdlViewer';
import { formatCreateTable } from '../lib/ddlFormat';

type Kind = 'table' | 'view';
type SortKey = 'name' | 'rows' | 'size';

const CARD_HEIGHT = 92;
const CARD_GAP = 10;
const CARD_MIN = 236;
const GRID_PADDING = 12;

export function DatabaseWorkspace({ tab }: { tab: WorkspaceTab }) {
  const session = useStore((state) => state.sessions[tab.sessionId]);
  const profile = useStore((state) => state.connections.find((item) => item.id === tab.sessionId));
  const tables = useStore((state) => state.tables[`${tab.sessionId}::${tab.database}`]);
  const views = useStore((state) => state.views[`${tab.sessionId}::${tab.database}`]);
  const loadTables = useStore((state) => state.loadTables);
  const openTable = useStore((state) => state.openTable);
  const newQuery = useStore((state) => state.newQuery);
  const refreshSchema = useStore((state) => state.refreshSchema);
  const openTableTool = useStore((state) => state.openTableTool);
  const updateTab = useStore((state) => state.updateTab);
  const toast = useStore((state) => state.toast);

  const [kind, setKind] = useState<Kind>(tab.dbKind || 'table');
  const [filter, setFilter] = useState(tab.dbFilter || '');
  const [sort, setSort] = useState<SortKey>(tab.dbSort || 'name');
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<string | null>(tab.dbSelected ?? null);
  const [checked, setChecked] = useState<Set<string>>(new Set(tab.dbChecked || []));
  const [details, setDetails] = useState<TableDetails | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailTab, setDetailTab] = useState<'overview' | 'ddl'>('overview');
  const [detailWidth, setDetailWidth] = useState(() => {
    const stored = Number(localStorage.getItem('finch.detailWidth'));
    return Number.isFinite(stored) && stored >= 320 ? Math.min(760, stored) : 392;
  });
  const [resizing, setResizing] = useState(false);
  const detailRequest = useRef(0);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [gridWidth, setGridWidth] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setGridWidth((current) => (Math.abs(current - width) > 1 ? width : current));
    });
    observer.observe(element);
    setGridWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  const columns = Math.max(
    1,
    Math.floor((Math.max(0, gridWidth - GRID_PADDING * 2) + CARD_GAP) / (CARD_MIN + CARD_GAP)),
  );

  const source = kind === 'table' ? tables : views;
  const loading = source === undefined;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [tab.id]);

  // Persist browser state on the tab so switching to a table and back keeps the
  // filter, sort, kind and selection exactly as the user left them.
  useEffect(() => {
    updateTab(tab.id, {
      dbKind: kind,
      dbFilter: filter,
      dbSort: sort,
      dbSelected: selected,
      dbChecked: [...checked],
    });
  }, [tab.id, kind, filter, sort, selected, checked, updateTab]);

  useEffect(() => {
    const timer = setTimeout(() => searchRef.current?.focus(), 80);
    return () => clearTimeout(timer);
  }, [tab.id]);

  const sessionStatus = session?.status;

  const selectedInfo = useMemo(
    () => [...(tables || []), ...(views || [])].find((item) => item.name === selected) || null,
    [tables, views, selected],
  );

  useEffect(() => {
    if (!selected || sessionStatus !== 'connected') {
      setDetails(null);
      return;
    }
    const request = ++detailRequest.current;
    setDetailLoading(true);
    window.finch.schema
      .tableDetails(tab.sessionId, tab.database, selected)
      .then((result) => {
        if (detailRequest.current === request) setDetails(result);
      })
      .catch(() => {
        if (detailRequest.current === request) setDetails(null);
      })
      .finally(() => {
        if (detailRequest.current === request) setDetailLoading(false);
      });
  }, [selected, tab.sessionId, tab.database, sessionStatus]);

  useEffect(() => {
    if (sessionStatus !== 'connected') return;
    if (!source) {
      loadTables(tab.sessionId, tab.database, kind).catch(() => []);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.sessionId, tab.database, kind, refreshKey, sessionStatus]);

  const rows = useMemo(() => {
    const list = [...(source || [])];
    const tokens = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const filtered = tokens.length
      ? list.filter((item) => {
          const haystack = `${item.name}\n${item.comment || ''}`.toLowerCase();
          return tokens.every((token) => haystack.includes(token));
        })
      : list;
    filtered.sort((a, b) => {
      if (sort === 'rows') return (b.rowEstimate ?? 0) - (a.rowEstimate ?? 0);
      if (sort === 'size') return b.dataLength + b.indexLength - (a.dataLength + a.indexLength);
      return a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
    });
    return filtered;
  }, [source, filter, sort]);

  const filteredNames = useMemo(() => rows.map((item) => item.name), [rows]);
  const allChecked = filteredNames.length > 0 && filteredNames.every((name) => checked.has(name));

  const toggleChecked = (name: string) => {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleAllChecked = () => {
    setChecked((current) => {
      const next = new Set(current);
      if (filteredNames.every((name) => next.has(name))) {
        filteredNames.forEach((name) => next.delete(name));
      } else {
        filteredNames.forEach((name) => next.add(name));
      }
      return next;
    });
  };

  const dumpChecked = () => {
    if (!checked.size) return;
    openTableTool({
      mode: 'dump',
      sessionId: tab.sessionId,
      database: tab.database,
      tables: [...checked],
    });
  };


  const rowCount = Math.ceil(rows.length / columns);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CARD_HEIGHT + CARD_GAP,
    overscan: 6,
  });

  useEffect(() => {
    virtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [kind, filter, sort]);

  const totalRows = useMemo(
    () => (tables || []).reduce((sum, item) => sum + (item.rowEstimate ?? 0), 0),
    [tables],
  );
  const totalBytes = useMemo(
    () => (tables || []).reduce((sum, item) => sum + item.dataLength + item.indexLength, 0),
    [tables],
  );

  const refresh = async () => {
    setRefreshing(true);
    try {
      await refreshSchema(tab.sessionId, tab.database);
      setRefreshKey((value) => value + 1);
    } finally {
      setRefreshing(false);
    }
  };

  const activeRow = selected || rows[0]?.name;
  const openStructure = (table: TableInfo) => {
    openTable(tab.sessionId, tab.database, table.name, 'structure');
  };

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = detailWidth;
    let latest = startWidth;
    setResizing(true);
    const onMove = (move: PointerEvent) => {
      latest = Math.min(760, Math.max(320, startWidth + (startX - move.clientX)));
      setDetailWidth(latest);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setResizing(false);
      localStorage.setItem('finch.detailWidth', String(latest));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const selectTable = (name: string) => {
    // Delay the detail panel slightly so a double-click can open the table
    // without flashing the side panel first.
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => {
      setSelected(name);
      setDetailTab('overview');
    }, 160);
  };

  const openTableNow = (name: string) => {
    if (clickTimer.current) clearTimeout(clickTimer.current);
    openTable(tab.sessionId, tab.database, name);
  };

  useEffect(
    () => () => {
      if (clickTimer.current) clearTimeout(clickTimer.current);
    },
    [],
  );

  const tableMenu = (table: TableInfo) => [
    {
      label: '浏览数据',
      icon: Table2,
      onClick: () => openTable(tab.sessionId, tab.database, table.name),
    },
    {
      label: '查看结构',
      icon: Layers,
      onClick: () => openStructure(table),
    },
    {
      label: '编辑表结构',
      icon: PencilLine,
      onClick: () =>
        openTableTool({ mode: 'edit', sessionId: tab.sessionId, database: tab.database, table: table.name }),
    },
    { divider: true },
    {
      label: '在新查询中打开',
      icon: Plus,
      onClick: () =>
        newQuery({
          sessionId: tab.sessionId,
          database: tab.database,
          sql: `SELECT * FROM \`${tab.database}\`.\`${table.name}\` LIMIT 100;`,
        }),
    },
    {
      label: '转储这张表',
      icon: Download,
      onClick: () =>
        openTableTool({ mode: 'dump', sessionId: tab.sessionId, database: tab.database, table: table.name }),
    },
    { divider: true },
    {
      label: '复制表名',
      icon: Table2,
      onClick: () => navigator.clipboard.writeText(table.name),
    },
  ];

  return (
    <div className="db-workspace">
      <div className="db-head">
        <span className="db-head-icon"><Database size={18} /></span>
        <div className="db-head-copy">
          <div className="db-head-title">
            <h2>{tab.database}</h2>
            <span className="db-head-badge">{profile?.name || tab.sessionId}</span>
            {session?.status !== 'connected' && <span className="readonly-badge">未连接</span>}
          </div>
          <span className="db-head-meta">
            {tables?.length ?? '—'} 张表 · {views?.length ?? '—'} 个视图
            {tables && tables.length > 0 && <> · ~{formatNumber(totalRows)} 行 · {formatBytes(totalBytes)}</>}
          </span>
        </div>
        <div className="db-head-actions">
          <button className="btn btn-ghost btn-sm" onClick={() => newQuery({ sessionId: tab.sessionId, database: tab.database })}>
            <Plus size={13} /> 新建查询
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => openTableTool({ mode: 'create', sessionId: tab.sessionId, database: tab.database })}
          >
            <Table2 size={13} /> 新建表
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => openTableTool({ mode: 'dump', sessionId: tab.sessionId, database: tab.database })}
          >
            <Download size={13} /> 转储
          </button>
          <IconButton
            icon={refreshing ? Loader2 : RefreshCw}
            label="刷新数据库"
            size={15}
            onClick={refresh}
          />
        </div>
      </div>

      <div className="db-toolbar">
        <div className="db-search">
          <Search size={13} />
          <input
            ref={searchRef}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="按表名筛选，空格分隔多个关键词…"
            spellCheck={false}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setFilter('');
              if (event.key === 'Enter' && activeRow) openTable(tab.sessionId, tab.database, activeRow);
            }}
          />
          {filter && (
            <button onClick={() => setFilter('')} aria-label="清除筛选">
              <X size={11} />
            </button>
          )}
        </div>
        <button className="db-select-all" onClick={toggleAllChecked} title="全选当前筛选结果">
          <span className={clsx('grid-check', allChecked && 'is-checked')}>{allChecked && <Check size={9} />}</span>
          全选
        </button>
        <div className="db-kind">
          <button className={clsx(kind === 'table' && 'is-active')} onClick={() => setKind('table')}>
            <Table2 size={12} /> 表 <span>{tables?.length ?? '—'}</span>
          </button>
          <button className={clsx(kind === 'view' && 'is-active')} onClick={() => setKind('view')}>
            <Eye size={12} /> 视图 <span>{views?.length ?? '—'}</span>
          </button>
        </div>
        <div className="db-toolbar-spacer" />
        {checked.size > 0 && (
          <div className="db-batch">
            <span>已选 {checked.size} 张</span>
            <button className="btn btn-primary btn-sm" onClick={dumpChecked}>
              <Download size={12} /> 批量转储
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setChecked(new Set())}>清除</button>
          </div>
        )}
        <span className="db-match">{filter ? `匹配 ${rows.length} / ${source?.length ?? 0}` : `${rows.length} 项`}</span>
        <div className="db-sort">
          <Select
            value={sort}
            onChange={(value) => setSort(value as SortKey)}
            size="sm"
            width={96}
            ariaLabel="排序方式"
            options={[
              { value: 'name', label: '按名称' },
              { value: 'rows', label: '按行数' },
              { value: 'size', label: '按大小' },
            ]}
          />
          {sort === 'name' ? <ArrowDown size={10} /> : <ArrowUp size={10} />}
        </div>
      </div>

      <div className="db-body">
        <div className="db-grid">
        <div className="db-grid-scroll" ref={scrollRef}>
          {sessionStatus !== 'connected' && !source ? (
            <div className="db-loading">
              <Loader2 size={16} className="spin" /> 正在连接数据库…
            </div>
          ) : loading ? (
            <div className="db-loading">
              <Loader2 size={16} className="spin" /> 正在读取{kind === 'table' ? '表' : '视图'}…
            </div>
          ) : rows.length === 0 ? (
            <div className="db-empty">
              <Database size={20} />
              <strong>{filter ? '没有匹配的表' : kind === 'table' ? '这个数据库还没有表' : '这个数据库还没有视图'}</strong>
              {filter ? (
                <button className="btn btn-ghost btn-sm" onClick={() => setFilter('')}>清除筛选</button>
              ) : kind === 'table' ? (
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => openTableTool({ mode: 'create', sessionId: tab.sessionId, database: tab.database })}
                >
                  <Table2 size={12} /> 新建第一张表
                </button>
              ) : null}
            </div>
          ) : (
            <div className="db-grid-body" style={{ height: Math.max(0, virtualizer.getTotalSize() - CARD_GAP) }}>
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const start = virtualRow.index * columns;
                const slice = rows.slice(start, start + columns);
                return (
                  <div
                    key={virtualRow.key}
                    className="db-grid-row"
                    style={{
                      transform: `translateY(${virtualRow.start}px)`,
                      gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                      gap: CARD_GAP,
                    }}
                  >
                    {slice.map((table) => {
                      const bytes = table.dataLength + table.indexLength;
                      const isView = kind === 'view' || table.tableType === 'VIEW';
                      return (
                        <div
                          key={table.name}
                          className={clsx(
                            'dbt-card',
                            selected === table.name && 'is-selected',
                            checked.has(table.name) && 'is-checked',
                          )}
                          onClick={(event) => {
                            if (event.metaKey || event.ctrlKey) toggleChecked(table.name);
                            else selectTable(table.name);
                          }}
                          onDoubleClick={() => openTableNow(table.name)}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            setSelected(table.name);
                            setDetailTab('overview');
                            setMenu({ x: event.clientX, y: event.clientY, items: tableMenu(table) });
                          }}
                        >
                          <div className="dbt-card-head">
                            <button
                              className={clsx('dbt-check grid-check', checked.has(table.name) && 'is-checked')}
                              title="选择用于批量转储"
                              onClick={(event) => {
                                event.stopPropagation();
                                toggleChecked(table.name);
                              }}
                            >
                              {checked.has(table.name) && <Check size={9} />}
                            </button>
                            <span className="dbt-card-icon">{isView ? <Eye size={12} /> : <Table2 size={12} />}</span>
                            <button
                              className="dbt-name"
                              title={table.comment ? `${table.name} · ${table.comment}` : table.name}
                              onClick={(event) => {
                                event.stopPropagation();
                                selectTable(table.name);
                              }}
                              onDoubleClick={(event) => {
                                event.stopPropagation();
                                openTableNow(table.name);
                              }}
                            >
                              {table.name}
                            </button>
                            <span className="dbt-card-type">{isView ? 'VIEW' : table.engine || 'TABLE'}</span>
                            <button
                              className="dbt-card-more"
                              title="更多操作"
                              onClick={(event) => {
                                event.stopPropagation();
                                const rect = event.currentTarget.getBoundingClientRect();
                                setMenu({ x: rect.left, y: rect.bottom + 4, items: tableMenu(table) });
                              }}
                            >
                              <MoreHorizontal size={14} />
                            </button>
                          </div>
                          <div className={clsx('dbt-card-comment', !table.comment && 'is-empty')}>
                            {table.comment || '无注释'}
                          </div>
                          <div className="dbt-card-foot">
                            <span className="dbt-card-stat">{table.rowEstimate === null ? '—' : `~${formatNumber(table.rowEstimate)}`} 行</span>
                            <span className="dbt-card-dot">·</span>
                            <span className="dbt-card-stat">{bytes > 0 ? formatBytes(bytes) : '—'}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        </div>
        <TableDetailPanel
          width={detailWidth}
          resizing={resizing}
          onResizeStart={startResize}
          open={Boolean(selected)}
          info={selectedInfo}
          details={details}
          loading={detailLoading}
          tab={detailTab}
          onTab={setDetailTab}
          database={tab.database}
          onClose={() => setSelected(null)}
          onOpen={() => selected && openTableNow(selected)}
          onCopy={(text) => {
            if (!text) return;
            navigator.clipboard.writeText(text);
            toast('success', 'DDL 已复制');
          }}
        />
      </div>

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}

      <div className="db-statusbar">
        <span className={clsx('status-dot', session?.status === 'connected' ? 'status-connected' : 'status-offline')} />
        <span>{session?.status === 'connected' ? '已连接' : '未连接'}</span>
        <span className="result-status-sep">·</span>
        <span>{tab.database}</span>
        <span className="result-status-spacer" />
        {filter && <span>筛选 “{filter}”</span>}
        <span>{profile?.user}@{profile?.host}</span>
        <button
          className="db-status-link"
          onClick={() => {
            navigator.clipboard.writeText(tab.database);
            toast('success', '数据库名已复制');
          }}
        >
          复制库名
        </button>
      </div>
    </div>
  );
}

function TableDetailPanel({
  open,
  width,
  resizing,
  onResizeStart,
  info,
  details,
  loading,
  tab,
  onTab,
  database,
  onClose,
  onOpen,
  onCopy,
}: {
  open: boolean;
  width: number;
  resizing: boolean;
  onResizeStart: (event: React.PointerEvent<HTMLDivElement>) => void;
  info: TableInfo | null;
  details: TableDetails | null;
  loading: boolean;
  tab: 'overview' | 'ddl';
  onTab: (tab: 'overview' | 'ddl') => void;
  database: string;
  onClose: () => void;
  onOpen: () => void;
  onCopy: (text: string) => void;
}) {
  const [ddlPretty, setDdlPretty] = useState(true);
  const viewDdl = useMemo(() => {
    if (!details?.ddl) return '—';
    if (!ddlPretty) return details.ddl;
    try {
      return formatCreateTable(details.ddl);
    } catch {
      return details.ddl;
    }
  }, [details?.ddl, ddlPretty]);
  const bytes = info ? info.dataLength + info.indexLength : 0;
  const indexGroups = useMemo(() => {
    const map = new Map<string, { name: string; unique: boolean; type: string; columns: string[] }>();
    for (const item of details?.indexes || []) {
      const existing = map.get(item.name);
      if (existing) existing.columns.push(item.column);
      else map.set(item.name, {
        name: item.name,
        unique: item.unique,
        type: item.type,
        columns: [item.column],
      });
    }
    return [...map.values()];
  }, [details]);

  return (
    <aside
      className={clsx('db-detail', open && 'is-open', resizing && 'is-resizing')}
      style={{ width: open ? width : 0, flexBasis: open ? width : 0 }}
      aria-hidden={!open}
    >
      <div className="db-detail-resizer" onPointerDown={onResizeStart} title="拖动调整宽度" />
      <div className="db-detail-inner">
        <header className="db-detail-head">
          <span className="db-detail-icon"><Table2 size={14} /></span>
          <div className="db-detail-title">
            <strong>{info?.name || '表详情'}</strong>
            <span>{database}{info?.comment ? ` · ${info.comment}` : ''}</span>
          </div>
          <button className="icon-btn is-compact" onClick={onClose} title="关闭详情">
            <X size={13} />
          </button>
        </header>

        {info && (
          <div className="db-detail-stats">
            <span><em>引擎</em>{info.engine || '—'}</span>
            <span><em>行数</em>{info.rowEstimate === null ? '—' : `~${formatNumber(info.rowEstimate)}`}</span>
            <span><em>大小</em>{bytes > 0 ? formatBytes(bytes) : '—'}</span>
            <span><em>排序规则</em>{info.collation || '—'}</span>
          </div>
        )}

        <div className="db-detail-tabs">
          <Segmented
            value={tab}
            options={[
              { value: 'overview', label: '明细' },
              { value: 'ddl', label: 'DDL' },
            ]}
            onChange={(value) => onTab(value as 'overview' | 'ddl')}
          />
          <span className="db-detail-spacer" />
          {loading && <Loader2 size={13} className="spin" />}
        </div>

        <div className={clsx('db-detail-body', tab === 'ddl' && 'is-ddl')}>
          {loading && !details ? (
            <div className="db-detail-loading"><Loader2 size={14} className="spin" /> 正在读取表结构…</div>
          ) : !details ? (
            <div className="db-detail-loading">暂时读不到这张表的明细</div>
          ) : tab === 'ddl' ? (
            <div className="db-ddl">
              <div className="db-ddl-head">
                <span>SHOW CREATE TABLE</span>
                <span className="db-detail-spacer" />
                <button className="btn btn-ghost btn-sm" onClick={() => setDdlPretty((value) => !value)}>
                  {ddlPretty ? '原始' : '格式化'}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => onCopy(viewDdl)}>
                  <Copy size={12} /> 复制
                </button>
              </div>
              <DdlViewer value={viewDdl} />
            </div>
          ) : (
            <>
              <section className="db-detail-section">
                <h4><Table2 size={11} /> 字段 <span>{details.columns.length}</span></h4>
                <div className="db-detail-columns">
                  {details.columns.map((column) => (
                    <div className="db-detail-column" key={column.name}>
                      <div className="db-detail-column-name">
                        <code>{column.name}</code>
                        {column.columnKey === 'PRI' && <span className="detail-badge is-pk">PK</span>}
                        {column.extra.toLowerCase().includes('auto_increment') && <span className="detail-badge">AI</span>}
                        <span className="db-detail-spacer" />
                        <button
                          className="db-detail-copy"
                          title="复制这个字段的定义"
                          onClick={(event) => {
                            event.stopPropagation();
                            const definition = [
                              `\`${column.name}\``,
                              column.columnType,
                              column.nullable === 'NO' ? 'NOT NULL' : 'NULL',
                              column.defaultValue !== null ? `DEFAULT ${column.defaultValue}` : '',
                              column.extra,
                            ]
                              .filter(Boolean)
                              .join(' ');
                            onCopy(definition);
                          }}
                        >
                          <Copy size={10} />
                        </button>
                      </div>
                      <div className="db-detail-column-type">
                        {column.columnType}
                        {column.nullable === 'NO' && <span className="detail-null">NOT NULL</span>}
                        {column.defaultValue !== null && <span className="detail-default">默认 {column.defaultValue}</span>}
                      </div>
                      {column.comment && <div className="db-detail-column-comment">{column.comment}</div>}
                    </div>
                  ))}
                </div>
              </section>

              <section className="db-detail-section">
                <h4><KeyRound size={11} /> 索引 <span>{indexGroups.length}</span></h4>
                {indexGroups.length === 0 && <p className="db-detail-empty">没有二级索引</p>}
                {indexGroups.map((index) => (
                  <div className="db-detail-index" key={index.name}>
                    <div className="db-detail-index-head">
                      <code>{index.name}</code>
                      {index.unique && <span className="detail-badge is-unique">UNIQUE</span>}
                      {index.type && <span className="detail-badge">{index.type}</span>}
                    </div>
                    <span className="db-detail-index-cols">{index.columns.join(', ')}</span>
                  </div>
                ))}
              </section>

              {details.foreignKeys.length > 0 && (
                <section className="db-detail-section">
                  <h4><Link2 size={11} /> 外键 <span>{details.foreignKeys.length}</span></h4>
                  {details.foreignKeys.map((fk) => (
                    <div className="db-detail-fk" key={`${fk.name}-${fk.columnName}`}>
                      <code>{fk.columnName}</code>
                      <span>→ {fk.refDatabase}.{fk.refTable}.{fk.refColumn}</span>
                      <em>ON UPDATE {fk.onUpdate} · ON DELETE {fk.onDelete}</em>
                    </div>
                  ))}
                </section>
              )}

              {details.triggers.length > 0 && (
                <section className="db-detail-section">
                  <h4><Layers size={11} /> 触发器 <span>{details.triggers.length}</span></h4>
                  {details.triggers.map((trigger) => (
                    <div className="db-detail-trigger" key={trigger.name}>
                      <code>{trigger.name}</code>
                      <span>{trigger.timing} {trigger.event}</span>
                    </div>
                  ))}
                </section>
              )}
            </>
          )}
        </div>

        <footer className="db-detail-foot">
          <button className="btn btn-primary btn-sm" onClick={onOpen} disabled={!info}>
            <Table2 size={12} /> 打开数据
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => onCopy(viewDdl)} disabled={!details?.ddl}>
            <Copy size={12} /> 复制 DDL
          </button>
        </footer>
      </div>
    </aside>
  );
}
