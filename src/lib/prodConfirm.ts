import type { ConnectionProfile } from '../types';

export function isProdProfile(profile?: ConnectionProfile | null): boolean {
  return profile?.category === 'prod';
}

/** Detect statements that can destroy or rewrite production data/structures. */
export function hasDangerousSql(sql: string): boolean {
  const cleaned = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  return /(?:^|[\s(,;])(?:update|delete|drop|alter|truncate|rename|replace)\b/i.test(cleaned);
}
