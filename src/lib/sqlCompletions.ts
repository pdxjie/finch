import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { useStore } from '../store';
import type { ColumnInfo } from '../types';

/** Chinese explanations for the keywords people actually type. */
const KEYWORDS: Record<string, string> = {
  SELECT: '查询数据，后面跟要返回的列',
  FROM: '指定数据来自哪张表',
  WHERE: '过滤行，只保留条件成立的数据',
  GROUP: '按字段分组，通常和聚合函数一起用',
  BY: '配合 GROUP BY / ORDER BY 指定字段',
  HAVING: '对分组后的结果再过滤',
  ORDER: '对结果排序，配合 ASC / DESC',
  LIMIT: '限制返回行数，常用于分页',
  OFFSET: '跳过前面若干行，配合 LIMIT 分页',
  DISTINCT: '去重，只保留不重复的行',
  AS: '给列或表起别名',
  AND: '两个条件都成立',
  OR: '任一条件成立',
  NOT: '取反',
  NULL: '空值，判断要用 IS NULL / IS NOT NULL',
  IS: '与 NULL / TRUE / FALSE 搭配判断',
  IN: '值在给定列表中',
  EXISTS: '子查询是否返回至少一行',
  BETWEEN: '值落在闭区间内',
  LIKE: '模糊匹配，% 任意字符、_ 单个字符',
  CASE: '条件表达式，配合 WHEN / THEN / ELSE',
  WHEN: 'CASE 的分支条件',
  THEN: '条件成立时返回的值',
  ELSE: '所有条件都不成立时的默认值',
  END: '结束 CASE 表达式',
  ASC: '升序（默认）',
  DESC: '降序',
  JOIN: '连接另一张表',
  INNER: '内连接，只保留两边都匹配的行',
  LEFT: '左连接，保留左表全部行',
  RIGHT: '右连接，保留右表全部行',
  OUTER: '外连接关键字，通常可省略',
  CROSS: '笛卡尔积连接',
  ON: '指定连接条件',
  USING: '连接时用同名字段作为条件',
  UNION: '合并多个查询结果并去重',
  ALL: 'UNION ALL 保留重复行',
  WITH: '定义 CTE（公用表表达式）',
  RECURSIVE: '递归 CTE',
  INSERT: '插入数据',
  INTO: '指定写入的表',
  VALUES: '给出要插入的值',
  UPDATE: '更新已有数据',
  SET: '指定要更新的列和值',
  DELETE: '删除数据',
  REPLACE: '插入，主键冲突时先删后插',
  TRUNCATE: '清空整张表，不能回滚',
  CREATE: '创建表 / 库 / 索引',
  ALTER: '修改表结构',
  DROP: '删除表 / 库 / 索引',
  TABLE: '表对象',
  DATABASE: '数据库对象',
  INDEX: '索引对象',
  VIEW: '视图对象',
  PRIMARY: '主键',
  KEY: '索引或键',
  FOREIGN: '外键',
  REFERENCES: '外键引用的表和列',
  UNIQUE: '唯一约束',
  DEFAULT: '列默认值',
  AUTO_INCREMENT: '自增列',
  ENGINE: '存储引擎，如 InnoDB',
  CHARSET: '字符集，如 utf8mb4',
  COLLATE: '排序规则',
  IF: '条件判断（也用于 IF EXISTS）',
  EXPLAIN: '查看执行计划',
  DESCRIBE: '查看表结构',
  SHOW: '查看服务器信息',
  USE: '切换数据库',
  BEGIN: '开启事务',
  START: 'START TRANSACTION 开启事务',
  TRANSACTION: '事务',
  COMMIT: '提交事务',
  ROLLBACK: '回滚事务',
  SAVEPOINT: '事务保存点',
  LOCK: '加锁',
  UNLOCK: '解锁',
  CALL: '调用存储过程',
  INTERVAL: '时间间隔，配合 DATE_ADD / DATE_SUB',
  OVER: '窗口函数的分区范围',
  PARTITION: '窗口分区或表分区',
  WINDOW: '命名窗口',
  ROW_NUMBER: '窗口函数：行号',
  RANK: '窗口函数：排名（并列会跳号）',
  DENSE_RANK: '窗口函数：排名（并列不跳号）',
  LAG: '窗口函数：取前面第 N 行',
  LEAD: '窗口函数：取后面第 N 行',
};

