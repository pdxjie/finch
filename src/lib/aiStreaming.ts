/** Hide a partial Markdown fence while legacy models stream fenced SQL. */
export function streamedSql(raw: string): string {
  const text = raw.trimStart();
  if (!text) return '';
  if (/^`{1,2}$/.test(text)) return '';
  if (!text.startsWith('```')) {
    // Keep a natural-language refusal or explanation valid in the SQL editor.
    // SQL itself remains untouched, including identifiers quoted with backticks.
    if (/^(SELECT|WITH|SHOW|DESC|DESCRIBE|EXPLAIN|TABLE|VALUES|INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|TRUNCATE)\b/i.test(text)) return text;
    return text.split(/\r?\n/).map((line) => /^\s*--/.test(line) ? line : `-- ${line}`).join('\n');
  }
  const newline = text.indexOf('\n');
  if (newline < 0) return '';
  return text.slice(newline + 1).replace(/(?:^|\r?\n)[ \t]*`{1,3}[ \t]*$/, '');
}
