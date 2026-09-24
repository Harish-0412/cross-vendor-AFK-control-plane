/**
 * The context agent: brings relevant past conversations into a new step.
 *
 * Conversations imported from Codex, Claude Code and Antigravity are already
 * in the database — titles for all of them, message text for those whose
 * content was synced — and were redacted on the workstation before they left
 * it. This picks the few most relevant to a step and summarises them into a
 * bounded block of the prompt.
 *
 * It is deterministic ranking, not a model: a step's prompt is shown to the
 * user and is governed like any other input, so what goes into it should be
 * explainable ("matched 'login' and 'session' in a conversation from this
 * project"), and it must not cost a model call per step.
 *
 * Only the requesting user's own conversations are ever considered.
 */
import type { IDatabase, ExternalConversationRecord } from '../db/types';

export const CONTEXT_LIMITS = {
  /** Conversations included per step. */
  maxConversations: 4,
  /** Characters of the whole context block. */
  maxChars: 6_000,
  /** Characters quoted from one conversation. */
  excerptChars: 1_200,
  /** Conversations older than this are ignored. */
  maxAgeDays: 90,
} as const;

const STOP_WORDS = new Set(
  (
    'a an and are as at be by for from has have in into is it its of on or that the this to was ' +
    'were will with you your we our make add fix use using should can new all any each then when ' +
    'step task code file files project repository agent run tests test review change changes'
  ).split(' '),
);

export interface ContextSelection {
  block: string;
  conversationIds: string[];
}

export class ContextAgent {
  constructor(
    private readonly db: IDatabase,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Pick past conversations relevant to `query` for `userId`, favouring ones
   * from the same project folder. Returns an empty selection when nothing
   * clears the relevance bar — no context is better than unrelated context.
   */
  async select(userId: string, query: string, projectRoot?: string): Promise<ContextSelection> {
    const terms = keywords(query);
    if (terms.length === 0) return { block: '', conversationIds: [] };

    const records = await this.db.externalConversations.listByUser(userId);
    const cutoff = this.now() - CONTEXT_LIMITS.maxAgeDays * 86_400_000;
    const projectName = projectRoot ? folderName(projectRoot) : '';

    const scored = records
      .filter((record) => record.userId === userId)
      .filter((record) => Date.parse(record.updatedAt) >= cutoff)
      .map((record) => ({ record, ...score(record, terms, projectName) }))
      .filter((item) => item.matched.length > 0 && item.score >= 2)
      .sort(
        (a, b) =>
          b.score - a.score || Date.parse(b.record.updatedAt) - Date.parse(a.record.updatedAt),
      )
      .slice(0, CONTEXT_LIMITS.maxConversations);

    if (scored.length === 0) return { block: '', conversationIds: [] };

    const sections: string[] = [];
    let used = 0;
    const ids: string[] = [];
    for (const { record, matched } of scored) {
      const header =
        `- "${record.title}" (${record.integration}, ${record.updatedAt.slice(0, 10)}` +
        `${record.workspace ? `, ${record.workspace}` : ''}) — matched: ${matched.join(', ')}`;
      const excerpt = record.searchText ? excerptAround(record.searchText, matched) : '';
      const section = excerpt ? `${header}\n  ${excerpt.replace(/\n+/g, ' ')}` : header;
      if (used + section.length > CONTEXT_LIMITS.maxChars) break;
      sections.push(section);
      ids.push(record.id);
      used += section.length;
    }
    return {
      block:
        "These are excerpts from the user's earlier conversations with coding agents. " +
        'Use them only as background; the task below takes precedence.\n' +
        sections.join('\n'),
      conversationIds: ids,
    };
  }
}

function keywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
  return [...new Set(words)].slice(0, 40);
}

function score(
  record: ExternalConversationRecord,
  terms: string[],
  projectName: string,
): { score: number; matched: string[] } {
  const title = record.title.toLowerCase();
  const body = (record.searchText ?? '').toLowerCase();
  const matched: string[] = [];
  let total = 0;
  for (const term of terms) {
    const inTitle = title.includes(term);
    const inBody = body.includes(term);
    if (inTitle || inBody) matched.push(term);
    if (inTitle) total += 2;
    else if (inBody) total += 1;
  }
  if (projectName && record.workspace && folderName(record.workspace) === projectName) total += 2;
  return { score: total, matched };
}

function folderName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .at(-1)
      ?.toLowerCase() ?? ''
  );
}

function excerptAround(text: string, matched: string[]): string {
  const lower = text.toLowerCase();
  const first = matched
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  if (first === undefined) return '';
  const start = Math.max(0, first - 200);
  const slice = text.slice(start, start + CONTEXT_LIMITS.excerptChars).trim();
  return `${start > 0 ? '…' : ''}${slice}${start + CONTEXT_LIMITS.excerptChars < text.length ? '…' : ''}`;
}