/** Chinese explanations plus signatures for built-in functions. */
/** Short SQL examples so the info panel answers "what does it actually do". */
const KEYWORD_EXAMPLES: Record<string, string> = {
  SELECT: 'SELECT id, name FROM users LIMIT 10;',
  FROM: 'SELECT * FROM orders WHERE id = 1;',
  WHERE: "SELECT * FROM orders WHERE status = 'paid';",
  GROUP: 'SELECT status, COUNT(*) FROM orders GROUP BY status;',
  HAVING: 'SELECT status, COUNT(*) c FROM orders GROUP BY status HAVING c > 10;',
  ORDER: 'SELECT * FROM orders ORDER BY created_at DESC;',
  LIMIT: 'SELECT * FROM orders LIMIT 50;',
  OFFSET: 'SELECT * FROM orders LIMIT 50 OFFSET 100;',
  JOIN: 'SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id;',
  LEFT: 'SELECT c.id, o.id FROM customers c LEFT JOIN orders o ON o.customer_id = c.id;',
  ON: 'JOIN orders o ON o.customer_id = c.id',
  UNION: 'SELECT id FROM a UNION SELECT id FROM b;',
  WITH: 'WITH recent AS (SELECT * FROM orders LIMIT 100) SELECT COUNT(*) FROM recent;',
  INSERT: "INSERT INTO users (name) VALUES ('Ada');",
  UPDATE: "UPDATE orders SET status = 'shipped' WHERE id = 1;",
  DELETE: 'DELETE FROM sessions WHERE expired_at < NOW();',
  CREATE: 'CREATE TABLE t (id BIGINT PRIMARY KEY);',
  ALTER: 'ALTER TABLE t ADD COLUMN note VARCHAR(255);',
  EXPLAIN: 'EXPLAIN SELECT * FROM orders WHERE customer_id = 1;',
  CASE: "SELECT CASE WHEN total > 100 THEN 'big' ELSE 'small' END FROM orders;",
  DISTINCT: 'SELECT DISTINCT status FROM orders;',
  IN: 'SELECT * FROM orders WHERE status IN (\'paid\', \'shipped\');',
  BETWEEN: 'SELECT * FROM orders WHERE total BETWEEN 10 AND 100;',
  LIKE: "SELECT * FROM customers WHERE name LIKE 'A%';",
};

