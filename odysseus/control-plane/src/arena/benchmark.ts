/**
 * Leaderboard on your own code.
 *
 * Replays recent changes that were merged into the project: each agent starts
 * from the commit before the change, gets the change's title and description
 * as its task, and is graded by the tests that shipped with the real change —
 * checked out on top of the agent's work and run on the workstation. The
 * answer is "which agent does the work this team actually does", measured on
 * this team's code, not on a public benchmark.
 */
import { randomUUID } from 'node:crypto';

import { ArenaError } from './contest';
import type { ArenaNotifier } from './never-idle';
import { agentName, TERMINAL_SESSION_STATES, type ArenaRuntime } from './runtime';
import { Serial } from './serial';
import type {
  Benchmark,
  BenchmarkAttempt,
  BenchmarkTask,
  LeaderboardRow,
  RecentChange,
} from './types';

const DEFAULT_CONCURRENCY = 2;
const ACTIVE = new Set(['preparing', 'running', 'evaluating']);

export class BenchmarkService {
  private readonly serial = new Serial();

  constructor(
    private readonly runtime: ArenaRuntime,
    private readonly notify: ArenaNotifier = () => undefined,
  ) {}

  async list(userId: string, projectId?: string): Promise<Benchmark[]> {
    const records = await this.runtime.db.documents.listByUser<Benchmark>('benchmarks', userId);
    return records
      .map((record) => record.data)
      .filter((benchmark) => !projectId || benchmark.projectId === projectId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  async get(userId: string, id: string): Promise<Benchmark> {
    const record = await this.runtime.db.documents.get<Benchmark>('benchmarks', id);
    if (!record || record.userId !== userId) throw new ArenaError(404, 'Benchmark not found');
    return record.data;
  }

  /** The changes a benchmark would replay, so the user sees them before starting. */
  async preview(userId: string, projectId: unknown, deviceId: unknown, count: unknown) {
    const { project, device } = await this.resolve(userId, projectId, deviceId);
    const changes = await this.runtime.recentChanges(device.id, project.root, clampCount(count));
    return changes.map(toTask);
  }

  async create(
    userId: string,
    input: { projectId?: unknown; deviceId?: unknown; agents?: unknown; changes?: unknown },
  ): Promise<Benchmark> {
    const { project, device } = await this.resolve(userId, input.projectId, input.deviceId);
    const agents = [
      ...new Set(
        (Array.isArray(input.agents) ? input.agents : []).filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        ),
      ),
    ];
    if (agents.length < 1 || agents.length > 4)
      throw new ArenaError(400, 'Choose between 1 and 4 agents to benchmark.');
    const installed = await this.runtime.installedAgents(device.id);
    const missing = agents.filter((id) => !installed.includes(id));
    if (missing.length)
      throw new ArenaError(
        409,
        `${missing.map(agentName).join(', ')} not installed on ${device.friendlyName}.`,
      );

    const changes = await this.runtime.recentChanges(
      device.id,
      project.root,
      clampCount(input.changes),
    );
    if (changes.length === 0)
      throw new ArenaError(
        409,
        'No suitable changes found in this project’s history. It needs commits that change code (not only docs), with fewer than 40 files each.',
      );
    const tasks = changes.map(toTask);
    const now = new Date().toISOString();
    const benchmark: Benchmark = {
      id: `bench_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      userId,
      projectId: project.id,
      projectName: project.name,
      projectRoot: project.root,
      deviceId: device.id,
      agents,
      tasks,
      attempts: tasks.flatMap((task) =>
        agents.map((agentId) => ({
          id: `att_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
          changeCommit: task.commit,
          agentId,
          state: 'queued' as const,
        })),
      ),
      concurrency: DEFAULT_CONCURRENCY,
      state: 'running',
      createdAt: now,
      updatedAt: now,
    };
    await this.save(benchmark);
    void this.pump(benchmark.id).catch(() => undefined);
    return benchmark;
  }

  async cancel(userId: string, id: string): Promise<Benchmark> {
    const benchmark = await this.get(userId, id);
    for (const attempt of benchmark.attempts) {
      if (attempt.sessionId && ACTIVE.has(attempt.state))
        await this.runtime.stopSession(attempt.sessionId, 'Benchmark cancelled');
      if (attempt.workspaceRoot)
        await this.runtime
          .removeWorkspace(benchmark.deviceId, attempt.workspaceRoot)
          .catch(() => undefined);
    }
    return this.update(id, (current) => {
      for (const attempt of current.attempts)
        if (attempt.state === 'queued' || ACTIVE.has(attempt.state)) attempt.state = 'cancelled';
      if (current.state === 'running') current.state = 'cancelled';
    });
  }

  // ------------------------------------------------------------- the queue

  /** Start queued attempts up to the concurrency limit. */
  private async pump(id: string): Promise<void> {
    const toStart: BenchmarkAttempt[] = [];
    let benchmark: Benchmark | undefined;
    await this.update(id, (current) => {
      benchmark = current;
      if (current.state !== 'running') return;
      let active = current.attempts.filter((attempt) => ACTIVE.has(attempt.state)).length;
      for (const attempt of current.attempts) {
        if (active >= current.concurrency) break;
        if (attempt.state !== 'queued') continue;
        attempt.state = 'preparing';
        attempt.startedAt = new Date().toISOString();
        toStart.push({ ...attempt });
        active += 1;
      }
      if (active === 0 && !current.attempts.some((attempt) => attempt.state === 'queued')) {
        current.state = 'completed';
      }
    });
    if (benchmark?.state === 'completed') {
      this.notify(benchmark.userId, { type: 'benchmark_completed', benchmarkId: id });
      return;
    }
    for (const attempt of toStart) void this.startAttempt(id, attempt).catch(() => undefined);
  }

  private async startAttempt(id: string, attempt: BenchmarkAttempt): Promise<void> {
    const benchmark = await this.load(id);
    const task = benchmark?.tasks.find((item) => item.commit === attempt.changeCommit);
    if (!benchmark || !task) return;
    try {
      const workspace = await this.runtime.prepareWorkspace(
        benchmark.deviceId,
        benchmark.projectRoot,
        task.parent,
        `bench-${attempt.agentId}`,
      );
      await this.update(id, (current) => {
        const stored = attemptFor(current, attempt.id);
        stored.workspaceRoot = workspace.workspaceRoot;
      });
      const started = await this.runtime.startSession({
        userId: benchmark.userId,
        deviceId: benchmark.deviceId,
        agentId: attempt.agentId,
        projectId: benchmark.projectId,
        projectRoot: workspace.workspaceRoot,
        prompt: benchmarkPrompt(task),
        taskKind: 'implementation',
        purpose: 'leaderboard benchmark',
        metadata: { arena: 'benchmark', benchmarkId: id, attemptId: attempt.id },
      });
      await this.update(id, (current) => {
        const stored = attemptFor(current, attempt.id);
        stored.sessionId = started.sessionId || undefined;
        if (stored.state !== 'preparing') return;
        if (started.state === 'failed') {
          stored.state = 'failed';
          stored.error = started.error ?? 'The agent did not start';
        } else stored.state = 'running';
      });
      if (started.state === 'failed') await this.finishAttempt(id, attempt.id);
    } catch (error) {
      await this.update(id, (current) => {
        const stored = attemptFor(current, attempt.id);
        stored.state = 'failed';
        stored.error = error instanceof Error ? error.message : String(error);
      });
      await this.finishAttempt(id, attempt.id);
    }
  }

  async onSessionFinished(sessionId: string): Promise<void> {
    const session = await this.runtime.db.sessions.findById(sessionId);
    const metadata = session?.config.metadata ?? {};
    if (
      !session ||
      metadata['arena'] !== 'benchmark' ||
      !TERMINAL_SESSION_STATES.has(session.state)
    )
      return;
    const id = String(metadata['benchmarkId'] ?? '');
    const attemptId = String(metadata['attemptId'] ?? '');

    let grade:
      { workspaceRoot: string; parent: string; task: BenchmarkTask; deviceId: string } | undefined;
    await this.update(id, (benchmark) => {
      const attempt = attemptFor(benchmark, attemptId);
      if (attempt.sessionId && attempt.sessionId !== sessionId) return;
      if (attempt.state !== 'running' && attempt.state !== 'preparing') return;
      attempt.sessionId = sessionId;
      attempt.finishedAt = new Date().toISOString();
      attempt.durationMs =
        Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt ?? attempt.finishedAt);
      if (session.state !== 'completed') {
        attempt.state = 'failed';
        attempt.solved = false;
        attempt.error = session.error ?? `The agent ${session.state}`;
        return;
      }
      attempt.state = 'evaluating';
      const task = benchmark.tasks.find((item) => item.commit === attempt.changeCommit);
      if (task && attempt.workspaceRoot)
        grade = {
          workspaceRoot: attempt.workspaceRoot,
          parent: task.parent,
          task,
          deviceId: benchmark.deviceId,
        };
    });

    if (grade) {
      try {
        const evaluation = await this.runtime.evaluateWorkspace(
          grade.deviceId,
          grade.workspaceRoot,
          grade.parent,
          grade.task.testFiles.length
            ? { commit: grade.task.commit, paths: grade.task.testFiles }
            : undefined,
        );
        const changed = new Set(evaluation.files.map((file) => file.path));
        const expected = grade.task.files.filter((path) => !grade!.task.testFiles.includes(path));
        const overlap = expected.length
          ? expected.filter((path) => changed.has(path)).length / expected.length
          : 0;
        await this.update(id, (benchmark) => {
          const attempt = attemptFor(benchmark, attemptId);
          attempt.state = 'done';
          attempt.testsRan = evaluation.tests.ran;
          attempt.testSummary = evaluation.tests.summary;
          attempt.solved =
            evaluation.files.length > 0 && evaluation.tests.ran && evaluation.tests.passed;
          attempt.fileOverlap = Math.round(overlap * 100) / 100;
          attempt.linesChanged = evaluation.added + evaluation.removed;
        });
      } catch (error) {
        await this.update(id, (benchmark) => {
          const attempt = attemptFor(benchmark, attemptId);
          attempt.state = 'failed';
          attempt.error = `Could not grade the result: ${error instanceof Error ? error.message : String(error)}`;
        });
      }
    }
    await this.finishAttempt(id, attemptId);
  }

  /** Free the attempt's workspace and let the next one start. */
  private async finishAttempt(id: string, attemptId: string): Promise<void> {
    const benchmark = await this.load(id);
    const attempt = benchmark?.attempts.find((item) => item.id === attemptId);
    if (benchmark && attempt?.workspaceRoot && !ACTIVE.has(attempt.state)) {
      await this.runtime
        .removeWorkspace(benchmark.deviceId, attempt.workspaceRoot)
        .catch(() => undefined);
      await this.update(id, (current) => {
        delete attemptFor(current, attemptId).workspaceRoot;
      });
    }
    await this.pump(id);
  }

  // ----------------------------------------------------------- leaderboard

  /** Every graded attempt on this project, ranked per agent. */
  async leaderboard(
    userId: string,
    projectId: string,
  ): Promise<{ rows: LeaderboardRow[]; tasks: number; benchmarks: number }> {
    const benchmarks = await this.list(userId, projectId);
    // The newest attempt per (change, agent), so re-running replaces rather than double counts.
    const latest = new Map<string, BenchmarkAttempt>();
    for (const benchmark of [...benchmarks].reverse()) {
      for (const attempt of benchmark.attempts) {
        if (attempt.state !== 'done' && attempt.state !== 'failed') continue;
        latest.set(`${attempt.changeCommit}:${attempt.agentId}`, attempt);
      }
    }
    const byAgent = new Map<string, BenchmarkAttempt[]>();
    for (const attempt of latest.values()) {
      byAgent.set(attempt.agentId, [...(byAgent.get(attempt.agentId) ?? []), attempt]);
    }
    const rows: LeaderboardRow[] = [...byAgent.entries()].map(([agentId, attempts]) => {
      const done = attempts.filter((attempt) => attempt.state === 'done');
      const solved = attempts.filter((attempt) => attempt.solved).length;
      const minutes = attempts
        .map((attempt) => attempt.durationMs)
        .filter((value): value is number => typeof value === 'number');
      return {
        agentId,
        rank: 0,
        attempted: attempts.length,
        solved,
        solveRate: attempts.length ? solved / attempts.length : 0,
        averageOverlap: done.length
          ? done.reduce((sum, attempt) => sum + (attempt.fileOverlap ?? 0), 0) / done.length
          : 0,
        averageMinutes: minutes.length
          ? minutes.reduce((sum, value) => sum + value, 0) / minutes.length / 60_000
          : 0,
        failed: attempts.filter((attempt) => attempt.state === 'failed').length,
      };
    });
    rows.sort(
      (a, b) =>
        b.solveRate - a.solveRate ||
        b.averageOverlap - a.averageOverlap ||
        a.averageMinutes - b.averageMinutes,
    );
    rows.forEach((row, index) => (row.rank = index + 1));
    return {
      rows,
      tasks: new Set([...latest.values()].map((attempt) => attempt.changeCommit)).size,
      benchmarks: benchmarks.length,
    };
  }

  // ------------------------------------------------------------- storage

  private async resolve(userId: string, projectId: unknown, deviceId: unknown) {
    const project =
      typeof projectId === 'string' ? await this.runtime.db.projects.findById(projectId) : null;
    if (!project || project.userId !== userId) throw new ArenaError(404, 'Project not found');
    const device =
      typeof deviceId === 'string' ? await this.runtime.db.devices.findById(deviceId) : null;
    if (!device || device.userId !== userId) throw new ArenaError(404, 'Machine not found');
    if (!this.runtime.isOnline(device.id))
      throw new ArenaError(409, `${device.friendlyName} is offline. Start its gateway first.`);
    return { project, device };
  }

  private async load(id: string): Promise<Benchmark | null> {
    return (await this.runtime.db.documents.get<Benchmark>('benchmarks', id))?.data ?? null;
  }

  private save(benchmark: Benchmark): Promise<void> {
    benchmark.updatedAt = new Date().toISOString();
    return this.runtime.db.documents.put('benchmarks', benchmark.id, benchmark.userId, benchmark);
  }

  private update(id: string, mutate: (benchmark: Benchmark) => void): Promise<Benchmark> {
    return this.serial.run(id, async () => {
      const benchmark = await this.load(id);
      if (!benchmark) throw new ArenaError(404, 'Benchmark not found');
      mutate(benchmark);
      await this.save(benchmark);
      return benchmark;
    });
  }
}

function attemptFor(benchmark: Benchmark, attemptId: string): BenchmarkAttempt {
  const attempt = benchmark.attempts.find((item) => item.id === attemptId);
  if (!attempt) throw new ArenaError(404, 'Benchmark attempt not found');
  return attempt;
}

function clampCount(value: unknown): number {
  const count = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 5;
  return Math.max(1, Math.min(10, count));
}

function toTask(change: RecentChange): BenchmarkTask {
  return {
    commit: change.commit,
    parent: change.parent,
    title: change.title,
    body: change.body.slice(0, 2_000),
    date: change.date,
    files: change.files.map((file) => file.path),
    testFiles: change.testFiles,
    linesChanged: change.files.reduce((sum, file) => sum + file.added + file.removed, 0),
  };
}

export function benchmarkPrompt(task: Pick<BenchmarkTask, 'title' | 'body'>): string {
  return [
    'Implement this change in the repository in this folder:',
    '',
    task.title.trim(),
    ...(task.body?.trim() ? ['', task.body.trim()] : []),
    '',
    '---',
    'Work only inside this folder. Do not commit, push or create branches.',
    'When you are done, summarise what you changed.',
  ].join('\n');
}
