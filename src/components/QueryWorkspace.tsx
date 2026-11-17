import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownToLine,
  Braces,
  CheckCircle2,
  ChevronDown,
  CircleStop,
  ClipboardCopy,
  Clock3,
  Database,
  FileCode2,
  FileJson,
  FileSpreadsheet,
  FileText,
  Gauge,
  Loader2,
  Play,
  Save,
  Server,
  Lock,
  Sparkles,
  Table2,
  Wand2,
  XCircle,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useStore } from '../store';
import type { QueryResult, ResultColumn, StatementResult, WorkspaceTab } from '../types';
import { formatDuration } from '../lib/format';
import { SqlEditor, type SqlEditorHandle } from './SqlEditor';
import { ResultGrid } from './ResultGrid';
import { AIComposer } from './AIStudio';
import { IconButton, Kbd, Spinner, StatusDot } from './ui';
import { Select } from './Select';

export function QueryWorkspace({ tab }: { tab: WorkspaceTab }) {
  const editorRef = useRef<SqlEditorHandle>(null);
  const runQuery = useStore((state) => state.runQuery);
  const cancelQuery = useStore((state) => state.cancelQuery);
  const explainQuery = useStore((state) => state.explainQuery);
  const updateSql = useStore((state) => state.updateSql);
  const updateTab = useStore((state) => state.updateTab);
  const switchQueryConnection = useStore((state) => state.switchQueryConnection);
  const connections = useStore((state) => state.connections);
  const requestSaveQuery = useStore((state) => state.requestSaveQuery);
  const toast = useStore((state) => state.toast);
  const databases = useStore((state) => state.databases[tab.sessionId]) || [];
  const session = useStore((state) => state.sessions[tab.sessionId]);
  const profile = useStore((state) => state.connections.find((item) => item.id === tab.sessionId));
  const [editorHeight, setEditorHeight] = useState(() => {
    const saved = Number(localStorage.getItem('finch.editorHeight'));
    return saved > 120 ? saved : 290;
  });
  const [exportOpen, setExportOpen] = useState(false);
  const [runMenuOpen, setRunMenuOpen] = useState(false);
  const aiOpen = useStore((state) => state.aiOpen);
  const setAiOpen = useStore((state) => state.setAiOpen);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const exportRef = useRef<HTMLDivElement>(null);
  const runRef = useRef<HTMLDivElement>(null);

  const activeStatementIndex = Math.min(
    Math.max(0, tab.resultIndex || 0),
    Math.max(0, (tab.result?.statements.length || 1) - 1),
  );
  const statement = tab.result?.statements[activeStatementIndex];

  const run = (mode: 'statement' | 'all' = 'statement') => {
    const sql = editorRef.current?.getRunnable(mode) || tab.sql;
    runQuery(tab.id, sql);
  };

  useEffect(() => {
    const onCommand = (event: Event) => {
      const action = (event as CustomEvent<{ action: string }>).detail?.action;
      const current = tabRef.current;
      if (!current) return;
      const text = editorRef.current?.getRunnable(action === 'run-all' ? 'all' : 'statement') || current.sql;
      if (action === 'run' || action === 'run-all') runQuery(current.id, text);
      else if (action === 'format') editorRef.current?.format();
      else if (action === 'save-query') requestSaveQuery(current.id);
      else if (action === 'cancel') cancelQuery(current.id);
      else if (action === 'explain') explainQuery(current.id, text);
    };
    window.addEventListener('finch:command', onCommand);
    return () => window.removeEventListener('finch:command', onCommand);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  useEffect(() => {
    if (!exportOpen) return;
    const close = (event: MouseEvent) => {
      if (!exportRef.current?.contains(event.target as Node)) setExportOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [exportOpen]);

  useEffect(() => {
    if (!runMenuOpen) return;
    const close = (event: MouseEvent) => {
      if (!runRef.current?.contains(event.target as Node)) setRunMenuOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [runMenuOpen]);

  const beginResize = (event: React.PointerEvent) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = editorHeight;
    const onMove = (moveEvent: PointerEvent) => {
      const next = Math.max(120, Math.min(window.innerHeight - 230, startHeight + moveEvent.clientY - startY));
      setEditorHeight(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setEditorHeight((height) => {
        localStorage.setItem('finch.editorHeight', String(height));
        return height;
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const exportStatement = async (format: 'csv' | 'json' | 'sql') => {
    if (!statement || statement.kind !== 'rows') {
      toast('info', '没有可导出的结果', '先运行一条返回数据的查询。');
      return;
    }
    const result = await window.finch.exportData({
      format,
      columns: statement.columns,
      rows: statement.rows,
      filename: `${tab.title.replace(/[^\w\u4e00-\u9fa5-]+/g, '-').toLowerCase() || 'finch'}-result`,
      table: tab.table || 'query_result',
    });
    setExportOpen(false);
    if (result.saved) toast('success', '导出完成', result.filePath);
  };

  const copyResults = () => {
    if (!statement || statement.kind !== 'rows') return;
    const header = statement.columns.map((column) => column.name).join('\t');
    const body = statement.rows
      .map((row) => row.map((cell) => (cell === null ? '' : typeof cell === 'object' ? '' : String(cell))).join('\t'))
      .join('\n');
    navigator.clipboard.writeText(`${header}\n${body}`);
    toast('success', '结果已复制为 TSV');
  };

  return (
    <div className="query-workspace">
      <div className="query-toolbar">
        <div className="query-toolbar-left">
          <div className="run-group" ref={runRef}>
            {tab.running ? (
              <button className="btn btn-danger btn-run" onClick={() => cancelQuery(tab.id)}>
                <CircleStop size={14} /> 取消
              </button>
            ) : (
              <button className="btn btn-primary btn-run" disabled={tab.switchingConnection || tab.aiGenerating} onClick={() => run('statement')}>
                <Play size={13} fill="currentColor" /> 运行
              </button>
            )}
            <button
              className="btn btn-primary btn-run-more"
              onClick={() => setRunMenuOpen((open) => !open)}
              aria-label="Run options"
            >
              <ChevronDown size={12} />
            </button>
            {runMenuOpen && (
              <div className="popover-menu run-menu">
                <button onClick={() => { run('statement'); setRunMenuOpen(false); }}>
                  <Play size={13} /> 运行当前语句 <Kbd>⌘↵</Kbd>
                </button>
                <button onClick={() => { run('all'); setRunMenuOpen(false); }}>
                  <Sparkles size={13} /> 运行全部 <Kbd>⇧⌘↵</Kbd>
                </button>
                <button
                  onClick={() => {
                    const sql = editorRef.current?.getRunnable('statement') || tab.sql;
                    explainQuery(tab.id, sql);
                    setRunMenuOpen(false);
                  }}
                >
                  <Gauge size={13} /> 查看执行计划 <Kbd>⌘E</Kbd>
                </button>
              </div>
            )}
          </div>

          <div className="toolbar-divider" />
          <div className="query-db">
            <Server size={13} />
            <Select
              value={tab.sessionId}
              onChange={(value) => switchQueryConnection(tab.id, value)}
              ariaLabel="当前 MySQL 连接"
              placeholder={tab.switchingConnection ? '正在切换连接…' : '选择连接'}
              disabled={tab.running || tab.switchingConnection || tab.aiGenerating}
              size="sm"
              width={174}
              menuWidth={260}
              options={connections.map((connection) => ({
                value: connection.id,
                label: connection.name,
                hint: `${connection.host}:${connection.port} · ${connection.readOnly ? '只读' : '可读写'}`,
              }))}
            />
            {tab.switchingConnection ? <Spinner size={12} /> : <StatusDot status={session?.status} />}
            {profile?.readOnly && <span className="readonly-badge"><Lock size={9} /> 只读</span>}
          </div>
          <div className="query-db">
            <Database size={13} />
            <Select
              value={tab.database}
              onChange={(value) => updateTab(tab.id, { database: value })}
              ariaLabel="当前数据库"
              placeholder="选择数据库"
              disabled={tab.running || tab.switchingConnection || tab.aiGenerating}
              size="sm"
              width={172}
              options={[
                ...databases.map((database) => ({ value: database.name, label: database.name })),
                ...(tab.database && !databases.some((database) => database.name === tab.database)
                  ? [{ value: tab.database, label: tab.database }]
                  : []),
              ]}
            />
          </div>

        </div>

        <div className="query-toolbar-actions">
          <button className="btn-ai" onClick={() => setAiOpen(true)} title="用自然语言生成 SQL  ⌘P">
            <Sparkles size={13} /> AI
          </button>
          <IconButton
            icon={Wand2}
            label="格式化 SQL  ⇧⌘F"
            size={15}
            onClick={() => editorRef.current?.format()}
          />
          <IconButton
            icon={Gauge}
            label="执行计划  ⌘E"
            size={15}
            onClick={() => explainQuery(tab.id, editorRef.current?.getRunnable('statement') || tab.sql)}
          />
          <IconButton
            icon={Save}
            label="保存查询  ⌘S"
            size={15}
            onClick={() => requestSaveQuery(tab.id)}
          />
        </div>
      </div>

      {aiOpen && (
        <AIComposer
          key={tab.id}
          tab={tab}
          onClose={() => { setAiOpen(false); editorRef.current?.focus(); }}
        />
      )}

      <div className="editor-pane" style={{ height: editorHeight }}>
        <SqlEditor
          ref={editorRef}
          tabId={tab.id}
          value={tab.sql}
          onChange={(value) => updateSql(tab.id, value)}
          onRun={(mode) => run(mode)}
          onSave={() => requestSaveQuery(tab.id)}
          onNotify={(message) => toast('info', message)}
          readOnly={tab.aiGenerating}
        />
        <div className="editor-hint">
          <span><Kbd>⌘↵</Kbd> 运行选中或当前语句</span>
          <span className="editor-hint-dot" />
          <span>MySQL</span>
          <span className="editor-hint-dot" />
          <span>{tab.sql.split('\n').length} 行</span>
        </div>
      </div>

      <div className="pane-resizer" onPointerDown={beginResize} title="拖动调整编辑器高度">
        <span />
      </div>

      <div className="result-pane">
        <div className="result-header">
          <div className="result-tabs">
            {tab.result?.statements.map((item, index) => (
              <button
                key={index}
                className={clsx('result-tab', index === activeStatementIndex && 'is-active', item.kind === 'error' && 'is-error')}
                onClick={() => updateTab(tab.id, { resultIndex: index })}
              >
                {item.kind === 'rows' ? (
                  <Table2 size={12} />
                ) : item.kind === 'error' ? (
                  <XCircle size={12} />
                ) : (
                  <CheckCircle2 size={12} />
                )}
                {item.kind === 'rows'
                  ? `结果 ${tab.result!.statements.slice(0, index + 1).filter((entry) => entry.kind === 'rows').length}`
                  : item.kind === 'error'
                    ? '错误'
                    : '消息'}
                {item.kind === 'rows' && <span className="result-tab-count">{item.rowCount.toLocaleString()}</span>}
              </button>
            ))}
            {!tab.result && <span className="result-tab-placeholder">结果</span>}
          </div>

          <div className="result-actions">
            {statement?.kind === 'rows' && (
              <>
                <span className="result-stat" title={tab.result?.timings
                  ? `连接等待 ${tab.result.timings.connectionMs} ms · 会话准备 ${tab.result.timings.prepareMs} ms · 执行及读取 ${tab.result.timings.executionMs} ms · 客户端往返 ${tab.lastRunMs ?? tab.result.durationMs} ms`
                  : '数据库执行及结果读取耗时'}>
                  <Clock3 size={11} /> {formatDuration(statement.durationMs)}
                  {tab.lastRunMs && tab.lastRunMs > statement.durationMs + 120 && (
                    <span className="timing-split" title="从发起查询到收到结果的总耗时">
                      总 {formatDuration(tab.lastRunMs)}
                    </span>
                  )}
                </span>
                <span className="result-stat">{statement.rowCount.toLocaleString()} rows</span>
                <IconButton icon={ClipboardCopy} label="复制结果" size={14} onClick={copyResults} />
                <div className="export-wrap" ref={exportRef}>
                  <IconButton
                    icon={ArrowDownToLine}
                    label="导出结果"
                    size={14}
                    onClick={() => setExportOpen((open) => !open)}
                  />
                  {exportOpen && (
                    <div className="popover-menu export-menu">
                      <button onClick={() => exportStatement('csv')}>
                        <FileSpreadsheet size={14} /> CSV <span>适合 Excel</span>
                      </button>
                      <button onClick={() => exportStatement('json')}>
                        <FileJson size={14} /> JSON <span>结构化数据</span>
                      </button>
                      <button onClick={() => exportStatement('sql')}>
                        <FileCode2 size={14} /> SQL INSERT <span>可回放</span>
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
            {tab.result && (
              <span className="result-total">
                总计 {tab.result.statements.reduce((sum, item) => sum + (item.kind === 'rows' ? item.rowCount : 0), 0).toLocaleString()} rows
                · {formatDuration(tab.result.durationMs)}
              </span>
            )}
          </div>
        </div>

        <div className="result-body">
          {tab.result?.cancelled && (
            <div className="cancel-banner">
              <CircleStop size={12} />
              查询已取消，MySQL 已终止该线程。下面可能保留了取消瞬间的返回内容。
            </div>
          )}
          {tab.running ? (
            <QueryLoading />
          ) : tab.error ? (
            <ErrorPanel message={tab.error} />
          ) : !tab.result ? (
            <ResultPlaceholder />
          ) : statement?.kind === 'error' && statement.error ? (
            <ErrorPanel
              message={statement.error.message}
              code={statement.error.code}
              state={statement.error.sqlState}
              sql={statement.sql}
            />
          ) : statement?.kind === 'command' ? (
            <CommandResult statement={statement} />
          ) : statement?.kind === 'rows' ? (
            <div className="result-grid-wrap">
              {statement.truncated && (
                <div className="truncated-banner">
                  <AlertTriangle size={12} />
                  {statement.truncatedReason === 'bytes'
                    ? `结果数据超过 ${(6).toFixed(0)} MB，已截断到 ${statement.rows.length.toLocaleString()} 行。请加 LIMIT、减少列，或分页查询。`
                    : `结果超过 ${statement.rows.length.toLocaleString()} 行，已截断显示。可在设置中调整上限，或加 LIMIT 精确查询。`}
                </div>
              )}
              <ResultGrid
                columns={statement.columns}
                rows={statement.rows}
                emptyLabel="查询成功，但没有返回任何行"
                autoFocus
              />
            </div>
          ) : (
            <ResultPlaceholder />
          )}
        </div>

        <div className="result-status">
          <span className="result-status-left">
            <span className={clsx('status-dot', session?.status === 'connected' ? 'status-connected' : 'status-offline')} />
            {session?.status === 'connected' ? '已连接' : session?.status === 'reconnecting' ? '正在重连…' : '未连接'}
          </span>
          <span>{profile?.host}:{profile?.port}</span>
          <span className="result-status-sep">·</span>
          <span>{tab.database || '—'}</span>
          <span className="result-status-spacer" />
          {profile?.keepAliveSeconds ? <span>Keep-alive {profile.keepAliveSeconds}s</span> : null}
          {session?.latency !== null && session?.latency !== undefined ? <span>{session.latency} ms</span> : null}
          <span>UTF-8</span>
        </div>
      </div>

    </div>
  );
}

function QueryLoading() {
  return (
    <div className="query-loading">
      <div className="loading-orb">
        <Loader2 size={18} className="spin" />
      </div>
      <div>
        <strong>正在执行查询</strong>
        <p>MySQL 正在处理请求，结果会即时出现。</p>
      </div>
      <div className="loading-bars">
        <span /><span /><span /><span /><span /><span />
      </div>
    </div>
  );
}

function ResultPlaceholder() {
  return (
    <div className="result-placeholder">
      <div className="result-placeholder-art">
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
      <h4>结果会显示在这里</h4>
      <p>运行查询，或按 <Kbd>⌘↵</Kbd> 执行当前语句。</p>
    </div>
  );
}

function CommandResult({ statement }: { statement: StatementResult }) {
  const [copied, setCopied] = useState(false);
  const metrics = [
    `${statement.affectedRows ?? 0} 行`,
    formatDuration(statement.durationMs),
    statement.insertId ? `插入 ID ${statement.insertId}` : '',
    statement.warnings ? `${statement.warnings} 警告` : '',
  ].filter(Boolean);

  return (
    <div className="command-result">
      <div className="command-card">
        <div className="command-head">
          <span className="command-badge">
            <CheckCircle2 size={14} />
            执行成功
          </span>
          <span className="command-metrics">
            {metrics.map((item, index) => (
              <span key={item}>
                {index > 0 && <i>·</i>}
                {item}
              </span>
            ))}
          </span>
          <button
            className="command-copy-btn"
            onClick={() => {
              navigator.clipboard.writeText(statement.sql);
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            }}
          >
            {copied ? <CheckCircle2 size={11} /> : <ClipboardCopy size={11} />}
            {copied ? '已复制' : '复制 SQL'}
          </button>
        </div>
        <pre className="command-sql">{statement.sql}</pre>
        {statement.info && <p className="command-info">{statement.info}</p>}
      </div>
    </div>
  );
}

function ErrorPanel({ message, code, state, sql }: { message: string; code?: string; state?: string; sql?: string }) {
  return (
    <div className="error-panel">
      <div className="error-icon">
        <XCircle size={22} />
      </div>
      <div className="error-copy">
        <div className="error-title-row">
          <h3>SQL 执行失败</h3>
          {code && <span className="error-code">{code}</span>}
          {state && <span className="error-code">SQLSTATE {state}</span>}
        </div>
        <p>{message}</p>
        {sql && <pre>{sql}</pre>}
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            navigator.clipboard.writeText(message);
          }}
        >
          <ClipboardCopy size={13} /> 复制错误
        </button>
      </div>
    </div>
  );
}