const FUNCTIONS: Record<string, { sig: string; text: string }> = {
  COUNT: { sig: 'COUNT(expr)', text: '统计非 NULL 行数；COUNT(*) 统计全部行' },
  SUM: { sig: 'SUM(expr)', text: '求和，忽略 NULL' },
  AVG: { sig: 'AVG(expr)', text: '求平均值，忽略 NULL' },
  MIN: { sig: 'MIN(expr)', text: '取最小值' },
  MAX: { sig: 'MAX(expr)', text: '取最大值' },
  GROUP_CONCAT: { sig: 'GROUP_CONCAT(expr)', text: '把分组内的值拼成一个字符串' },
  JSON_EXTRACT: { sig: "JSON_EXTRACT(doc, '$.path')", text: '按路径取出 JSON 中的值' },
  JSON_UNQUOTE: { sig: 'JSON_UNQUOTE(json)', text: '去掉 JSON 字符串两端的引号' },
  JSON_OBJECT: { sig: 'JSON_OBJECT(k, v, ...)', text: '构造 JSON 对象' },
  JSON_ARRAY: { sig: 'JSON_ARRAY(v, ...)', text: '构造 JSON 数组' },
  JSON_CONTAINS: { sig: 'JSON_CONTAINS(doc, val)', text: '判断 JSON 是否包含某个值' },
  NOW: { sig: 'NOW()', text: '当前日期时间' },
  CURDATE: { sig: 'CURDATE()', text: '当前日期' },
  CURTIME: { sig: 'CURTIME()', text: '当前时间' },
  DATE_FORMAT: { sig: "DATE_FORMAT(d, '%Y-%m-%d')", text: '按格式输出日期' },
  DATE_ADD: { sig: 'DATE_ADD(d, INTERVAL n unit)', text: '日期加一段时间' },
  DATE_SUB: { sig: 'DATE_SUB(d, INTERVAL n unit)', text: '日期减一段时间' },
  DATEDIFF: { sig: 'DATEDIFF(a, b)', text: '两个日期相差的天数' },
  TIMESTAMPDIFF: { sig: 'TIMESTAMPDIFF(unit, a, b)', text: '两个时间在指定单位上的差' },
  UNIX_TIMESTAMP: { sig: 'UNIX_TIMESTAMP(d)', text: '日期转秒级时间戳' },
  FROM_UNIXTIME: { sig: 'FROM_UNIXTIME(ts)', text: '时间戳转日期时间' },
  CONCAT: { sig: 'CONCAT(a, b, ...)', text: '拼接字符串，遇 NULL 结果为 NULL' },
  CONCAT_WS: { sig: "CONCAT_WS(sep, a, b)", text: '用分隔符拼接字符串' },
  SUBSTRING: { sig: 'SUBSTRING(s, pos, len)', text: '截取子串' },
  SUBSTRING_INDEX: { sig: "SUBSTRING_INDEX(s, ',', n)", text: '按分隔符取第 n 段' },
  TRIM: { sig: 'TRIM(s)', text: '去掉首尾空格' },
  UPPER: { sig: 'UPPER(s)', text: '转大写' },
  LOWER: { sig: 'LOWER(s)', text: '转小写' },
  LENGTH: { sig: 'LENGTH(s)', text: '字节长度' },
  CHAR_LENGTH: { sig: 'CHAR_LENGTH(s)', text: '字符长度' },
  ROUND: { sig: 'ROUND(x, n)', text: '四舍五入到 n 位小数' },
  FLOOR: { sig: 'FLOOR(x)', text: '向下取整' },
  CEIL: { sig: 'CEIL(x)', text: '向上取整' },
  ABS: { sig: 'ABS(x)', text: '绝对值' },
  RAND: { sig: 'RAND()', text: '0–1 之间的随机数' },
  MD5: { sig: 'MD5(s)', text: 'MD5 摘要' },
  SHA2: { sig: 'SHA2(s, 256)', text: 'SHA-2 摘要' },
  UUID: { sig: 'UUID()', text: '生成 UUID' },
  IFNULL: { sig: 'IFNULL(x, fallback)', text: 'x 为 NULL 时用默认值' },
  NULLIF: { sig: 'NULLIF(a, b)', text: 'a 等于 b 时返回 NULL' },
  COALESCE: { sig: 'COALESCE(a, b, ...)', text: '返回第一个非 NULL 值' },
  GREATEST: { sig: 'GREATEST(a, b)', text: '取较大值' },
  LEAST: { sig: 'LEAST(a, b)', text: '取较小值' },
  CAST: { sig: 'CAST(x AS type)', text: '显式类型转换' },
  CONVERT: { sig: 'CONVERT(x, type)', text: '类型或字符集转换' },
  REGEXP_REPLACE: { sig: 'REGEXP_REPLACE(s, pat, rep)', text: '正则替换' },
  REGEXP_LIKE: { sig: 'REGEXP_LIKE(s, pat)', text: '正则匹配判断' },
  LOCATE: { sig: 'LOCATE(sub, s)', text: '子串位置' },
  REPLACE: { sig: 'REPLACE(s, from, to)', text: '字符串替换' },
  LEFT: { sig: 'LEFT(s, n)', text: '取左边 n 个字符' },
  RIGHT: { sig: 'RIGHT(s, n)', text: '取右边 n 个字符' },
  LPAD: { sig: 'LPAD(s, n, pad)', text: '左侧补齐到指定长度' },
  LAST_INSERT_ID: { sig: 'LAST_INSERT_ID()', text: '上一条插入的自增 ID' },
  ROW_COUNT: { sig: 'ROW_COUNT()', text: '上一条语句影响的行数' },
  DATABASE: { sig: 'DATABASE()', text: '当前数据库名' },
  USER: { sig: 'USER()', text: '当前用户' },
  VERSION: { sig: 'VERSION()', text: 'MySQL 版本' },
};

