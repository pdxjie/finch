/** Normalize a `SHOW CREATE TABLE` statement into a conventional layout:
 *
 *   CREATE TABLE `t` (
 *     `id` bigint NOT NULL AUTO_INCREMENT,
 *     `name` varchar(120) NOT NULL DEFAULT '',
 *     PRIMARY KEY (`id`),
 *     KEY `idx_name` (`name`)
 *   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
 *
 * One column / index / constraint per line, two-space indent. Unlike a generic
 * SQL formatter this never splits a single definition across lines, which is
 * what made DDL hard to scan in a narrow side panel.
 */
export function formatCreateTable(ddl: string): string {
  const input = ddl.trim();
  if (!/^create\s+table\b/i.test(input)) return input;

  const open = findBodyStart(input);
  if (open < 0) return input;
  const close = findBodyEnd(input, open);
  if (close < 0) return input;

  const head = collapse(input.slice(0, open)).replace(/\s*\($/, '');
  const body = input.slice(open + 1, close);
  const tail = collapse(input.slice(close + 1)).replace(/;$/, '');
  const parts = splitTopLevel(body).map(collapse).filter(Boolean);
  if (!parts.length) return input;

  const lines = parts.map((part, index) => `  ${part}${index < parts.length - 1 ? ',' : ''}`);
  const ending = tail ? ` ${tail}` : '';
  return `${head} (\n${lines.join('\n')}\n)${ending};`;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function findBodyStart(sql: string): number {
  let quote = '';
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (quote) {
      if (ch === '\\' && quote !== '`') i += 1;
      else if (ch === quote) {
        if (sql[i + 1] === quote) i += 1;
        else quote = '';
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') return i;
  }
  return -1;
}

function findBodyEnd(sql: string, start: number): number {
  let depth = 0;
  let quote = '';
  for (let i = start; i < sql.length; i += 1) {
    const ch = sql[i];
    if (quote) {
      if (ch === '\\' && quote !== '`') i += 1;
      else if (ch === quote) {
        if (sql[i + 1] === quote) i += 1;
        else quote = '';
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      if (ch === '\\' && quote !== '`') i += 1;
      else if (ch === quote) {
        if (body[i + 1] === quote) i += 1;
        else quote = '';
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}
