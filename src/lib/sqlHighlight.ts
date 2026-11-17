import { HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';

export const lightHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#6D5DFB', fontWeight: '600' },
  { tag: [tags.string, tags.special(tags.string)], color: '#0F8F68' },
  { tag: tags.number, color: '#C0700A' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: '#9A9D9A', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.standard(tags.variableName)], color: '#1D6FD8' },
  { tag: tags.operator, color: '#74716C' },
  { tag: [tags.typeName, tags.className], color: '#087F8C' },
  { tag: tags.bool, color: '#C0700A' },
  { tag: tags.null, color: '#C0700A' },
  { tag: tags.variableName, color: '#2F5EA8' },
]);

export const darkHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#A99BFF', fontWeight: '600' },
  { tag: [tags.string, tags.special(tags.string)], color: '#6FD3A8' },
  { tag: tags.number, color: '#FFC06A' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: '#626B7A', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.standard(tags.variableName)], color: '#7FB8FF' },
  { tag: tags.operator, color: '#9AA3B2' },
  { tag: [tags.typeName, tags.className], color: '#6FC9D8' },
  { tag: tags.bool, color: '#FFC06A' },
  { tag: tags.null, color: '#FFC06A' },
  { tag: tags.variableName, color: '#A8C7FF' },
]);

