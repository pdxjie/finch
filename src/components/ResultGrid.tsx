import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowDown,
  ArrowUp,
  Braces,
  Check,
  ChevronDown,
  Clipboard,
  Columns3,
  Copy,
  Database,
  FileJson,
  Eye,
  Filter,
  Pencil,
  Rows3,
  Table2,
  X,
} from 'lucide-react';
import { clsx } from 'clsx';
import type { CellValue, ResultColumn } from '../types';
import { cellText, copyText, isJsonLike, isNumericType, tableColumnWidths } from '../lib/format';
import { useStore } from '../store';

interface ResultGridProps {
  columns: ResultColumn[];
  rows: CellValue[][];
  primaryKeys?: string[];
  editable?: boolean;
  selectable?: boolean;
  selectedRows?: Set<number>;
  onToggleRow?: (index: number) => void;
  onToggleAll?: () => void;
  onEdit?: (rowIndex: number, columnIndex: number, value: string | null) => Promise<boolean>;
  onFilterValue?: (column: string, value: string) => void;
  onViewText?: (rowIndex: number, columnIndex: number) => void;
  onSelectCell?: (rowIndex: number, columnIndex: number, value: CellValue) => void;
  emptyLabel?: string;
  autoFocus?: boolean;
}

const ROW_NUMS_WIDTH = 52;
const SELECT_WIDTH = 36;

interface CellMenu {
  x: number;
  y: number;
  rowIndex: number;
  columnIndex: number;
}

