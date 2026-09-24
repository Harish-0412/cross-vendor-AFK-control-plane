/**
 * Ranking for the command palette: by words, not scattered letters.
 *
 * cmdk's default is a loose subsequence match, so "bud" ranked a session
 * above Budgets by finding b, u and d spread through an id. Here a match must
 * be a real substring: the start of the label ranks highest, the start of a
 * word next, anywhere inside a word lowest. Every search term must match, so
 * "codex pc" narrows rather than widens. Returns 0 for no match, else (0, 1].
 */
export function rankCommand(value: string, search: string): number {
  const haystack = value.toLowerCase();
  const terms = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 1;
  let score = 0;
  for (const term of terms) {
    const at = haystack.indexOf(term);
    if (at === -1) return 0;
    if (at === 0) score += 3;
    else if (/[\s\-_./]/.test(haystack[at - 1] ?? "")) score += 2;
    else score += 1;
  }
  return score / (terms.length * 3);
}
