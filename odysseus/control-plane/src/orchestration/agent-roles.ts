/**
 * The roles an orchestration step can play, and the contract each one keeps.
 *
 * Every role is played by an ordinary coding agent (Claude Code, Codex,
 * Antigravity, OpenCode, Freebuff) running on the user's own machine. There is
 * no server-side model and no server API key: a role is a set of instructions
 * put in front of the step's prompt, plus a small, strict output format the
 * orchestrator parses when the step finishes.
 *
 * The output formats are deliberately plain text markers rather than tool
 * calls, because every agent can print text and not every agent can call a
 * custom tool. Parsers are strict — a malformed plan is rejected, never
 * guessed at — because what they return decides what runs next.
 */
import type { OrchestrationStep, ReviewFinding, StepOutcome, TaskKind } from '@odysseus/protocol';

/** Agents the orchestrator may name. Anything else from a planner is dropped. */
export const KNOWN_AGENT_IDS = ['claude', 'codex', 'antigravity', 'opencode', 'freebuff'] as const;

/** Upper bounds on what a planner may create, so one reply cannot flood a run. */
export const PLAN_LIMITS = {
  maxSteps: 12,
  titleChars: 120,
  promptChars: 4_000,
} as const;

/** How much of earlier work is repeated into a later step's prompt. */
export const HANDOFF_LIMITS = {
  summaryChars: 2_500,
  filesListed: 40,
  findingsListed: 20,
  diffChars: 24_000,
} as const;

const TASK_KINDS: TaskKind[] = ['planning', 'implementation', 'test', 'security_review', 'general'];

export const PLAN_FENCE = 'odysseus-plan';
export const TEST_MARKER = 'ODYSSEUS_TEST_RESULT:';
export const REVIEW_FENCE = 'odysseus-review';

// ------------------------------------------------------------ instructions

const ROLE_INSTRUCTIONS: Record<TaskKind, string> = {
  planning: [
    'You are the PLANNER agent in a team of coding agents.',
    'Read the repository to understand it. Do NOT modify, create or delete any file,',
    'and do not run commands that change anything.',
    'Break the goal into small, concrete steps that other agents will carry out.',
    'Each step has a taskKind:',
    '  "implementation"  — writes or changes code',
    '  "test"            — runs the project\'s tests and reports the result',
    '  "security_review" — reviews the code changes for bugs and security problems',
    '  "general"         — anything else (docs, investigation)',
    'Rules:',
    '  - Put a "test" step after the implementation steps it checks.',
    '  - Put a "security_review" step after the implementation work.',
    '  - Use dependsOn to order steps; steps without a dependency between them may run in parallel.',
    `  - At most ${PLAN_LIMITS.maxSteps} steps. Each prompt must be self-contained: the agent that runs it`,
    '    will not see this conversation, only its own prompt and a summary of the steps it depends on.',
    '  - Only set "agent" if the step truly needs one tool; allowed values:',
    `    ${KNOWN_AGENT_IDS.join(', ')}.`,
    'End your reply with exactly one fenced block in this format and nothing after it:',
    '```' + PLAN_FENCE,
    '{"steps":[{"id":"short-id","title":"…","taskKind":"implementation","prompt":"…","dependsOn":[]}]}',
    '```',
  ].join('\n'),
  implementation: [
    'You are a BUILDER agent in a team of coding agents.',
    'Make the change described below in this repository. Keep the change focused on this step;',
    'other steps are handled by other agents. Do not commit, push or deploy.',
    'When you finish, end with a short summary of what you changed and anything the next agent',
    'should know.',
  ].join('\n'),
  test: [
    'You are the TEST agent in a team of coding agents.',
    'Find how this project runs its tests (package scripts, Makefile, CI config) and run the',
    'relevant tests. Do NOT change source code to make tests pass — report what fails instead.',
    'Summarise the failures precisely: test names, error messages and the likely cause.',
    `The LAST line of your reply must be exactly "${TEST_MARKER} PASS" or "${TEST_MARKER} FAIL".`,
  ].join('\n'),
  security_review: [
    'You are the REVIEWER agent in a team of coding agents.',
    'Review the code changes shown below for correctness bugs and security problems',
    '(injection, missing authorization, secrets, unsafe file or shell use, broken error handling).',
    'If no changes are shown below, run `git diff` yourself to see the uncommitted work.',
    'Do NOT modify any file. Report only real problems, each with a severity.',
    'End your reply with exactly one fenced block in this format and nothing after it:',
    '```' + REVIEW_FENCE,
    '{"verdict":"approve","findings":[{"severity":"high","file":"src/x.ts","line":10,"summary":"…"}]}',
    '```',
    'Use "changes_requested" when any finding is high or critical.',
  ].join('\n'),
  general: [
    'You are an agent in a team of coding agents. Carry out the task below in this repository.',
    'Do not commit, push or deploy. End with a short summary of what you did.',
  ].join('\n'),
};

