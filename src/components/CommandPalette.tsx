import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity,
  ArrowLeftRight,
  BookMarked,
  Command,
  Database,
  Download,
  FileCode2,
  History,
  Keyboard,
  Layers,
  Moon,
  PanelLeft,
  Play,
  Plus,
  Power,
  RefreshCw,
  Save,
  Search,
  Server,
  Settings2,
  Sparkles,
  Table2,
  Terminal,
  Unplug,
} from 'lucide-react';
import { clsx } from 'clsx';
import type { LucideIcon } from 'lucide-react';
import { useStore } from '../store';
import { fuzzyScore, splitSqlPreview } from '../lib/format';
import { Kbd } from './ui';

interface PaletteAction {
  id: string;
  label: string;
  detail?: string;
  section: string;
  icon: LucideIcon;
  shortcut?: string;
  keywords?: string;
  run: () => void | Promise<unknown>;
}

export function CommandPalette() {
  const open = useStore((state) => state.paletteOpen);
  return open ? <PaletteInner /> : null;
}

function PaletteInner() {
  const setOpen = useStore((state) => state.setPaletteOpen);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const state = useStore();

  useEffect(() => {
    setQuery('');
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const actions = useMemo<PaletteAction[]>(() => {
    const list: PaletteAction[] = [];
    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    const connected = Object.values(state.sessions).filter((session) => session.status === 'connected');
    const sessionId = state.activeConnectionId || connected[0]?.id;

    list.push(
      {
        id: 'new-query',
        label: '新建查询',
        detail: activeTab?.database ? `在 ${activeTab.database} 中` : '打开一个 SQL 编辑器',
        section: '操作',
        icon: FileCode2,
        shortcut: '⌘T',
        run: () => state.newQuery(),
      },
      {
        id: 'new-connection',
        label: '新建数据库连接',
        detail: 'MySQL、SSH 隧道、TLS',
        section: '操作',
        icon: Plus,
        shortcut: '⇧⌘N',
        run: () => state.setModal('connection'),
      },
      {
        id: 'toggle-sidebar',
        label: state.sidebarVisible ? '收起侧边栏' : '展开侧边栏',
        section: '操作',
        icon: PanelLeft,
        shortcut: '⌘B',
        run: () => state.toggleSidebar(),
      },
      {
        id: 'theme',
        label: state.themeResolved === 'dark' ? '切换到浅色模式' : '切换到深色模式',
        section: '操作',
        icon: Moon,
        shortcut: '⇧⌘L',
        run: () => state.toggleTheme(),
      },
      {
        id: 'settings',
        label: '打开设置',
        section: '操作',
        icon: Settings2,
        shortcut: '⌘,',
        run: () => state.setModal('settings'),
      },
      {
        id: 'shortcuts',
        label: '查看键盘快捷键',
        section: '操作',
        icon: Keyboard,
        run: () => state.setModal('shortcuts'),
      },
    );

    if (activeTab?.kind === 'query') {
      list.push({
        id: 'save-query',
        label: '保存当前查询',
        detail: splitSqlPreview(activeTab.sql, 56),
        section: '当前标签',
        icon: Save,
        shortcut: '⌘S',
        run: () => state.requestSaveQuery(activeTab.id),
      });
    }
    if (activeTab?.database) {
      list.push({
        id: 'browse-database',
        label: `浏览 ${activeTab.database} 的表`,
        detail: '在标签页中列出全部表和视图，可按表名筛选',
        section: '当前标签',
        icon: Database,
        run: () => state.openDatabase(activeTab.sessionId, activeTab.database),
      });
    }
    if (activeTab?.kind === 'table' && activeTab.table) {
      list.push(
        {
          id: 'table-structure',
          label: `查看 ${activeTab.table} 的结构`,
          detail: `${activeTab.database}.${activeTab.table}`,
          section: '当前标签',
          icon: Layers,
          run: () => state.setTableView(activeTab.id, 'structure'),
        },
        {
          id: 'table-data',
          label: `浏览 ${activeTab.table} 数据`,
          detail: `${activeTab.database}.${activeTab.table}`,
          section: '当前标签',
          icon: Table2,
          run: () => state.setTableView(activeTab.id, 'data'),
        },
      );
    }
    if (activeTab?.kind === 'query') {
      list.push({
        id: 'ai',
        label: 'AI 生成 SQL',
        detail: '读取当前数据库真实 schema，再用自然语言生成',
        section: '当前标签',
        icon: Sparkles,
        shortcut: '⇧⌘A',
        run: () => state.setAiOpen(true),
      });
    } else if (activeTab?.sessionId) {
      list.push({
        id: 'ai',
        label: 'AI 生成 SQL',
        detail: '在新查询中打开 AI',
        section: '当前标签',
        icon: Sparkles,
        shortcut: '⇧⌘A',
        run: async () => {
          const id = await state.newQuery({
            sessionId: activeTab.sessionId,
            database: activeTab.database,
            title: 'AI 查询',
            sql: '-- 用自然语言生成 SQL，然后在编辑器中检查并运行。',
          });
          if (id) state.setAiOpen(true);
        },
      });
    }
    if (sessionId) {
      list.push(
        {
          id: 'sync',
          label: '数据同步',
          detail: '只同步到本地 / 开发环境，保护目标 DDL',
          section: '数据',
          icon: ArrowLeftRight,
          run: () => state.setSyncOpen(true),
        },
      );
      if (activeTab?.database) {
        list.push(
          {
            id: 'new-table',
            label: '新建表',
            detail: activeTab.database,
            section: '数据',
            icon: Table2,
            run: () => state.openTableTool({ mode: 'create', sessionId, database: activeTab.database }),
          },
          {
            id: 'dump-db',
            label: '转储当前数据库',
            detail: activeTab.database,
            section: '数据',
            icon: Download,
            run: () => state.openTableTool({ mode: 'dump', sessionId, database: activeTab.database }),
          },
        );
      }
      list.push(
        {
          id: 'dashboard',
          label: '服务器概览',
          detail: `${state.connections.find((item) => item.id === sessionId)?.name || 'MySQL'} 实时指标与进程`,
          section: '操作',
          icon: Activity,
          run: () => state.openDashboard(sessionId),
        },
        {
          id: 'refresh',
          label: '刷新数据库结构',
          section: '操作',
          icon: RefreshCw,
          run: () => state.refreshSchema(sessionId, activeTab?.database),
        },
      );
    }

    for (const connection of state.connections) {
      const session = state.sessions[connection.id];
      const online = session?.status === 'connected';
      list.push({
        id: `connect-${connection.id}`,
        label: `${online ? '断开' : '连接'} ${connection.name}`,
        detail: `${connection.user}@${connection.host}:${connection.port}`,
        section: '连接',
        icon: online ? Unplug : Power,
        keywords: `${connection.group} ${connection.database}`,
        run: () => (online ? state.disconnect(connection.id) : state.connect(connection.id)),
      });
    }

    const tableActions: PaletteAction[] = [];
    const addTables = (cache: Record<string, { name: string; tableType: string }[]>, kind: 'table' | 'view') => {
      for (const [key, tables] of Object.entries(cache)) {
        const split = key.indexOf('::');
        const connId = key.slice(0, split);
        const database = key.slice(split + 2);
        const connection = state.connections.find((item) => item.id === connId);
        if (!connection) continue;
        for (const table of tables.slice(0, 400)) {
          tableActions.push({
            id: `table-${connId}-${database}-${table.name}`,
            label: table.name,
            detail: `${connection.name} / ${database}`,
            section: '表',
            icon: kind === 'view' ? Layers : Table2,
            keywords: `${database} ${connection.name}`,
            run: async () => {
              const session = await state.connect(connId);
              if (session) await state.openTable(connId, database, table.name);
            },
          });
        }
      }
    };
    addTables(state.tables, 'table');
    addTables(state.views, 'view');
    list.push(...tableActions);

    for (const item of state.history.slice(0, 5)) {
      list.push({
        id: `history-${item.id}`,
        label: splitSqlPreview(item.sql, 76),
        detail: `${item.connectionName} · ${item.database || '—'}`,
        section: '历史',
        icon: History,
        keywords: item.sql,
        run: () => state.openHistory(item),
      });
    }

    if (/^\s*(select|with|show|describe|desc|explain|insert|update|delete|create|alter)\b/i.test(query)) {
      const sql = query;
      const database = activeTab?.database || '';
      list.unshift({
        id: 'run-adhoc',
        label: '作为新查询运行',
        detail: splitSqlPreview(sql, 84),
        section: 'SQL',
        icon: Play,
        shortcut: '↵',
        run: async () => {
          const tabId = await state.newQuery({ sessionId, database, sql, title: '即席查询' });
          if (tabId) await state.runQuery(tabId, sql);
        },
      });
    }

    return list;
  }, [query, state]);

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) return actions.filter((action) => action.section !== '表').slice(0, 30);
    return actions
      .map((action) => ({
        action,
        score: Math.max(
          fuzzyScore(q, action.label),
          fuzzyScore(q, `${action.keywords || ''} ${action.detail || ''}`) * 0.7,
        ),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40)
      .map((item) => item.action);
  }, [actions, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    const element = listRef.current?.querySelector<HTMLElement>('.palette-item.is-active');
    element?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const execute = async (action: PaletteAction) => {
    setOpen(false);
    try {
      await action.run();
    } catch (error) {
      state.toast('error', '操作失败', error instanceof Error ? error.message : String(error));
    }
  };

  let lastSection = '';
  return createPortal(
    <div className="palette-backdrop" onMouseDown={() => setOpen(false)}>
      <div className="palette" onMouseDown={(event) => event.stopPropagation()} role="dialog">
        <div className="palette-input-wrap">
          <Search size={17} />
          <input
            ref={inputRef}
            value={query}
            placeholder="搜索表、命令，或直接输入 SQL…"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex((index) => Math.min(results.length - 1, index + 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex((index) => Math.max(0, index - 1));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                if (results[activeIndex]) execute(results[activeIndex]);
              } else if (event.key === 'Escape') {
                setOpen(false);
              }
            }}
          />
          <span className="palette-badge"><Command size={10} /> K</span>
        </div>
        <div className="palette-results" ref={listRef}>
          {results.length === 0 ? (
            <div className="palette-empty">
              <Terminal size={20} />
              <p>没有找到 “{query}”</p>
              <span>试试表名、连接名，或直接粘贴一条 SQL。</span>
            </div>
          ) : (
            results.map((action, index) => {
              const showSection = action.section !== lastSection;
              lastSection = action.section;
              return (
                <div key={action.id}>
                  {showSection && <div className="palette-section">{action.section}</div>}
                  <button
                    className={clsx('palette-item', index === activeIndex && 'is-active')}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => execute(action)}
                  >
                    <span className={clsx('palette-icon', `palette-${action.section}`)}>
                      <action.icon size={15} />
                    </span>
                    <span className="palette-copy">
                      <span className="palette-label">{action.label}</span>
                      {action.detail && <span className="palette-detail">{action.detail}</span>}
                    </span>
                    {action.shortcut && <Kbd>{action.shortcut}</Kbd>}
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="palette-foot">
          <span><Kbd>↑</Kbd><Kbd>↓</Kbd> 导航</span>
          <span><Kbd>↵</Kbd> 执行</span>
          <span><Kbd>esc</Kbd> 关闭</span>
          <span className="palette-foot-spacer" />
          <span className="palette-brand"><Sparkles size={11} /> Finch</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
