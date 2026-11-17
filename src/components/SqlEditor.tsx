import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { acceptCompletion, autocompletion, completionStatus, startCompletion } from '@codemirror/autocomplete';
import { indentUnit, syntaxHighlighting } from '@codemirror/language';
import { MySQL, sql } from '@codemirror/lang-sql';
import { format as formatSql } from 'sql-formatter';
import { useStore } from '../store';
import { statementAtCursor } from '../lib/format';
import { finchCompletions } from '../lib/sqlCompletions';
import { darkHighlight, lightHighlight } from '../lib/sqlHighlight';

function makeTheme(dark: boolean, fontSize: number) {
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        backgroundColor: 'transparent',
        color: 'var(--text)',
        fontSize: `${fontSize}px`,
      },
      '.cm-scroller': {
        fontFamily: 'var(--mono)',
        lineHeight: '1.72',
        overflow: 'auto',
      },
      '.cm-content': {
        padding: '14px 0 44px',
        caretColor: 'var(--accent)',
      },
      '.cm-line': { padding: '0 22px 0 6px' },
      '.cm-gutters': {
        backgroundColor: 'transparent',
        color: 'var(--text-faint)',
        border: 'none',
        paddingLeft: '10px',
        minWidth: '46px',
      },
      '.cm-lineNumbers .cm-gutterElement': { padding: '0 4px 0 10px', minWidth: '28px' },
      '.cm-activeLine': { backgroundColor: 'var(--editor-active)' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-muted)' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: dark ? 'rgba(108, 140, 255, 0.28)' : 'rgba(70, 105, 255, 0.17)',
      },
      '.cm-selectionMatch': { backgroundColor: dark ? 'rgba(108,140,255,.16)' : 'rgba(70,105,255,.10)' },
      '.cm-matchingBracket': {
        backgroundColor: dark ? 'rgba(108,140,255,.22)' : 'rgba(70,105,255,.14)',
        outline: '1px solid var(--accent)',
      },
      '.cm-tooltip': {
        backgroundColor: 'var(--popover)',
        border: '1px solid var(--line-strong)',
        borderRadius: '9px',
        boxShadow: 'var(--shadow-lg)',
        overflow: 'hidden',
        color: 'var(--text)',
      },
      '.cm-tooltip.cm-tooltip-autocomplete > ul': {
        fontFamily: 'var(--mono)',
        fontSize: '12px',
        maxHeight: '260px',
      },
      '.cm-tooltip-autocomplete ul li': { padding: '5px 12px' },
      '.cm-tooltip-autocomplete ul li[aria-selected]': {
        background: 'var(--accent)',
        color: 'white',
      },
      '.cm-completionDetail': { color: 'var(--text-muted)', fontStyle: 'normal', marginLeft: '14px' },
      '.cm-completionIcon': { opacity: '0.55', paddingRight: '4px' },
      '.cm-foldGutter .cm-gutterElement': { color: 'var(--text-faint)' },
      '.cm-panels': { background: 'var(--surface-2)', color: 'var(--text)', border: 'none' },
      '.cm-searchMatch': { background: 'rgba(255, 196, 80, 0.3)' },
      '.cm-placeholder': { color: 'var(--text-faint)', fontStyle: 'italic' },
    },
    { dark },
  );
}

interface SqlEditorProps {
  tabId: string;
  value: string;
  onChange: (value: string) => void;
  onRun: (mode: 'statement' | 'all') => void;
  onSave: () => void;
  onNotify: (message: string) => void;
  readOnly?: boolean;
}

export interface SqlEditorHandle {
  getSql: () => string;
  getRunnable: (mode: 'statement' | 'all') => string;
  setSql: (sql: string, focus?: boolean) => void;
  format: () => void;
  focus: () => void;
  insert: (text: string) => void;
}

