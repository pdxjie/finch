import type { CellValue, ColumnInfo, TableFilter } from '../types';

export function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "''")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\0/g, '\\0');
}

export function sqlLiteral(value: CellValue | string | number | null | undefined): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'object') return `/* ${value.size} bytes binary */ NULL`;
  return `'${escapeText(String(value))}'`;
}

function filterClause(filter: TableFilter): string | null {
  const op = filter.op.toUpperCase();
  const column = quoteIdent(filter.column);
  if (op === 'IS NULL' || op === 'IS NOT NULL') return `${column} ${op}`;
  if (op === 'IS EMPTY' || op === 'IS NOT EMPTY') {
    return `${column} ${op === 'IS EMPTY' ? '=' : '!='} ''`;
  }
  if (op === 'BETWEEN' || op === 'NOT BETWEEN') {
    if (!filter.value2) return null;
    return `${column} ${op} ${sqlLiteral(filter.value)} AND ${sqlLiteral(filter.value2)}`;
  }
  if (op === 'IN' || op === 'NOT IN') {
    const items = filter.value.split(',').map((item) => item.trim()).filter(Boolean);
    if (!items.length) return null;
    return `${column} ${op} (${items.map((item) => sqlLiteral(item)).join(', ')})`;
  }
  const like = op === 'CONTAINS' || op === 'NOT CONTAINS'
    ? op === 'CONTAINS' ? 'LIKE' : 'NOT LIKE'
    : op === 'STARTS WITH' || op === 'ENDS WITH' ? 'LIKE' : '';
  if (like) {
    const pattern = op === 'STARTS WITH' ? `${filter.value}%` : op === 'ENDS WITH' ? `%${filter.value}` : `%${filter.value}%`;
    return `${column} ${like} ${sqlLiteral(pattern)}`;
  }
  if (!['=', '!=', '>', '>=', '<', '<=', 'LIKE', 'NOT LIKE'].includes(op)) return null;
  return `${column} ${op} ${sqlLiteral(filter.value)}`;
}

function whereSql(filters: TableFilter[], search: string, columns: ColumnInfo[]): string {
  const valid = new Set(columns.map((column) => column.name));
  const clauses = filters
    .filter((filter) => valid.has(filter.column))
    .map(filterClause)
    .filter((clause): clause is string => Boolean(clause));
  if (search) {
    const textColumns = columns
      .filter((column) => {
        const type = column.dataType.toUpperCase();
        return !type.includes('BLOB') && !type.includes('BINARY') && type !== 'BIT' && type !== 'GEOMETRY';
      })
      .slice(0, 12);
    if (textColumns.length) {
      clauses.push(`(${textColumns.map((column) => `CAST(${quoteIdent(column.name)} AS CHAR) LIKE ${sqlLiteral(`%${search}%`)}`).join(' OR ')})`);
    }
  }
  return clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
}

export function buildSelectSql(
  database: string,
  table: string,
  query: { filters: TableFilter[]; search: string; orderBy: string | null; orderDir: 'asc' | 'desc'; limit: number; offset: number },
  columns: ColumnInfo[],
): string {
  let sql = `SELECT * FROM ${quoteIdent(database)}.${quoteIdent(table)}`;
  sql += whereSql(query.filters, query.search, columns);
  if (query.orderBy) sql += ` ORDER BY ${quoteIdent(query.orderBy)} ${query.orderDir.toUpperCase()}`;
  sql += ` LIMIT ${query.limit}`;
  if (query.offset) sql += ` OFFSET ${query.offset}`;
  return `${sql};`;
}

export function buildUpdateSql(
  database: string,
  table: string,
  column: string,
  value: CellValue,
  keys: Record<string, CellValue>,
): string {
  const where = Object.entries(keys).map(([key, keyValue]) => `${quoteIdent(key)} = ${sqlLiteral(keyValue)}`).join(' AND ');
  return `UPDATE ${quoteIdent(database)}.${quoteIdent(table)} SET ${quoteIdent(column)} = ${sqlLiteral(value)} WHERE ${where} LIMIT 1;`;
}

export function buildDeleteSql(database: string, table: string, rows: Record<string, CellValue>[]): string {
  if (!rows.length) return '';
  return rows
    .map((keys) => {
      const where = Object.entries(keys).map(([key, value]) => `${quoteIdent(key)} = ${sqlLiteral(value)}`).join(' AND ');
      return `DELETE FROM ${quoteIdent(database)}.${quoteIdent(table)} WHERE ${where} LIMIT 1;`;
    })
    .join('\n');
}

export function buildInsertSql(database: string, table: string, values: Record<string, string | null>): string {
  const keys = Object.keys(values);
  if (!keys.length) return `INSERT INTO ${quoteIdent(database)}.${quoteIdent(table)} () VALUES ();`;
  return `INSERT INTO ${quoteIdent(database)}.${quoteIdent(table)} (${keys.map(quoteIdent).join(', ')}) VALUES (${keys.map((key) => sqlLiteral(values[key])).join(', ')});`;
}