function CopyMenu({ menu, onClose, columns, rows, editable, onEdit, onFilterValue, onViewText }: {
  menu: CellMenu;
  onClose: () => void;
  columns: ResultColumn[];
  rows: CellValue[][];
  editable?: boolean;
  onEdit?: (rowIndex: number, columnIndex: number, value: string | null) => Promise<boolean>;
  onFilterValue?: (column: string, value: string) => void;
  onViewText?: (rowIndex: number, columnIndex: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const toast = useStore((state) => state.toast);
  const value = rows[menu.rowIndex]?.[menu.columnIndex];
  const column = columns[menu.columnIndex];
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast('success', label);
    onClose();
  };
  const tsv = rows[menu.rowIndex].map(copyText).join('\t');
  const json = JSON.stringify(
    Object.fromEntries(columns.map((col, index) => [col.name, rows[menu.rowIndex][index]])),
    null,
    2,
  );
  const insert = `INSERT INTO \`table\` (${columns.map((col) => `\`${col.name}\``).join(', ')}) VALUES (${rows[menu.rowIndex]
    .map((cell) =>
      cell === null
        ? 'NULL'
        : typeof cell === 'object'
          ? 'NULL'
          : typeof cell === 'number'
            ? cell
            : `'${String(cell).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`,
    )
    .join(', ')});`;
  const x = Math.min(menu.x, window.innerWidth - 220);
  const y = Math.min(menu.y, window.innerHeight - 260);
  return (
    <div className="context-menu cell-menu" style={{ left: x, top: y }} ref={ref}>
      <div className="cell-menu-head">
        <span>{column?.name}</span>
        <span>{column?.type}</span>
      </div>
      <button className="context-item" onClick={() => copy(copyText(value), '单元格已复制')}>
        <Copy size={14} /> 复制值
      </button>
      <button className="context-item" onClick={() => copy(tsv, '整行已复制')}>
        <Rows3 size={14} /> 复制整行 <span className="context-hint">TSV</span>
      </button>
      <button className="context-item" onClick={() => copy(json, 'JSON 已复制')}>
        <FileJson size={14} /> 复制为 JSON
      </button>
      <button className="context-item" onClick={() => copy(insert, 'INSERT 已复制')}>
        <Clipboard size={14} /> 复制为 INSERT
      </button>
      {isJsonLike(value) && (
        <button
          className="context-item"
          onClick={() => {
            const pretty = JSON.stringify(JSON.parse(String(value)), null, 2);
            copy(pretty, '格式化 JSON 已复制');
          }}
        >
          <Braces size={14} /> 复制格式化 JSON
        </button>
      )}
      {onViewText && typeof value === 'string' && (
        <button
          className="context-item"
          onClick={() => {
            onViewText(menu.rowIndex, menu.columnIndex);
            onClose();
          }}
        >
          <Eye size={14} /> 查看完整文本
        </button>
      )}
      {onFilterValue && value !== null && typeof value !== 'object' && (
        <>
          <div className="context-divider" />
          <button className="context-item" onClick={() => { onFilterValue(column.name, String(value)); onClose(); }}>
            <Filter size={14} /> 按此值筛选
          </button>
        </>
      )}
      {editable && onEdit && (
        <>
          <div className="context-divider" />
          <button
            className="context-item"
            onClick={() => {
              onEdit(menu.rowIndex, menu.columnIndex, null);
              onClose();
            }}
          >
            <X size={14} /> 设为 NULL
          </button>
        </>
      )}
    </div>
  );
}

export function ResultGrid({
  columns,
  rows,
  primaryKeys = [],
  editable,
  selectable,
  selectedRows,
  onToggleRow,
  onToggleAll,
  onEdit,
  onFilterValue,
  onViewText,
  onSelectCell,
  emptyLabel = '查询没有返回任何行',
  autoFocus,
}: ResultGridProps) {
  const density = useStore((state) => state.settings.gridDensity);
  const toast = useStore((state) => state.toast);
  const rowHeight = density === 'compact' ? 27 : 32;
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState<number[]>(() => tableColumnWidths(columns, rows));
  const [sort, setSort] = useState<{ column: number; dir: 'asc' | 'desc' } | null>(null);
  const [selectedCell, setSelectedCell] = useState<{ row: number; col: number } | null>(null);
  const [editing, setEditing] = useState<{ row: number; col: number; value: string } | null>(null);
  const [menu, setMenu] = useState<CellMenu | null>(null);
  const [hiddenColumns, setHiddenColumns] = useState<Set<number>>(new Set());
  const [columnsOpen, setColumnsOpen] = useState(false);
  const columnsRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const editingRef = useRef<{ row: number; col: number } | null>(null);
  const columnSignature = useMemo(
    () => columns.map((column, index) => `${index}:${column.name}:${column.type}`).join('|'),
    [columns],
  );
  const visibleIndexes = useMemo(
    () => columns.map((_, index) => index).filter((index) => !hiddenColumns.has(index)),
    [columns, hiddenColumns],
  );
  const visibleWidths = visibleIndexes.map((index) => widths[index] ?? 120);

  useEffect(() => {
    setHiddenColumns(new Set());
    setColumnsOpen(false);
  }, [columnSignature]);

  useEffect(() => {
    if (!columnsOpen) return;
    const close = (event: MouseEvent) => {
      if (!columnsRef.current?.contains(event.target as Node)) setColumnsOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [columnsOpen]);

  useEffect(() => {
    if (selectedCell && hiddenColumns.has(selectedCell.col)) setSelectedCell(null);
  }, [hiddenColumns, selectedCell]);

  useEffect(() => {
    setWidths(tableColumnWidths(columns, rows));
    setSort(null);
    setSelectedCell(null);
    editingRef.current = null;
    setEditing(null);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [columns, rows]);

  useEffect(() => {
    if (!editing) return;
    requestAnimationFrame(() => {
      const input = editInputRef.current;
      if (!input) return;
      input.focus();
      const end = input.value.length;
      // Enter edit mode with the caret at the end instead of selecting all:
      // double-click should let people tweak the existing value.
      input.setSelectionRange(end, end);
    });
  }, [editing]);

  useEffect(() => {
    if (autoFocus) shellRef.current?.focus();
  }, [autoFocus]);

  const sortedRows = useMemo(() => {
    if (!sort) return rows.map((row, index) => ({ row, index }));
    const { column, dir } = sort;
    const factor = dir === 'asc' ? 1 : -1;
    return rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => {
        const left = a.row[column];
        const right = b.row[column];
        if (left === null && right === null) return 0;
        if (left === null) return 1;
        if (right === null) return -1;
        if (typeof left === 'number' && typeof right === 'number') return (left - right) * factor;
        return String(left).localeCompare(String(right), 'zh-CN', { numeric: true }) * factor;
      });
  }, [rows, sort]);

  const virtualizer = useVirtualizer({
    count: sortedRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 18,
  });

  const columnTemplate = `${ROW_NUMS_WIDTH}px ${selectable ? `${SELECT_WIDTH}px ` : ''}${visibleWidths
    .map((width) => `${width}px`)
    .join(' ')}`;
  const totalWidth = ROW_NUMS_WIDTH + (selectable ? SELECT_WIDTH : 0) + visibleWidths.reduce((sum, width) => sum + width, 0);

  const beginResize = (index: number, event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = widths[index];
    const onMove = (moveEvent: PointerEvent) => {
      const next = Math.max(74, Math.min(640, startWidth + moveEvent.clientX - startX));
      setWidths((current) => current.map((value, i) => (i === index ? next : value)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const toggleSort = (index: number) => {
    setSort((current) => {
      if (!current || current.column !== index) return { column: index, dir: 'asc' };
      if (current.dir === 'asc') return { column: index, dir: 'desc' };
      return null;
    });
  };

  const commitEdit = async (value: string | null) => {
    if (!editingRef.current || !onEdit) return;
    const { row, col } = editingRef.current;
    editingRef.current = null;
    const original = rows[row]?.[col];
    setEditing(null);
    if (value === null) {
      if (original === null) return;
    } else if (original !== null && String(original) === value) return;
    await onEdit(row, col, value);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!shellRef.current?.contains(document.activeElement) && document.activeElement !== shellRef.current) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c' && selectedCell) {
        const value = sortedRows[selectedCell.row]?.row[selectedCell.col];
        if (value !== undefined) {
          navigator.clipboard.writeText(copyText(value));
          toast('success', '单元格已复制');
          event.preventDefault();
        }
      }
      if (event.key === 'Escape') {
        setSelectedCell(null);
        setMenu(null);
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        if (!selectedCell) {
          setSelectedCell({ row: 0, col: visibleIndexes[0] ?? 0 });
          event.preventDefault();
          return;
        }
        const delta =
          event.key === 'ArrowDown'
            ? { row: 1, col: 0 }
            : event.key === 'ArrowUp'
              ? { row: -1, col: 0 }
              : event.key === 'ArrowRight'
                ? { row: 0, col: 1 }
                : { row: 0, col: -1 };
        const position = Math.max(0, visibleIndexes.indexOf(selectedCell.col));
        const nextPosition = Math.max(0, Math.min(visibleIndexes.length - 1, position + delta.col));
        const next = {
          row: Math.max(0, Math.min(sortedRows.length - 1, selectedCell.row + delta.row)),
          col: visibleIndexes[nextPosition] ?? selectedCell.col,
        };
        setSelectedCell(next);
        virtualizer.scrollToIndex(next.row, { align: 'auto' });
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedCell, sortedRows, visibleIndexes, virtualizer, toast]);

  if (!columns.length) {
    return (
      <div className="grid-empty">
        <Check size={18} />
        <span>{emptyLabel}</span>
      </div>
    );
  }

  if (!visibleIndexes.length) {
    return (
      <div className="grid-empty">
        <Columns3 size={18} />
        <span>所有列已隐藏</span>
        <button className="btn btn-ghost btn-sm" onClick={() => setHiddenColumns(new Set())}>显示全部列</button>
      </div>
    );
  }

  return (
    <div className="result-grid" ref={shellRef} tabIndex={0}>
      <div className="grid-header-viewport" ref={headerRef}>
        <div className="grid-header" style={{ gridTemplateColumns: columnTemplate, width: totalWidth }}>
          <div className="grid-corner">#</div>
          {selectable && (
            <div className="grid-select-cell">
              <button
                className={clsx('grid-check', selectedRows && selectedRows.size > 0 && 'is-checked')}
                onClick={onToggleAll}
                aria-label="Select all"
              >
                {selectedRows && selectedRows.size > 0 && <Check size={10} />}
              </button>
            </div>
          )}
          {visibleIndexes.map((index) => {
            const column = columns[index];
            const isSorted = sort?.column === index;
            return (
              <div
                key={`${column.name}-${index}`}
                className="grid-header-cell"
                title={`${column.name} · ${column.type}`}
                onClick={() => toggleSort(index)}
              >
                <span className="grid-col-name">{column.name}</span>
                <span className="grid-col-type">{column.type}</span>
                {primaryKeys.includes(column.name) && <span className="grid-pk">PK</span>}
                {isSorted && <span className="grid-sort">{sort?.dir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />}</span>}
                <span className="col-resize" onPointerDown={(event) => beginResize(index, event)} />
              </div>
            );
          })}
        </div>
      </div>

      <div
        className="grid-scroll"
        ref={scrollRef}
        onScroll={(event) => {
          if (headerRef.current) headerRef.current.scrollLeft = event.currentTarget.scrollLeft;
        }}
      >
        <div className="grid-body" style={{ height: virtualizer.getTotalSize(), width: totalWidth }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const entry = sortedRows[virtualRow.index];
            const row = entry.row;
            const selected = selectedRows?.has(entry.index);
            return (
              <div
                key={virtualRow.key}
                className={clsx('grid-row', selected && 'is-selected')}
                style={{
                  transform: `translateY(${virtualRow.start}px)`,
                  height: rowHeight,
                  gridTemplateColumns: columnTemplate,
                  width: totalWidth,
                }}
              >
                <div className="grid-row-number">{entry.index + 1}</div>
                {selectable && (
                  <div className="grid-select-cell">
                    <button
                      className={clsx('grid-check', selected && 'is-checked')}
                      onClick={() => onToggleRow?.(entry.index)}
                      aria-label="Select row"
                    >
                      {selected && <Check size={10} />}
                    </button>
                  </div>
                )}
                {visibleIndexes.map((colIndex) => {
                  const column = columns[colIndex];
                  const value = row[colIndex];
                  const isEditing = editing?.row === entry.index && editing?.col === colIndex;
                  const isSelected = selectedCell?.row === virtualRow.index && selectedCell?.col === colIndex;
                  return (
                    <div
                      key={`${column.name}-${colIndex}`}
                      className={clsx(
                        'grid-cell',
                        value === null && 'is-null',
                        isNumericType(column.type) && 'is-number',
                        isSelected && 'is-focus',
                        isJsonLike(value) && 'is-json',
                        typeof value === 'object' && 'is-blob',
                      )}
                      title={value === null ? 'NULL' : typeof value === 'object' ? `BLOB · ${value.size} bytes` : String(value)}
                      onClick={() => {
                        if (isEditing) return;
                        setSelectedCell({ row: virtualRow.index, col: colIndex });
                        onSelectCell?.(entry.index, colIndex, value);
                        shellRef.current?.focus();
                      }}
                      onDoubleClick={() => {
                        if (!editable || !onEdit) return;
                        editingRef.current = { row: entry.index, col: colIndex };
                        setEditing({
                          row: entry.index,
                          col: colIndex,
                          value: value === null || typeof value === 'object' ? '' : String(value),
                        });
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setSelectedCell({ row: virtualRow.index, col: colIndex });
                        onSelectCell?.(entry.index, colIndex, value);
                        setMenu({ x: event.clientX, y: event.clientY, rowIndex: entry.index, columnIndex: colIndex });
                      }}
                    >
                      {isEditing ? (
                        <div className="cell-editor">
                          <input
                            ref={editInputRef}
                            defaultValue={editing.value}
                            onClick={(event) => event.stopPropagation()}
                            onDoubleClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                commitEdit((event.target as HTMLInputElement).value);
                              } else if (event.key === 'Escape') {
                                editingRef.current = null;
                                setEditing(null);
                              }
                            }}
                            onBlur={(event) => commitEdit(event.target.value)}
                          />
                          <button
                            className="cell-null"
                            title="Set NULL"
                            onMouseDown={(event) => {
                              event.preventDefault();
                              commitEdit(null);
                            }}
                          >
                            ∅
                          </button>
                        </div>
                      ) : value !== null && typeof value === 'object' ? (
                        <span className="cell-blob">
                          <Database size={11} /> BLOB {value.size} B
                        </span>
                      ) : (
                        <span className="cell-value">{value === null ? 'NULL' : String(value)}</span>
                      )}
                      {isJsonLike(value) && !isEditing && <Braces size={10} className="json-mark" />}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      {menu && (
        <CopyMenu
          menu={menu}
          onClose={() => setMenu(null)}
          columns={columns}
          rows={rows}
          editable={editable}
          onEdit={onEdit}
          onFilterValue={onFilterValue}
          onViewText={onViewText}
        />
      )}
      <div className="grid-foot-note">
        <Table2 size={10} />
        <span>{rows.length.toLocaleString()} rows</span>
        {editable && <span className="grid-edit-hint"><Pencil size={9} /> 双击编辑 · ⌘C 复制</span>}
        <span className="grid-foot-spacer" />
        {sort && (
          <button className="grid-sort-reset" onClick={() => setSort(null)}>
            <ChevronDown size={9} /> 清除排序
          </button>
        )}
        <div className="grid-columns" ref={columnsRef}>
          <button
            className={clsx('grid-foot-btn', columnsOpen && 'is-open')}
            onClick={() => setColumnsOpen((open) => !open)}
            title="显示 / 隐藏列"
          >
            <Columns3 size={10} />
            列 {visibleIndexes.length}/{columns.length}
          </button>
          {columnsOpen && (
            <div className="grid-columns-menu">
              <div className="grid-columns-head">
                <span>显示列</span>
                <button onClick={() => setHiddenColumns(new Set())}>全部显示</button>
              </div>
              <div className="grid-columns-list">
                {columns.map((column, index) => {
                  const visible = !hiddenColumns.has(index);
                  return (
                    <button
                      key={`${column.name}-${index}`}
                      className={clsx('grid-column-option', visible && 'is-on')}
                      onClick={() => {
                        setHiddenColumns((current) => {
                          const next = new Set(current);
                          if (next.has(index)) next.delete(index);
                          else next.add(index);
                          return next;
                        });
                      }}
                    >
                      <span className={clsx('grid-check', visible && 'is-checked')}>{visible && <Check size={9} />}</span>
                      <span className="grid-column-option-name">{column.name}</span>
                      <span className="grid-column-option-type">{column.type}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