const FUNCTION_EXAMPLES: Record<string, string> = {
  COUNT: 'SELECT status, COUNT(*) AS total FROM orders GROUP BY status;',
  SUM: 'SELECT SUM(total) AS revenue FROM orders;',
  AVG: 'SELECT AVG(total) FROM orders WHERE status = \'paid\';',
  MIN: 'SELECT MIN(created_at) FROM orders;',
  MAX: 'SELECT MAX(total) FROM orders;',
  GROUP_CONCAT: 'SELECT customer_id, GROUP_CONCAT(order_no) FROM orders GROUP BY customer_id;',
  JSON_EXTRACT: "SELECT JSON_EXTRACT(meta, '$.source') FROM events;",
  JSON_UNQUOTE: "SELECT JSON_UNQUOTE(JSON_EXTRACT(meta, '$.name')) FROM events;",
  NOW: "SELECT * FROM orders WHERE created_at >= NOW() - INTERVAL 1 DAY;",
  CURDATE: 'SELECT * FROM orders WHERE DATE(created_at) = CURDATE();',
  DATE_FORMAT: "SELECT DATE_FORMAT(created_at, '%Y-%m') AS month, COUNT(*) FROM orders GROUP BY month;",
  DATE_SUB: 'SELECT DATE_SUB(NOW(), INTERVAL 7 DAY);',
  DATE_ADD: 'SELECT DATE_ADD(NOW(), INTERVAL 1 MONTH);',
  DATEDIFF: 'SELECT DATEDIFF(shipped_at, created_at) FROM orders;',
  TIMESTAMPDIFF: 'SELECT TIMESTAMPDIFF(HOUR, created_at, shipped_at) FROM orders;',
  UNIX_TIMESTAMP: 'SELECT UNIX_TIMESTAMP(created_at) FROM orders;',
  FROM_UNIXTIME: 'SELECT FROM_UNIXTIME(1700000000);',
  CONCAT: "SELECT CONCAT(first_name, ' ', last_name) AS name FROM customers;",
  SUBSTRING: 'SELECT SUBSTRING(order_no, 1, 8) FROM orders;',
  TRIM: 'SELECT TRIM(name) FROM customers;',
  UPPER: 'SELECT UPPER(status) FROM orders;',
  LOWER: 'SELECT LOWER(email) FROM customers;',
  ROUND: 'SELECT ROUND(AVG(total), 2) FROM orders;',
  IFNULL: 'SELECT IFNULL(city, \'未知\') FROM customers;',
  COALESCE: 'SELECT COALESCE(shipped_at, created_at) FROM orders;',
  CAST: 'SELECT CAST(total AS DECIMAL(12,2)) FROM orders;',
  LAST_INSERT_ID: 'SELECT LAST_INSERT_ID();',
  DATABASE: 'SELECT DATABASE();',
  VERSION: 'SELECT VERSION();',
};

