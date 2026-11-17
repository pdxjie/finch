import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, drawSelection, highlightSpecialChars, lineNumbers } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import { MySQL, sql } from '@codemirror/lang-sql';
import { useStore } from '../store';
import { darkHighlight, lightHighlight } from '../lib/sqlHighlight';

/** Read-only SQL code view used for table DDL inside inspector panels. */
export function DdlViewer({ value }: { value: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const theme = useStore((state) => state.themeResolved);
  const fontSize = useStore((state) => state.settings.editorFontSize);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const dark = theme === 'dark';
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightSpecialChars(),
          drawSelection(),
          EditorState.readOnly.of(true),
          sql({ dialect: MySQL }),
          syntaxHighlighting(dark ? darkHighlight : lightHighlight),
          EditorView.theme(
            {
              '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--text)' },
              '.cm-scroller': {
                fontFamily: 'var(--mono)',
                fontSize: `${Math.max(10, fontSize - 2)}px`,
                lineHeight: '1.68',
                overflow: 'auto',
              },
              '.cm-content': { padding: '10px 0 24px', caretColor: 'transparent', whiteSpace: 'pre' },
              '.cm-line': { padding: '0 12px 0 6px' },
              '.cm-gutters': {
                backgroundColor: 'transparent',
                border: 'none',
                color: 'var(--text-faint)',
                minWidth: '38px',
              },
              '.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 8px', minWidth: '22px' },
              '.cm-activeLine': { backgroundColor: 'transparent' },
              '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-faint)' },
              '&.cm-focused': { outline: 'none' },
              '.cm-selectionBackground, ::selection': {
                backgroundColor: dark ? 'rgba(108,140,255,0.28)' : 'rgba(70,105,255,0.16)',
              },
            },
            { dark },
          ),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, fontSize]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  return <div className="ddl-viewer" ref={hostRef} />;
}
