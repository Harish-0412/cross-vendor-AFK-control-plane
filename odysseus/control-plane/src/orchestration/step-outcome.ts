/**
 * What a finished step produced, read back from its session's events.
 *
 * Adapters differ in what they emit — Claude and Codex send `session.message`,
 * OpenCode mostly `session.output` — so the agent's final text is taken from
 * whichever is present, preferring the assistant's own messages. The parsers
 * in agent-roles then read the role's markers out of that text.
 */
import type { OrchestrationStep, StepOutcome } from '@odysseus/protocol';

import type { IDatabase } from '../db/types';

import { HANDOFF_LIMITS, parseReview, parseTestResult, truncate } from './agent-roles';

/** Events read per session. A step's final answer is near the end, so this is ample. */
const MAX_EVENTS = 5_000;
/** Assistant text kept for parsing; a plan or review block fits well inside this. */
const MAX_TEXT_CHARS = 60_000;

export interface CollectedOutput {
  /** Everything the agent said, oldest first, bounded. */
  text: string;
  /** The final message alone — what "the agent's answer" means to a person. */
  finalMessage: string;
  filesChanged: string[];
}

export async function collectOutput(db: IDatabase, sessionId: string): Promise<CollectedOutput> {
  const events = await db.events.listBySession(sessionId, 0, MAX_EVENTS);
  const assistant: string[] = [];
  const output: string[] = [];
  const files = new Set<string>();
  let completionResult = '';

  for (const event of events) {
    const payload = (event.envelope.payload ?? {}) as Record<string, unknown>;
    switch (event.eventType) {
      case 'session.message':
        if (payload['role'] === 'assistant' && typeof payload['content'] === 'string')
          assistant.push(payload['content']);
        break;
      case 'session.output':
        if (typeof payload['content'] === 'string') output.push(payload['content']);
        break;
      case 'session.file_changed':
        if (typeof payload['path'] === 'string') files.add(payload['path']);
        break;
      case 'session.completed':
        if (typeof payload['result'] === 'string') completionResult = payload['result'];
        break;
    }
  }

  const pieces = assistant.length ? assistant : output;
  if (completionResult && !pieces.includes(completionResult)) pieces.push(completionResult);
  const text = tail(pieces.join('\n\n'), MAX_TEXT_CHARS);
  const finalMessage = (assistant.at(-1) ?? completionResult ?? output.at(-1) ?? '').trim();
  return { text, finalMessage, filesChanged: [...files] };
}

/** Turn a session's output into the outcome recorded on the step. */
export function outcomeFor(
  step: Pick<OrchestrationStep, 'taskKind'>,
  collected: CollectedOutput,
): StepOutcome {
  const outcome: StepOutcome = {
    summary: truncate(collected.finalMessage || collected.text, HANDOFF_LIMITS.summaryChars),
    filesChanged: collected.filesChanged,
  };
  if (step.taskKind === 'test') {
    const passed = parseTestResult(collected.text);
    if (passed !== undefined) outcome.testsPassed = passed;
  }
  if (step.taskKind === 'security_review') {
    const review = parseReview(collected.text);
    if (review) {
      outcome.verdict = review.verdict;
      outcome.findings = review.findings;
    }
  }
  return outcome;
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}
