import type { CellValue, ResultColumn } from '../types';

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (Math.abs(value) >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 10_000) return `${(value / 1000).toFixed(1)}K`;
  return value.toLocaleString('en-US');
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

export function formatUptime(seconds: number): string {
  if (!seconds) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function timeAgo(input: string | number | Date): string {
  const value = new Date(input).getTime();
  const diff = Date.now() - value;
  if (diff < 45_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)} 天前`;
  return new Date(input).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

export function cellText(value: CellValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'object') return `<BLOB ${formatBytes(value.size)}>`;
  return String(value);
}

export function copyText(value: CellValue): string {
  if (value === null) return '';
  if (typeof value === 'object') return `0x${value.preview}`;
  return String(value);
}

export function isNumericType(type: string): boolean {
  return /INT|DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL|YEAR|BIT/i.test(type);
}

export function isJsonLike(value: CellValue): boolean {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!(text.startsWith('{') || text.startsWith('['))) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export function prettyJson(value: CellValue): string | null {
  if (!isJsonLike(value)) return null;
  try {
    return JSON.stringify(JSON.parse(String(value)), null, 2);
  } catch {
    return null;
  }
}

export function quoteIdentifier(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const target = text.toLowerCase();
  if (target === q) return 1000;
  if (target.startsWith(q)) return 800 - target.length;
  if (target.includes(q)) return 600 - target.indexOf(q);
  let score = 0;
  let index = 0;
  for (const char of q) {
    const found = target.indexOf(char, index);
    if (found === -1) return 0;
    score += 10 - Math.min(9, found - index);
    index = found + 1;
  }
  return Math.max(1, score);
}

export function tableColumnWidths(columns: ResultColumn[], rows: CellValue[][]): number[] {
  return columns.map((column, index) => {
    let max = column.name.length + 4;
    const sample = rows.slice(0, 120);
    for (const row of sample) {
      const value = row[index];
      const length =
        value === null
          ? 4
          : typeof value === 'object'
            ? 20
            : String(value).length;
      if (length > max) max = length;
    }
    const base = Math.max(112, Math.min(340, max * 7.4 + 34));
    return isNumericType(column.type) ? Math.max(104, Math.min(220, base)) : base;
  });
}

export function statementAtCursor(sql: string, cursor: number): { text: string; start: number; end: number } {
  const ranges: { start: number; end: number }[] = [];
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-' && (sql[i + 2] === ' ' || sql[i + 2] === '\n' || sql[i + 2] === undefined)) {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (ch === '#') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (ch === ';') {
      ranges.push({ start, end: i });
      start = i + 1;
    }
    i += 1;
  }
  ranges.push({ start, end: sql.length });
  const clamped = Math.max(0, Math.min(cursor, sql.length));
  const found =
    ranges.find((range) => clamped >= range.start && clamped <= range.end) ||
    ranges[ranges.length - 1];
  let text = sql.slice(found.start, found.end);
  let offset = found.start;
  if (!text.trim()) {
    const previous = [...ranges].reverse().find((range) => range.end <= clamped && sql.slice(range.start, range.end).trim());
    if (previous) {
      text = sql.slice(previous.start, previous.end);
      offset = previous.start;
    }
  }
  const leading = text.length - text.trimStart().length;
  return { text: text.trim(), start: offset + leading, end: offset + text.trimEnd().length };
}

export function splitSqlPreview(sql: string, max = 120): string {
  const text = sql.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function relativePath(filePath: string): string {
  const parts = filePath.split('/');
  if (parts.length <= 3) return filePath;
  return `…/${parts.slice(-2).join('/')}`;
}
