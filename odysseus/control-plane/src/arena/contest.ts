/**
 * Contest (best-of-N across vendors): the same task, several vendors' real
 * CLIs, one winner chosen by the project's own tests and a review from a
 * different vendor.
 *
 *  1. Each chosen agent gets its own git worktree at the current commit and
 *     works there, in parallel, without seeing the others.
 *  2. When an agent finishes, its worktree is evaluated on the workstation:
 *     the diff, and the project's test command.
 *  3. Every entry is reviewed by an agent of a different vendor, which is not
 *     told who wrote it.
 *  4. Score = tests (60) + review (40). The user applies the winner, which
 *     becomes a branch in their repository; nothing is merged for them.
 */
import { randomUUID } from 'node:crypto';

import type { ArenaNotifier } from './never-idle';
import { parseScore, reviewPrompt, scoreEntry } from './review';
import { agentName, TERMINAL_SESSION_STATES, type ArenaRuntime } from './runtime';
import { Serial } from './serial';
import type { Contest, ContestEntry, WorkspaceEvaluation } from './types';

/** Kept per entry for the web app; the full diff stays on the workstation. */
const STORED_DIFF_CHARS = 60_000;
const ENTRY_LETTERS = 'ABCDEF';

export class ContestService {
  private readonly serial = new Serial();

  constructor(
    private readonly runtime: ArenaRuntime,
    private readonly notify: ArenaNotifier = () => undefined,
  ) {}

