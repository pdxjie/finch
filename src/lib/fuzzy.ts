/** Case-insensitive substring or subsequence match, used for quick table search. */
export function fuzzyMatch(text: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = text.toLowerCase();
  if (haystack.includes(needle)) return true;
  let at = 0;
  for (const char of haystack) {
    if (char === needle[at]) at += 1;
    if (at === needle.length) return true;
  }
  return false;
}
