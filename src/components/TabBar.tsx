import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ChevronDown,
  Database,
  FileCode2,
  MoreHorizontal,
  PanelLeft,
  Plus,
  Table2,
  X,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useStore } from '../store';
import type { WorkspaceTab } from '../types';

const TAB_ICON = {
  query: FileCode2,
  table: Table2,
  dashboard: Activity,
  database: Database,
};

export function TabBar() {
  const tabs = useStore((state) => state.tabs);
  const activeTabId = useStore((state) => state.activeTabId);
  const activateTab = useStore((state) => state.activateTab);
  const closeTab = useStore((state) => state.closeTab);
  const closeOtherTabs = useStore((state) => state.closeOtherTabs);
  const newQuery = useStore((state) => state.newQuery);
  const toggleSidebar = useStore((state) => state.toggleSidebar);
  const updateTab = useStore((state) => state.updateTab);
  const [editing, setEditing] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menuOpen]);

  useEffect(() => {
    const el = scrollRef.current?.querySelector<HTMLElement>('.tab.is-active');
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId]);

  return (
    <div
      className="tabbar"
      onDoubleClick={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest('.tab, .tabbar-actions, button, input')) return;
        newQuery();
      }}
    >
      <div className="tab-scroll" ref={scrollRef} title="双击空白处新建查询">
        {tabs.map((tab) => {
          const Icon = TAB_ICON[tab.kind];
          const active = tab.id === activeTabId;
          const dirty = tab.kind === 'query' && tab.sql.trim().length > 0 && !tab.savedQueryId;
          return (
            <div
              key={tab.id}
              className={clsx('tab', active && 'is-active')}
              onMouseDown={(event) => {
                if (event.button === 0) activateTab(tab.id);
              }}
              onDoubleClick={() => {
                if (tab.kind === 'query') setEditing(tab.id);
              }}
              title={tab.table ? `${tab.database}.${tab.table}` : tab.kind === 'database' ? `数据库 ${tab.database}` : tab.title}
            >
              <Icon size={13} className="tab-icon" />
              {editing === tab.id ? (
                <input
                  className="tab-rename"
                  autoFocus
                  defaultValue={tab.title}
                  onBlur={(event) => {
                    updateTab(tab.id, { title: event.target.value.trim() || tab.title });
                    setEditing(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
                    if (event.key === 'Escape') setEditing(null);
                  }}
                />
              ) : (
                <span className={clsx('tab-title', dirty && 'is-dirty')}>{tab.title}</span>
              )}
              {tab.running && <span className="tab-running" />}
              <button
                className="tab-close"
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.id);
                }}
                aria-label="Close tab"
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="tabbar-actions">
        <button className="tab-new" onClick={() => newQuery()} title="新建查询  ⌘T">
          <Plus size={15} />
        </button>
        <button className="tab-new" onClick={toggleSidebar} title="切换侧边栏  ⌘B">
          <PanelLeft size={14} />
        </button>
        <div className="tabbar-menu-wrap" ref={menuRef}>
          <button className="tab-new" onClick={() => setMenuOpen((open) => !open)} title="更多">
            <MoreHorizontal size={15} />
          </button>
          {menuOpen && (
            <div className="popover-menu tabbar-popover">
              <button
                onClick={() => {
                  activeTabId && closeOtherTabs(activeTabId);
                  setMenuOpen(false);
                }}
              >
                关闭其他标签页
              </button>
              <button
                onClick={() => {
                  [...tabs].reverse().forEach((tab) => closeTab(tab.id));
                  setMenuOpen(false);
                }}
              >
                关闭全部标签页
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