  async list(userId: string): Promise<Contest[]> {
    const records = await this.runtime.db.documents.listByUser<Contest>('contests', userId);
    return records
      .map((record) => withoutDiffs(record.data))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  async get(userId: string, id: string): Promise<Contest> {
    const record = await this.runtime.db.documents.get<Contest>('contests', id);
    if (!record || record.userId !== userId) throw new ArenaError(404, 'Contest not found');
    return record.data;
  }

  async create(
    userId: string,
    input: { projectId?: unknown; deviceId?: unknown; task?: unknown; agents?: unknown },
  ): Promise<Contest> {
    const task = typeof input.task === 'string' ? input.task.trim() : '';
    if (!task) throw new ArenaError(400, 'Describe the task the agents should do.');
    if (task.length > 8_000) throw new ArenaError(400, 'The task is longer than 8000 characters.');
    const project =
      typeof input.projectId === 'string'
        ? await this.runtime.db.projects.findById(input.projectId)
        : null;
    if (!project || project.userId !== userId) throw new ArenaError(404, 'Project not found');
    const device =
      typeof input.deviceId === 'string'
        ? await this.runtime.db.devices.findById(input.deviceId)
        : null;
    if (!device || device.userId !== userId) throw new ArenaError(404, 'Machine not found');
    if (!this.runtime.isOnline(device.id))
      throw new ArenaError(409, `${device.friendlyName} is offline. Start its gateway first.`);

    const agents = [
      ...new Set(
        (Array.isArray(input.agents) ? input.agents : []).filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        ),
      ),
    ];
    if (agents.length < 2 || agents.length > 4)
      throw new ArenaError(400, 'Choose between 2 and 4 agents to compete.');
    const installed = await this.runtime.installedAgents(device.id);
    const missing = agents.filter((id) => !installed.includes(id));
    if (missing.length)
      throw new ArenaError(
        409,
        `${missing.map(agentName).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not installed on ${device.friendlyName}.`,
      );

    const now = new Date().toISOString();
    const contest: Contest = {
      id: `contest_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      userId,
      projectId: project.id,
      projectName: project.name,
      projectRoot: project.root,
      deviceId: device.id,
      task,
      state: 'running',
      entries: agents.map((agentId) => ({ agentId, state: 'preparing' })),
      createdAt: now,
      updatedAt: now,
    };
    await this.save(contest);
    void Promise.all(agents.map((agentId) => this.startEntry(contest.id, agentId))).catch(
      () => undefined,
    );
    return contest;
  }

  private async startEntry(contestId: string, agentId: string): Promise<void> {
    const contest = await this.load(contestId);
    if (!contest || contest.state !== 'running') return;
    try {
      const workspace = await this.runtime.prepareWorkspace(
        contest.deviceId,
        contest.projectRoot,
        'HEAD',
        `contest-${agentId}`,
      );
      await this.update(contestId, (current) => {
        const entry = entryFor(current, agentId);
        entry.workspaceRoot = workspace.workspaceRoot;
        entry.baseCommit = workspace.commit;
      });
      const started = await this.runtime.startSession({
        userId: contest.userId,
        deviceId: contest.deviceId,
        agentId,
        projectId: contest.projectId,
        projectRoot: workspace.workspaceRoot,
        prompt: contestPrompt(contest.task),
        taskKind: 'implementation',
        purpose: 'contest entry',
        metadata: { arena: 'contest', contestId, contestRole: 'entry', entryAgent: agentId },
      });
      await this.update(contestId, (current) => {
        const entry = entryFor(current, agentId);
        entry.sessionId = started.sessionId || undefined;
        entry.startedAt ??= new Date().toISOString();
        // A fast agent can finish before this runs; its result stands.
        if (entry.state !== 'preparing') return;
        if (started.state === 'failed') {
          entry.state = 'failed';
          entry.error = started.error ?? 'The agent did not start';
        } else {
          entry.state = 'running';
        }
      });
    } catch (error) {
      await this.update(contestId, (current) => {
        const entry = entryFor(current, agentId);
        entry.state = 'failed';
        entry.error = message(error);
      });
    }
    await this.maybeJudge(contestId);
  }

  // ------------------------------------------------------------- the hook

  async onSessionFinished(sessionId: string): Promise<void> {
    const session = await this.runtime.db.sessions.findById(sessionId);
    const metadata = session?.config.metadata ?? {};
    if (!session || metadata['arena'] !== 'contest' || !TERMINAL_SESSION_STATES.has(session.state))
      return;
    const contestId = String(metadata['contestId'] ?? '');
    const agentId = String(metadata['entryAgent'] ?? '');
    if (metadata['contestRole'] === 'review')
      return this.onReviewFinished(contestId, agentId, sessionId);
    return this.onEntryFinished(contestId, agentId, sessionId, session.state, session.error);
  }

  private async onEntryFinished(
    contestId: string,
    agentId: string,
    sessionId: string,
    state: string,
    error: string | undefined,
  ): Promise<void> {
    let workspace: { root: string; base: string; deviceId: string } | undefined;
    await this.update(contestId, (contest) => {
      const entry = entryFor(contest, agentId);
      if (entry.sessionId && entry.sessionId !== sessionId) return;
      if (entry.state !== 'running' && entry.state !== 'preparing') return;
      entry.sessionId = sessionId;
      entry.finishedAt = new Date().toISOString();
      if (state !== 'completed') {
        entry.state = 'failed';
        entry.error = error ?? `The agent ${state}`;
        return;
      }
      entry.state = 'evaluating';
      if (entry.workspaceRoot && entry.baseCommit)
        workspace = {
          root: entry.workspaceRoot,
          base: entry.baseCommit,
          deviceId: contest.deviceId,
        };
    });
    if (workspace) {
      try {
        const evaluation = await this.runtime.evaluateWorkspace(
          workspace.deviceId,
          workspace.root,
          workspace.base,
        );
        await this.update(contestId, (contest) => {
          const entry = entryFor(contest, agentId);
          entry.evaluation = storable(evaluation);
          entry.state = 'done';
        });
      } catch (evaluationError) {
        await this.update(contestId, (contest) => {
          const entry = entryFor(contest, agentId);
          entry.state = 'failed';
          entry.error = `Could not evaluate the result: ${message(evaluationError)}`;
        });
      }
    }
    await this.maybeJudge(contestId);
  }

  /** Once every entry has a result, start the cross-vendor reviews. */
  private async maybeJudge(contestId: string): Promise<void> {
    const toReview: Array<{ entry: ContestEntry; reviewer: string; label: string }> = [];
    let contestSnapshot: Contest | undefined;
    await this.update(contestId, (contest) => {
      if (contest.state !== 'running') return;
      const pending = contest.entries.some(
        (entry) => entry.state !== 'done' && entry.state !== 'failed',
      );
      if (pending) return;
      const done = contest.entries.filter((entry) => entry.state === 'done');
      if (done.length === 0) {
        contest.state = 'failed';
        contest.error = 'No agent produced a result.';
        return;
      }
      contest.state = 'judging';
      const contestants = contest.entries.map((entry) => entry.agentId);
      contest.entries.forEach((entry, index) => {
        if (entry.state !== 'done') return;
        // The next contestant round the table: a different vendor, and the
        // review work is spread evenly.
        const reviewer = contestants
          .slice(index + 1)
          .concat(contestants.slice(0, index))
          .find((id) => id !== entry.agentId);
        if (!reviewer || !entry.evaluation?.files.length) {
          entry.review = {
            reviewerAgentId: reviewer ?? '',
            state: 'skipped',
            ...(entry.evaluation?.files.length ? {} : { error: 'Nothing to review: no changes' }),
          };
          return;
        }
        entry.state = 'reviewing';
        entry.review = { reviewerAgentId: reviewer, state: 'pending' };
        toReview.push({
          entry: { ...entry },
          reviewer,
          label: `entry ${ENTRY_LETTERS[index] ?? index + 1}`,
        });
      });
      contestSnapshot = contest;
    });
    if (!contestSnapshot) return;
    const contest = contestSnapshot;
    for (const item of toReview) {
      const started = await this.runtime.startSession({
        userId: contest.userId,
        deviceId: contest.deviceId,
        agentId: item.reviewer,
        projectId: contest.projectId,
        projectRoot: item.entry.workspaceRoot ?? contest.projectRoot,
        prompt: reviewPrompt({
          task: contest.task,
          entryLabel: item.label,
          evaluation: {
            tests: item.entry.evaluation!.tests,
            files: item.entry.evaluation!.files,
            diff: item.entry.evaluation!.diff ?? '',
            diffTruncated: item.entry.evaluation!.diffTruncated,
          },
        }),
        taskKind: 'security_review',
        purpose: 'contest review',
        metadata: {
          arena: 'contest',
          contestId,
          contestRole: 'review',
          entryAgent: item.entry.agentId,
        },
      });
      await this.update(contestId, (current) => {
        const entry = entryFor(current, item.entry.agentId);
        if (!entry.review) return;
        entry.review.sessionId = started.sessionId || undefined;
        if (entry.review.state !== 'pending') return;
        if (started.state === 'failed') {
          entry.review.state = 'failed';
          entry.review.error = started.error ?? 'The reviewer did not start';
          entry.state = 'done';
        } else {
          entry.review.state = 'running';
        }
      });
    }
    await this.maybeDecide(contestId);
  }

  private async onReviewFinished(contestId: string, entryAgent: string, sessionId: string) {
    const session = await this.runtime.db.sessions.findById(sessionId);
    const output = await this.runtime.output(sessionId).catch(() => null);
    const parsed = output ? parseScore(output.text) : null;
    await this.update(contestId, (contest) => {
      const entry = entryFor(contest, entryAgent);
      if (!entry.review) return;
      if (entry.review.sessionId && entry.review.sessionId !== sessionId) return;
      if (entry.review.state !== 'pending' && entry.review.state !== 'running') return;
      entry.review.sessionId = sessionId;
      if (session?.state === 'completed' && parsed) {
        Object.assign(entry.review, parsed, { state: 'done' });
      } else {
        entry.review.state = 'failed';
        entry.review.error =
          session?.state === 'completed'
            ? 'The reviewer did not give a score'
            : (session?.error ?? 'The reviewer did not finish');
      }
      entry.state = 'done';
    });
    await this.maybeDecide(contestId);
  }

  private async maybeDecide(contestId: string): Promise<void> {
    let decided: Contest | undefined;
    await this.update(contestId, (contest) => {
      if (contest.state !== 'judging') return;
      if (contest.entries.some((entry) => entry.state === 'reviewing')) return;
      for (const entry of contest.entries) {
        const scored = entry.state === 'done' ? scoreEntry(entry.evaluation, entry.review) : null;
        entry.score = scored?.total ?? 0;
        entry.scoreBreakdown = scored
          ? { tests: scored.tests, review: scored.review, notes: scored.notes }
          : { tests: 0, review: 0, notes: [entry.error ?? 'Did not finish'] };
      }
      const ranked = [...contest.entries]
        .filter((entry) => entry.state === 'done' && (entry.evaluation?.files.length ?? 0) > 0)
        .sort(
          (a, b) =>
            (b.score ?? 0) - (a.score ?? 0) ||
            linesOf(a) - linesOf(b) ||
            Date.parse(a.finishedAt ?? '') - Date.parse(b.finishedAt ?? ''),
        );
      const winner = ranked[0];
      contest.state = 'decided';
      if (!winner) {
        contest.decisionReason = 'No agent produced a change worth applying.';
        return;
      }
      contest.winnerAgentId = winner.agentId;
      const runnerUp = ranked[1];
      contest.decisionReason = runnerUp
        ? `${agentName(winner.agentId)} scored ${winner.score} against ${agentName(runnerUp.agentId)}'s ${runnerUp.score}` +
          ((winner.score ?? 0) === (runnerUp.score ?? 0) ? ', and changed fewer lines.' : '.')
        : `${agentName(winner.agentId)} was the only agent with a usable result.`;
      decided = contest;
    });
    if (decided)
      this.notify(decided.userId, {
        type: 'contest_decided',
        contestId,
        winner: decided.winnerAgentId,
      });
  }

  // ---------------------------------------------------------- user actions

  async apply(userId: string, contestId: string, agentId?: unknown): Promise<Contest> {
    const contest = await this.get(userId, contestId);
    const chosen = typeof agentId === 'string' && agentId ? agentId : contest.winnerAgentId;
    const entry = contest.entries.find((item) => item.agentId === chosen);
    if (!entry || entry.state !== 'done' || !entry.workspaceRoot)
      throw new ArenaError(409, 'That entry has no result to apply.');
    if (contest.applied) throw new ArenaError(409, `Already applied as ${contest.applied.branch}.`);
    if (contest.cleanedUp) throw new ArenaError(409, 'The workspaces were already cleaned up.');
    const branch = `odysseus/contest-${contest.id.slice(8, 16)}-${entry.agentId}`;
    const result = await this.runtime.commitBranch(
      contest.deviceId,
      entry.workspaceRoot,
      branch,
      `${contest.task.split('\n')[0]!.slice(0, 72)}\n\nWinner of Odysseus contest ${contest.id} (${agentName(entry.agentId)}).`,
    );
    return this.update(contestId, (current) => {
      current.applied = { agentId: entry.agentId, ...result, at: new Date().toISOString() };
    });
  }

  async cancel(userId: string, contestId: string): Promise<Contest> {
    const contest = await this.get(userId, contestId);
    for (const entry of contest.entries) {
      if (entry.sessionId) await this.runtime.stopSession(entry.sessionId, 'Contest cancelled');
      if (entry.review?.sessionId)
        await this.runtime.stopSession(entry.review.sessionId, 'Contest cancelled');
    }
    await this.update(contestId, (current) => {
      if (current.state === 'running' || current.state === 'judging') current.state = 'cancelled';
      for (const entry of current.entries)
        if (entry.state !== 'done' && entry.state !== 'failed') entry.state = 'cancelled';
    });
    return this.cleanup(userId, contestId);
  }

  /** Delete the worktrees. An applied result is safe: it lives on its branch. */
  async cleanup(userId: string, contestId: string): Promise<Contest> {
    const contest = await this.get(userId, contestId);
    for (const entry of contest.entries) {
      if (entry.workspaceRoot)
        await this.runtime
          .removeWorkspace(contest.deviceId, entry.workspaceRoot)
          .catch(() => undefined);
    }
    return this.update(contestId, (current) => {
      current.cleanedUp = true;
    });
  }

  // ------------------------------------------------------------ storage

  private async load(id: string): Promise<Contest | null> {
    return (await this.runtime.db.documents.get<Contest>('contests', id))?.data ?? null;
  }

  private save(contest: Contest): Promise<void> {
    contest.updatedAt = new Date().toISOString();
    return this.runtime.db.documents.put('contests', contest.id, contest.userId, contest);
  }

  private update(id: string, mutate: (contest: Contest) => void): Promise<Contest> {
    return this.serial.run(id, async () => {
      const contest = await this.load(id);
      if (!contest) throw new ArenaError(404, 'Contest not found');
      mutate(contest);
      await this.save(contest);
      return contest;
    });
  }
}

export class ArenaError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function entryFor(contest: Contest, agentId: string): ContestEntry {
  const entry = contest.entries.find((item) => item.agentId === agentId);
  if (!entry) throw new ArenaError(404, 'Contest entry not found');
  return entry;
}

function storable(evaluation: WorkspaceEvaluation): NonNullable<ContestEntry['evaluation']> {
  return {
    ...evaluation,
    diff: evaluation.diff.slice(0, STORED_DIFF_CHARS),
    diffTruncated: evaluation.diffTruncated || evaluation.diff.length > STORED_DIFF_CHARS,
  };
}

function withoutDiffs(contest: Contest): Contest {
  return {
    ...contest,
    entries: contest.entries.map((entry) =>
      entry.evaluation ? { ...entry, evaluation: { ...entry.evaluation, diff: undefined } } : entry,
    ),
  };
}

function linesOf(entry: ContestEntry): number {
  return (entry.evaluation?.added ?? 0) + (entry.evaluation?.removed ?? 0);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function contestPrompt(task: string): string {
  return [
    task.trim(),
    '',
    '---',
    'Work only inside this folder. Do not commit, push or create branches: your changes are collected from the folder when you finish.',
    'When you are done, summarise what you changed and why.',
  ].join('\n');
}