const SNIPPETS: { label: string; detail: string; info: string; template: string; cursor?: number }[] = [
  {
    label: 'select-from',
    detail: '查询片段',
    info: '生成 SELECT * FROM ，光标停在表名位置',
    template: 'SELECT * FROM ',
  },
  {
    label: 'select-where',
    detail: '查询片段',
    info: '生成带 WHERE 和排序的查询骨架',
    template: 'SELECT *\nFROM \nWHERE \nORDER BY \nLIMIT 100;',
  },
  {
    label: 'insert-into',
    detail: '写入片段',
    info: '生成 INSERT INTO … VALUES 骨架',
    template: 'INSERT INTO  ()\nVALUES ();',
  },
  {
    label: 'update-set',
    detail: '写入片段',
    info: '生成 UPDATE … SET … WHERE 骨架',
    template: 'UPDATE \nSET \nWHERE ;',
  },
  {
    label: 'delete-from',
    detail: '写入片段',
    info: '生成带 WHERE 的 DELETE',
    template: 'DELETE FROM \nWHERE ;',
  },
  {
    label: 'join-on',
    detail: '查询片段',
    info: '生成 JOIN … ON 连接片段',
    template: 'JOIN  ON . = .',
  },
  {
    label: 'left-join',
    detail: '查询片段',
    info: '生成 LEFT JOIN … ON 片段',
    template: 'LEFT JOIN  ON . = .',
  },
  {
    label: 'group-by',
    detail: '查询片段',
    info: '按字段分组并统计行数',
    template: 'SELECT , COUNT(*) AS total\nFROM \nGROUP BY \nORDER BY total DESC;',
  },
  {
    label: 'create-table',
    detail: 'DDL 片段',
    info: '生成建表骨架（主键 + 时间字段）',
    template: 'CREATE TABLE  (\n  id BIGINT NOT NULL AUTO_INCREMENT,\n  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (id)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;',
  },
  {
    label: 'with-cte',
    detail: '查询片段',
    info: '生成 CTE 骨架',
    template: 'WITH  AS (\n  SELECT * FROM \n)\nSELECT * FROM ;',
  },
];

const RESERVED = new Set([
  ...Object.keys(KEYWORDS),
  'ON', 'USING', 'WHERE', 'GROUP', 'ORDER', 'LIMIT', 'SET', 'VALUES', 'AND', 'OR',
  'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'JOIN', 'UNION', 'HAVING', 'AS',
]);

export type CompletionMode = 'table' | 'column' | 'any';

export interface QueryContext {
  mode: CompletionMode;
  qualifier: string;
  aliases: Record<string, string>;
}

function cleanIdent(value: string) {
  return value.replace(/`/g, '');
}

/** Guess what the user is about to type, and collect FROM/JOIN aliases. */
export function readQueryContext(textBefore: string): QueryContext {
  const tail = textBefore.slice(-80);
  const aliases: Record<string, string> = {};
  const aliasPattern = /\b(?:from|join|update|into)\s+(`?[\w$]+`?)(?:\s+(?:as\s+)?(`?[\w$]+`?))?/gi;
  let match: RegExpExecArray | null;
  while ((match = aliasPattern.exec(textBefore))) {
    const table = cleanIdent(match[1]);
    const alias = match[2] ? cleanIdent(match[2]) : '';
    if (alias && !RESERVED.has(alias.toUpperCase()) && alias.toUpperCase() !== table.toUpperCase()) {
      aliases[alias] = table;
    }
  }
  const firstTable = Object.values(aliases)[0];
  if (firstTable) aliases[firstTable] = firstTable;

  const qualifier = /([A-Za-z0-9_$`]+)\.\s*[A-Za-z0-9_$`]*$/.exec(tail)?.[1] || '';
  let mode: CompletionMode = 'any';
  if (/(?:\bfrom|\bjoin|\binto|\bupdate|\btable|\bdescribe|\bdesc|\bexists)\s*$/i.test(tail)) {
    mode = 'table';
  } else if (
    /(?:\bselect|\bwhere|\bon|\bhaving|\bgroup\s+by|\border\s+by|\bset|\band|\bor|\bby|,|\()\s*$/i.test(tail)
  ) {
    mode = 'column';
  }
  return { mode, qualifier: cleanIdent(qualifier), aliases };
}

function quoteIfNeeded(name: string) {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) ? name : `\`${name.replace(/`/g, '``')}\``;
}