export const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(function SqlEditor(
  { tabId, value, onChange, onRun, onSave, onNotify, readOnly = false },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const statesRef = useRef<Map<string, EditorState>>(new Map());
  const currentTabRef = useRef(tabId);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const editable = useRef(new Compartment());
  const theme = useStore((state) => state.themeResolved);
  const sessionId = useStore((state) => state.tabs.find((tab) => tab.id === tabId)?.sessionId);
  const database = useStore((state) => state.tabs.find((tab) => tab.id === tabId)?.database);
  const fontSize = useStore((state) => state.settings.editorFontSize);
  const callbacksRef = useRef({ onChange, onRun, onSave, onNotify });
  callbacksRef.current = { onChange, onRun, onSave, onNotify };

  const buildState = (doc: string) => {
    const dark = document.documentElement.dataset.theme === 'dark';
    const themeCompartment = new Compartment();
    return EditorState.create({
      doc,
      extensions: [
        editable.current.of([EditorState.readOnly.of(readOnlyRef.current), EditorView.editable.of(!readOnlyRef.current)]),
        basicSetup,
        sql({ dialect: MySQL, upperCaseKeywords: true }),
        autocompletion({
          override: [finchCompletions],
          activateOnTyping: true,
          maxRenderedOptions: 120,
          icons: true,
          closeOnBlur: true,
        }),
        themeCompartment.of([makeTheme(dark, fontSize), syntaxHighlighting(dark ? darkHighlight : lightHighlight)]),
        EditorView.lineWrapping,
        EditorState.tabSize.of(2),
        indentUnit.of('  '),
        placeholder('SELECT * FROM …   —   ⌘↵ 运行'),
        keymap.of([
          {
            key: 'Ctrl-Space',
            run: startCompletion,
          },
          {
            key: 'Tab',
            run: (view) => {
              if (completionStatus(view.state) === 'active') return acceptCompletion(view);
              return false;
            },
          },
          {
            key: 'Mod-Enter',
            run: () => {
              callbacksRef.current.onRun('statement');
              return true;
            },
          },
          {
            key: 'Mod-Shift-Enter',
            run: () => {
              callbacksRef.current.onRun('all');
              return true;
            },
          },
          {
            key: 'Mod-s',
            run: () => {
              callbacksRef.current.onSave();
              return true;
            },
          },
          {
            key: 'Mod-Shift-f',
            run: () => {
              formatCurrent();
              return true;
            },
          },
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          callbacksRef.current.onChange(update.state.doc.toString());
          // Typing `alias.` should open completion immediately, like an IDE.
          const head = update.state.selection.main.head;
          if (update.state.sliceDoc(Math.max(0, head - 1), head) === '.') {
            startCompletion(update.view);
          }
        }),
      ],
    });
  };

  const formatCurrent = () => {
    if (readOnlyRef.current) return;
    const view = viewRef.current;
    if (!view) return;
    const text = view.state.doc.toString();
    if (!text.trim()) return;
    try {
      const formatted = formatSql(text, {
        language: 'mysql',
        keywordCase: 'upper',
        linesBetweenQueries: 2,
        tabWidth: 2,
      });
      if (formatted !== text) {
        view.dispatch({
          changes: { from: 0, to: text.length, insert: formatted },
          selection: { anchor: Math.min(view.state.selection.main.anchor, formatted.length) },
        });
        callbacksRef.current.onNotify('SQL 已格式化');
      }
    } catch (error) {
      callbacksRef.current.onNotify(error instanceof Error ? error.message : '无法格式化 SQL');
    }
  };

  useEffect(() => {
    if (!hostRef.current) return;
    const initial = statesRef.current.get(tabId) || buildState(value);
    const view = new EditorView({ state: initial, parent: hostRef.current });
    viewRef.current = view;
    currentTabRef.current = tabId;
    requestAnimationFrame(() => view.focus());
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const state = useStore.getState();
    const tab = state.tabs.find((item) => item.id === tabId);
    if (!tab?.sessionId || !tab.database) return;
    state.loadAllColumns(tab.sessionId, tab.database).catch(() => {});
    state.loadTables(tab.sessionId, tab.database).catch(() => {});
    state.loadTables(tab.sessionId, tab.database, 'view').catch(() => {});
  }, [tabId, sessionId, database]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (currentTabRef.current !== tabId) {
      statesRef.current.set(currentTabRef.current, view.state);
      let next = statesRef.current.get(tabId) || buildState(value);
      if (next.doc.toString() !== value) next = next.update({ changes: { from: 0, to: next.doc.length, insert: value } }).state;
      currentTabRef.current = tabId;
      view.setState(next);
      requestAnimationFrame(() => view.focus());
      return;
    }
    const current = view.state.doc.toString();
    if (value !== current) {
      let shared = 0;
      while (shared < current.length && shared < value.length && current[shared] === value[shared]) shared++;
      view.dispatch({ changes: { from: shared, to: current.length, insert: value.slice(shared) },
        ...(readOnly ? { selection: { anchor: value.length }, scrollIntoView: true } : {}) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, value, readOnly]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: editable.current.reconfigure([
      EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly),
    ]) });
  }, [readOnly, tabId]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    statesRef.current.clear();
    view.setState(buildState(current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, fontSize]);

  useEffect(() => {
    const onExternalSet = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId: string; sql: string }>).detail;
      if (!detail || detail.tabId !== currentTabRef.current) return;
      const view = viewRef.current;
      if (!view) return;
      const current = view.state.doc.toString();
      if (current === detail.sql) return;
      view.dispatch({ changes: { from: 0, to: current.length, insert: detail.sql } });
      view.focus();
    };
    window.addEventListener('finch:set-sql', onExternalSet);
    return () => window.removeEventListener('finch:set-sql', onExternalSet);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      getSql: () => viewRef.current?.state.doc.toString() || '',
      getRunnable: (mode) => {
        const view = viewRef.current;
        if (!view) return '';
        const text = view.state.doc.toString();
        if (mode === 'all') return text;
        const selection = view.state.selection.main;
        if (!selection.empty) return text.slice(selection.from, selection.to);
        return statementAtCursor(text, selection.head).text || text;
      },
      setSql: (next, focus = true) => {
        const view = viewRef.current;
        if (!view) return;
        const current = view.state.doc.toString();
        view.dispatch({ changes: { from: 0, to: current.length, insert: next } });
        if (focus) view.focus();
      },
      format: formatCurrent,
      focus: () => viewRef.current?.focus(),
      insert: (text) => {
        const view = viewRef.current;
        if (!view) return;
        const selection = view.state.selection.main;
        view.dispatch({
          changes: { from: selection.from, to: selection.to, insert: text },
          selection: { anchor: selection.from + text.length },
        });
        view.focus();
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return <div className="sql-editor" ref={hostRef} />;
});