export function roleInstructions(kind: TaskKind): string {
  return ROLE_INSTRUCTIONS[kind];
}

// ------------------------------------------------------------ prompt assembly

export interface PromptContext {
  goal?: string | undefined;
  /** Finished steps this one depends on, with what they produced. */
  dependencies: Array<
    Pick<OrchestrationStep, 'id' | 'title' | 'taskKind'> & { outcome?: StepOutcome }
  >;
  /** For review steps: the combined diff of the work under review. */
  diff?: string | undefined;
  /** Relevant past conversations, already trimmed by the context agent. */
  history?: string | undefined;
}

/**
 * The full prompt a step's agent receives: its role, the overall goal, what
 * the steps before it did, relevant past conversations, then its own task.
 */
export function buildStepPrompt(
  step: Pick<OrchestrationStep, 'taskKind' | 'prompt'>,
  ctx: PromptContext,
): string {
  const parts: string[] = [roleInstructions(step.taskKind)];
  if (ctx.goal) parts.push(`## Overall goal\n${ctx.goal}`);

  if (ctx.dependencies.length) {
    const lines = ctx.dependencies.map((dep) => {
      const outcome = dep.outcome;
      const bits = [`### ${dep.title} (${dep.taskKind})`];
      if (outcome?.summary) bits.push(truncate(outcome.summary, HANDOFF_LIMITS.summaryChars));
      if (outcome?.filesChanged.length) {
        const files = outcome.filesChanged.slice(0, HANDOFF_LIMITS.filesListed);
        const more = outcome.filesChanged.length - files.length;
        bits.push(`Files changed: ${files.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`);
      }
      if (outcome?.testsPassed !== undefined)
        bits.push(`Test result: ${outcome.testsPassed ? 'PASS' : 'FAIL'}`);
      if (outcome?.findings?.length) {
        bits.push(
          'Review findings to address:\n' +
            outcome.findings
              .slice(0, HANDOFF_LIMITS.findingsListed)
              .map(
                (f) =>
                  `- [${f.severity}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ''} ` : ''}${f.summary}`,
              )
              .join('\n'),
        );
      }
      return bits.join('\n');
    });
    parts.push(`## Work already done by other agents\n${lines.join('\n\n')}`);
  }

  if (ctx.history) parts.push(`## Relevant past conversations (for context only)\n${ctx.history}`);
  if (ctx.diff)
    parts.push(
      `## Changes to review\n\`\`\`diff\n${truncate(ctx.diff, HANDOFF_LIMITS.diffChars)}\n\`\`\``,
    );
  parts.push(`## Your task\n${step.prompt}`);
  return parts.join('\n\n');
}

// ------------------------------------------------------------ parsers

export interface PlannedStep {
  id: string;
  title: string;
  taskKind: TaskKind;
  prompt: string;
  dependsOn: string[];
  requiredAgentId?: string;
}

export type PlanParseResult = { ok: true; steps: PlannedStep[] } | { ok: false; error: string };

/**
 * Read the planner's plan. The last `odysseus-plan` block wins, so a planner
 * that quotes the format in its reasoning and then answers is read correctly.
 */
export function parsePlan(text: string): PlanParseResult {
  const block = lastFencedBlock(text, PLAN_FENCE);
  if (!block) return { ok: false, error: `The planner did not return an \`${PLAN_FENCE}\` block` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return { ok: false, error: 'The planner returned a plan that is not valid JSON' };
  }
  const rawSteps = (parsed as { steps?: unknown })?.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0)
    return { ok: false, error: 'The planner returned no steps' };
  if (rawSteps.length > PLAN_LIMITS.maxSteps)
    return { ok: false, error: `The planner returned more than ${PLAN_LIMITS.maxSteps} steps` };

  const steps: PlannedStep[] = [];
  const seen = new Set<string>();
  for (const raw of rawSteps) {
    if (!raw || typeof raw !== 'object')
      return { ok: false, error: 'A planned step is not an object' };
    const r = raw as Record<string, unknown>;
    const id = typeof r['id'] === 'string' ? slug(r['id']) : '';
    const title =
      typeof r['title'] === 'string' ? r['title'].trim().slice(0, PLAN_LIMITS.titleChars) : '';
    const prompt = typeof r['prompt'] === 'string' ? r['prompt'].trim() : '';
    const taskKind = r['taskKind'];
    if (!id || seen.has(id))
      return { ok: false, error: `Planned step id "${String(r['id'])}" is missing or repeated` };
    if (!title || !prompt)
      return { ok: false, error: `Planned step "${id}" needs a title and a prompt` };
    if (prompt.length > PLAN_LIMITS.promptChars)
      return {
        ok: false,
        error: `Planned step "${id}" has a prompt over ${PLAN_LIMITS.promptChars} characters`,
      };
    if (
      typeof taskKind !== 'string' ||
      !TASK_KINDS.includes(taskKind as TaskKind) ||
      taskKind === 'planning'
    )
      return { ok: false, error: `Planned step "${id}" has an invalid taskKind` };
    const dependsOn = Array.isArray(r['dependsOn'])
      ? r['dependsOn'].filter((d): d is string => typeof d === 'string').map(slug)
      : [];
    const agent = typeof r['agent'] === 'string' ? r['agent'] : r['requiredAgentId'];
    seen.add(id);
    steps.push({
      id,
      title,
      taskKind: taskKind as TaskKind,
      prompt,
      dependsOn,
      ...(typeof agent === 'string' && (KNOWN_AGENT_IDS as readonly string[]).includes(agent)
        ? { requiredAgentId: agent }
        : {}),
    });
  }
  for (const step of steps) {
    const unknown = step.dependsOn.find((d) => !seen.has(d) || d === step.id);
    if (unknown)
      return { ok: false, error: `Planned step "${step.id}" depends on unknown step "${unknown}"` };
  }
  return { ok: true, steps };
}

/** PASS, FAIL, or undefined when the test agent did not say. The last marker wins. */
export function parseTestResult(text: string): boolean | undefined {
  const matches = [...text.matchAll(/ODYSSEUS_TEST_RESULT:\s*(PASS|FAIL)\b/gi)];
  const last = matches.at(-1)?.[1];
  return last ? last.toUpperCase() === 'PASS' : undefined;
}

export function parseReview(
  text: string,
): { verdict: 'approve' | 'changes_requested'; findings: ReviewFinding[] } | undefined {
  const block = lastFencedBlock(text, REVIEW_FENCE);
  if (!block) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return undefined;
  }
  const record = parsed as { verdict?: unknown; findings?: unknown };
  const findings: ReviewFinding[] = (Array.isArray(record.findings) ? record.findings : [])
    .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === 'object')
    .map((f) => {
      const severity = ['low', 'medium', 'high', 'critical'].includes(String(f['severity']))
        ? (f['severity'] as ReviewFinding['severity'])
        : 'medium';
      return {
        severity,
        summary: String(f['summary'] ?? '').slice(0, 500),
        ...(typeof f['file'] === 'string' ? { file: f['file'].slice(0, 300) } : {}),
        ...(typeof f['line'] === 'number' && Number.isInteger(f['line'])
          ? { line: f['line'] }
          : {}),
      };
    })
    .filter((f) => f.summary.length > 0)
    .slice(0, 50);
  // A reviewer that approves while listing a high or critical problem has
  // contradicted itself; the finding is what counts.
  const blocking = findings.some((f) => f.severity === 'high' || f.severity === 'critical');
  const verdict =
    record.verdict === 'changes_requested' || blocking ? 'changes_requested' : 'approve';
  return { verdict, findings };
}

// ------------------------------------------------------------ helpers

function lastFencedBlock(text: string, fence: string): string | undefined {
  const pattern = new RegExp('```' + fence + '\\s*\\n([\\s\\S]*?)```', 'g');
  const blocks = [...text.matchAll(pattern)];
  return blocks.at(-1)?.[1]?.trim();
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… [truncated]`;
}