function buildTip(title: string, subtitle: string, body: string, code?: string) {
  const root = document.createElement('div');
  root.className = 'cm-sql-tip';
  const head = document.createElement('div');
  head.className = 'cm-sql-tip-head';
  const name = document.createElement('strong');
  name.textContent = title;
  head.appendChild(name);
  if (subtitle) {
    const tag = document.createElement('span');
    tag.textContent = subtitle;
    head.appendChild(tag);
  }
  root.appendChild(head);
  if (code) {
    const pre = document.createElement('code');
    pre.className = 'cm-sql-tip-code';
    pre.textContent = code;
    root.appendChild(pre);
  }
  if (body) {
    const text = document.createElement('p');
    text.textContent = body;
    root.appendChild(text);
  }
  return root;
}

function columnTip(column: ColumnInfo, table: string) {
  const meta = [column.columnType, column.nullable === 'NO' ? 'NOT NULL' : '可空'];
  if (column.columnKey === 'PRI') meta.push('主键');
  if (column.extra) meta.push(column.extra);
  if (column.defaultValue) meta.push(`默认 ${column.defaultValue}`);
  const body = column.comment
    ? `${column.comment}。可以出现在 SELECT、WHERE、ORDER BY、GROUP BY 中。`
    : `属于 ${table} 表，可出现在 SELECT、WHERE、ORDER BY、GROUP BY 中。`;
  return buildTip(
    column.name,
    `${table} · 字段`,
    body,
    `${meta.join(' · ')}\n示例：SELECT ${column.name} FROM ${table} LIMIT 10;`,
  );
}

