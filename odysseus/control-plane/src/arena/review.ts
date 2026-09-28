/**
 * Cross-vendor review: code written by one vendor's agent, judged by
 * another's. The reviewer is told what the task was, what the tests said and
 * what changed — never which agent wrote it.
 */
import { lastJsonBlock } from './serial';
import type { CrossReview, WorkspaceEvaluation } from './types';

export const SCORE_FENCE = 'odysseus-score';
const MAX_DIFF_IN_PROMPT = 60_000;

export function reviewPrompt(input: {
  task: string;
  entryLabel: string;
  evaluation: Pick<WorkspaceEvaluation, 'tests' | 'files' | 'diff' | 'diffTruncated'>;
}): string {
  const { tests } = input.evaluation;
  const testLine = tests.ran
    ? `${tests.command}: ${tests.passed ? 'PASSED' : 'FAILED'}${tests.summary ? ` (${tests.summary})` : ''}`
    : 'This project has no test command, so nothing was run.';
  const diff = input.evaluation.diff.slice(0, MAX_DIFF_IN_PROMPT);
  const truncated =
    input.evaluation.diffTruncated || input.evaluation.diff.length > MAX_DIFF_IN_PROMPT;
  return [
    `You are reviewing ${input.entryLabel}: a solution another AI coding agent wrote for the task below. You did not write it.`,
    'Do not edit, create or delete any files. Only read and judge.',
    '',
    '## The task it was given',
    '',
    input.task.trim(),
    '',
    '## Test results',
    '',
    testLine,
    '',
    `## The change (${input.evaluation.files.length} files)`,
    '',
    '```diff',
    diff || '(no changes were made)',
    '```',
    truncated ? '\n(The diff was cut short; read the files in this folder for the rest.)' : '',
    '',
    'Judge: does it do what the task asks, completely? Is it correct? Is the code clear and safe? Does it change things it should not?',
    '',
    'End your answer with exactly one block in this format:',
    '',
    '```' + SCORE_FENCE,
    '{"score": 7, "verdict": "approve", "summary": "One or two sentences.", "issues": ["Short issue", "Another"]}',
    '```',
    '',
    'score is 0 (does not solve the task) to 10 (complete, correct and clean). verdict is "approve" or "changes_requested".',
  ].join('\n');
}

export function parseScore(
  text: string,
): Pick<CrossReview, 'score' | 'verdict' | 'summary' | 'issues'> | null {
  const block = lastJsonBlock(text, SCORE_FENCE);
  if (!block) return null;
  const score = Number(block['score']);
  if (!Number.isFinite(score)) return null;
  const verdict = block['verdict'] === 'approve' ? 'approve' : 'changes_requested';
  return {
    score: Math.max(0, Math.min(10, Math.round(score * 10) / 10)),
    verdict,
    ...(typeof block['summary'] === 'string' ? { summary: block['summary'].slice(0, 600) } : {}),
    ...(Array.isArray(block['issues'])
      ? {
          issues: block['issues']
            .filter((issue): issue is string => typeof issue === 'string')
            .map((issue) => issue.slice(0, 300))
            .slice(0, 10),
        }
      : {}),
  };
}

/**
 * Tests 60 + review 40. When a project has no tests, or a review could not
 * be had, that part scores half: neither rewarded nor punished.
 */
export function scoreEntry(
  evaluation: Pick<WorkspaceEvaluation, 'tests' | 'files'> | undefined,
  review: CrossReview | undefined,
): { total: number; tests: number; review: number; notes: string[] } {
  const notes: string[] = [];
  let tests = 0;
  if (!evaluation) {
    notes.push('No result to score');
  } else if (evaluation.files.length === 0) {
    notes.push('Made no changes');
  } else if (!evaluation.tests.ran) {
    tests = 30;
    notes.push('No test command in this project: tests count as neutral');
  } else if (evaluation.tests.passed) {
    tests = 60;
    notes.push('Tests pass');
  } else {
    notes.push('Tests fail');
  }
  let reviewPoints = 0;
  if (evaluation && evaluation.files.length > 0) {
    if (review?.state === 'done' && typeof review.score === 'number') {
      reviewPoints = Math.round((review.score / 10) * 40);
      notes.push(`Reviewer scored it ${review.score}/10`);
    } else {
      reviewPoints = 20;
      notes.push('No review available: review counts as neutral');
    }
  }
  return { total: tests + reviewPoints, tests, review: reviewPoints, notes };
}