export function finchCompletions(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/[A-Za-z0-9_$`.]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  const raw = word.text;
  const dotIndex = raw.lastIndexOf('.');
  const qualifier = dotIndex >= 0 ? cleanIdent(raw.slice(0, dotIndex)) : '';
  const prefix = dotIndex >= 0 ? raw.slice(dotIndex + 1) : raw;
  const from = word.to - prefix.length;

  const state = useStore.getState();
  const tab = state.tabs.find((item) => item.id === state.activeTabId);
  const sessionId = tab?.sessionId;
  const database = tab?.database || '';
  const statement = context.state.sliceDoc(0, context.pos);
  const query = readQueryContext(statement);
  const activeQualifier = qualifier || query.qualifier;
  const aliases = query.aliases;

  const options: Completion[] = [];
  const seen = new Set<string>();
  const push = (completion: Completion) => {
    const key = `${completion.type}:${completion.label}`;
    if (seen.has(key)) return;
    seen.add(key);
    options.push(completion);
  };

  const databases = sessionId ? state.databases[sessionId] || [] : [];
  const tables = sessionId ? state.tables[`${sessionId}::${database}`] || [] : [];
  const views = sessionId ? state.views[`${sessionId}::${database}`] || [] : [];
  const allColumns = sessionId ? state.columns[`${sessionId}::${database}`] : undefined;

  const tableNames = new Set([...tables, ...views].map((item) => item.name));
  const aliasTarget = activeQualifier && aliases[activeQualifier] ? aliases[activeQualifier] : '';
  const qualifierIsTable = activeQualifier && (tableNames.has(activeQualifier) || Boolean(aliasTarget));
  const qualifierTable = aliasTarget || (qualifierIsTable ? activeQualifier : '');

  const columnsFor = (table: string): ColumnInfo[] => {
    const cached = allColumns?.[table];
    if (cached?.length) return cached;
    for (const item of state.tabs) {
      if (item.kind !== 'table' || item.table !== table || item.sessionId !== sessionId) continue;
      if (item.tableData?.columnMeta?.length) return item.tableData.columnMeta;
      if (item.tableDetails?.columns?.length) return item.tableDetails.columns;
    }
    return [];
  };

  const mentionedTables = new Set<string>();
  for (const table of Object.values(aliases)) mentionedTables.add(table);
  if (qualifierTable) mentionedTables.add(qualifierTable);

  if (qualifierTable) {
    for (const column of columnsFor(qualifierTable)) {
      push({
        label: column.name,
        type: 'property',
        detail: `${column.columnType}${column.columnKey === 'PRI' ? ' · 主键' : ''}`,
        apply: quoteIfNeeded(column.name),
        boost: 90,
        info: () => columnTip(column, qualifierTable),
      });
    }
  } else if (query.mode !== 'table') {
    const columnTables = mentionedTables.size
      ? [...mentionedTables]
      : [...tableNames].slice(0, 40);
    for (const table of columnTables) {
      const primary = mentionedTables.size <= 1 && mentionedTables.has(table);
      for (const column of columnsFor(table)) {
        push({
          label: column.name,
          type: 'property',
          detail: `${table} · ${column.columnType}`,
          apply: quoteIfNeeded(column.name),
          boost: primary ? 80 : 34,
          info: () => columnTip(column, table),
        });
      }
    }
  }

  if (!activeQualifier) {
    for (const db of databases) {
      push({
        label: db.name,
        type: 'namespace',
        detail: '数据库',
        boost: query.mode === 'table' ? 60 : 12,
        info: () => buildTip(db.name, '数据库', `${db.charset} · ${db.collation}`, ''),
      });
    }
  }

  const tableBoost = query.mode === 'table' ? 70 : 24;
  for (const table of tables) {
    push({
      label: table.name,
      type: 'class',
      detail: `表 · ${table.rowEstimate ?? 0} 行`,
      apply: quoteIfNeeded(table.name),
      boost: tableBoost + 10,
      info: () =>
        buildTip(
          table.name,
          '数据表',
          table.comment || '这张表没有注释。双击可以从数据页浏览它的内容。',
          `${table.engine || 'TABLE'} · 约 ${table.rowEstimate ?? 0} 行\n示例：SELECT * FROM ${table.name} LIMIT 100;`,
        ),
    });
  }
  for (const view of views) {
    push({
      label: view.name,
      type: 'interface',
      detail: '视图',
      apply: quoteIfNeeded(view.name),
      boost: tableBoost,
      info: () =>
        buildTip(
          view.name,
          '视图',
          view.comment || '只读视图，可像表一样查询。',
          `示例：SELECT * FROM ${view.name} LIMIT 100;`,
        ),
    });
  }

  const snippetBoost = query.mode === 'any' ? 30 : 4;
  for (const snippet of SNIPPETS) {
    push({
      label: snippet.label,
      type: 'text',
      detail: snippet.detail,
      boost: snippetBoost,
      apply: (view, _completion, applyFrom, applyTo) => {
        view.dispatch({
          changes: { from: applyFrom, to: applyTo, insert: snippet.template },
          selection: { anchor: applyFrom + snippet.template.length },
        });
      },
      info: () => buildTip(snippet.label, snippet.detail, snippet.info, snippet.template.split('\n')[0]),
    });
  }

  const keywordBoost = query.mode === 'any' ? 6 : 2;
  for (const [keyword, doc] of Object.entries(KEYWORDS)) {
    push({
      label: keyword,
      type: 'keyword',
      detail: doc,
      boost: keywordBoost,
      info: () => buildTip(keyword, 'SQL 关键字', doc, KEYWORD_EXAMPLES[keyword] || ''),
    });
  }
  for (const [name, meta] of Object.entries(FUNCTIONS)) {
    push({
      label: name,
      type: 'function',
      detail: meta.sig,
      apply: `${name}()`,
      boost: keywordBoost + 2,
      info: () =>
        buildTip(name, 'MySQL 函数', meta.text, `${meta.sig}\n示例：${FUNCTION_EXAMPLES[name] || ''}`),
    });
  }

  return {
    from,
    options,
    validFor: /^[\w$`]*$/,
  };
}
