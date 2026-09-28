import { beforeEach, describe, expect, it } from 'vitest';

import { BenchmarkService } from '../src/arena/benchmark';
import { ContestService } from '../src/arena/contest';
import { detectLimit, parseReset } from '../src/arena/limit-detector';
import { NeverIdleService } from '../src/arena/never-idle';
import type { ArenaRuntime } from '../src/arena/runtime';
import type { RecentChange, WorkspaceEvaluation } from '../src/arena/types';
import { MemoryDatabase } from '../src/db/memory-store';

// ---------------------------------------------------------------- fixtures

const USER = 'usr_1';
const DEVICE = 'dev_1';

interface Started {
  sessionId: string;
  agentId: string;
  projectRoot: string;
  prompt: string;
  metadata: Record<string, unknown>;
}

/**
 * A stand-in for the workstation: sessions are recorded, not run, and each
 * workspace evaluates to whatever the test decides.
 */
function fakeRuntime(db: MemoryDatabase, installed: string[]) {
  const started: Started[] = [];
  const removed: string[] = [];
  const branches: string[] = [];
  const evaluations = new Map<string, WorkspaceEvaluation>();
  let changes: RecentChange[] = [];
  let counter = 0;

  const runtime = {
    db,
    isOnline: () => true,
    installedAgents: async () => installed,
    async startSession(input: {
      agentId: string;
      projectRoot: string;
      prompt: string;
      projectId?: string;
      metadata: Record<string, unknown>;
    }) {
      counter += 1;
      const sessionId = `sess_${counter}`;
      await db.sessions.create({
        id: sessionId,
        userId: USER,
        deviceId: DEVICE,
        gatewayId: 'gw_1',
        agentId: input.agentId,
        projectRoot: input.projectRoot,
        state: 'running',
        config: {
          projectRoot: input.projectRoot,
          adapter: input.agentId,
          prompt: input.prompt,
          metadata: input.metadata,
        },
        startedAt: new Date(),
      });
      started.push({ sessionId, ...input });
      return { sessionId, state: 'running' as const };
    },
    async stopSession() {},
    output: async (sessionId: string) => {
      const events = await db.events.listBySession(sessionId, 0, 100);
      const text = events
        .map((event) => String((event.envelope.payload as { content?: string }).content ?? ''))
        .join('\n');
      return { text, finalMessage: text, filesChanged: [] };
    },
    prepareWorkspace: async (_d: string, _root: string, ref: string, label: string) => ({
      workspaceRoot: `/ws/${label}-${ref}`,
      commit: ref === 'HEAD' ? 'base123' : ref,
    }),
    evaluateWorkspace: async (_d: string, root: string) =>
      evaluations.get(root) ?? evaluation({ passed: false, files: [] }),
    recentChanges: async () => changes,
    commitBranch: async (_d: string, _root: string, branch: string) => {
      branches.push(branch);
      return { branch, commit: 'c0ffee' };
    },
    removeWorkspace: async (_d: string, root: string) => {
      removed.push(root);
    },
  };

  return {
    runtime: runtime as unknown as ArenaRuntime,
    started,
    removed,
    branches,
    evaluations,
    setChanges: (value: RecentChange[]) => (changes = value),
  };
}

function evaluation(input: { passed: boolean; files: string[]; ran?: boolean }): WorkspaceEvaluation {
  return {
    diff: input.files.map((file) => `+++ b/${file}\n+change`).join('\n'),
    diffTruncated: false,
    files: input.files.map((path) => ({ path, added: 3, removed: 1 })),
    added: input.files.length * 3,
    removed: input.files.length,
    tests: {
      ran: input.ran ?? true,
      passed: input.passed,
      command: 'pnpm test',
      exitCode: input.passed ? 0 : 1,
      durationMs: 1000,
      summary: input.passed ? '10 passed' : '2 failed | 8 passed',
      outputTail: '',
    },
  };
}

async function finish(db: MemoryDatabase, sessionId: string, state: string, text = '', error?: string) {
  if (text) {
    await db.events.append({
      sessionId,
      deviceId: DEVICE,
      sequence: 1,
      eventType: 'session.message',
      envelope: { payload: { role: 'assistant', content: text } } as never,
    });
  }
  await db.sessions.update(sessionId, {
    state: state as never,
    completedAt: new Date(),
    ...(error ? { error } : {}),
  });
}

async function seed(db: MemoryDatabase) {
  await db.devices.create({
    id: DEVICE,
    userId: USER,
    gatewayId: 'gw_1',
    friendlyName: 'Optimus',
    platform: 'windows',
    publicKeyPem: '',
    publicKeyJwk: {},
    fingerprintHex: '',
    fingerprintWords: [],
    status: 'trusted',
    defaultTrustProfile: 'default',
  } as never);
  return db.projects.create({
    id: 'proj_1',
    userId: USER,
    name: 'shop',
    root: 'C:\\projects\\shop',
    preferences: { protectedBranches: ['main'] },
  });
}

// ------------------------------------------------------------ limit detector

describe('usage limit detection', () => {
  const now = new Date('2026-09-27T10:00:00Z');

  it('reads Claude Code’s reset time from its limit message', () => {
    const signal = detectLimit({
      agentId: 'claude-code',
      state: 'failed',
      error: 'Claude AI usage limit reached|1790500000',
      tail: '',
      now,
    });
    expect(signal?.resetKnown).toBe(true);
    expect(signal?.resetsAt.getTime()).toBe(1_790_500_000_000);
    expect(signal?.message).toBe('Claude AI usage limit reached');
  });

  it('reads Codex’s “try again in” duration', () => {
    const signal = detectLimit({
      agentId: 'codex',
      state: 'failed',
      error: "You've hit your usage limit. Upgrade to Pro, or try again in 2 hours 13 minutes.",
      tail: '',
      now,
    });
    expect(signal?.resetsAt.toISOString()).toBe('2026-09-27T12:13:00.000Z');
  });

  it('reads a clock time in the zone the message names', () => {
    // 10:00 UTC is 15:30 in Kolkata; "resets 6pm" there is 12:30 UTC.
    expect(parseReset('5-hour limit reached ∙ resets 6pm (Asia/Kolkata)', now)?.toISOString()).toBe(
      '2026-09-27T12:30:00.000Z',
    );
  });

  it('does not treat a finished session about rate limiting as limited', () => {
    expect(
      detectLimit({
        agentId: 'codex',
        state: 'completed',
        tail: 'I added a rate limit middleware that returns 429 Too Many Requests.',
        now,
      }),
    ).toBeNull();
  });

  it('counts a generic 429 only in the error of a failed session', () => {
    const signal = detectLimit({
      agentId: 'opencode',
      state: 'failed',
      error: 'API error 429 Too Many Requests',
      tail: '',
      now,
    });
    expect(signal?.resetKnown).toBe(false);
    expect(signal?.resetsAt.getTime()).toBe(now.getTime() + 60 * 60_000);
  });
});

// -------------------------------------------------------------- never idle

describe('never idle', () => {
  let db: MemoryDatabase;

  beforeEach(async () => {
    db = new MemoryDatabase();
    await seed(db);
  });

  it('hands a limited session to another vendor with a brief of the work so far', async () => {
    const fake = fakeRuntime(db, ['claude-code', 'codex', 'mock']);
    const service = new NeverIdleService(fake.runtime);
    const first = await fake.runtime.startSession({
      userId: USER,
      deviceId: DEVICE,
      agentId: 'claude-code',
      projectRoot: 'C:\\projects\\shop',
      prompt: 'Add a cart total',
      taskKind: 'implementation',
      purpose: 'test',
      metadata: {},
    });
    const reset = Math.floor(Date.now() / 1000) + 3_600;
    await finish(db, first.sessionId, 'failed', 'I updated cart.ts', `Claude AI usage limit reached|${reset}`);

    await service.onSessionFinished(first.sessionId);

    const handoff = fake.started[1]!;
    expect(handoff.agentId).toBe('codex');
    expect(handoff.projectRoot).toBe('C:\\projects\\shop');
    expect(handoff.prompt).toContain('Add a cart total');
    expect(handoff.prompt).toContain('I updated cart.ts');
    expect(handoff.metadata).toMatchObject({ handoffFrom: first.sessionId, handoffDepth: 1 });
    expect((await service.activeLimits(USER))[0]).toMatchObject({
      agentId: 'claude-code',
      resetKnown: true,
    });
    const original = await db.sessions.findById(first.sessionId);
    expect(original?.config.metadata?.['handedOffTo']).toBe(handoff.sessionId);
  });

  it('schedules the same agent to continue after the reset when nothing else is installed', async () => {
    const fake = fakeRuntime(db, ['claude-code']);
    const service = new NeverIdleService(fake.runtime);
    const first = await fake.runtime.startSession({
      userId: USER,
      deviceId: DEVICE,
      agentId: 'claude-code',
      projectRoot: 'C:\\projects\\shop',
      prompt: 'Add a cart total',
      taskKind: 'implementation',
      purpose: 'test',
      metadata: {},
    });
    await finish(db, first.sessionId, 'failed', '', 'Claude AI usage limit reached|1790500000');
    await service.onSessionFinished(first.sessionId);

    const [resume] = await service.scheduled(USER);
    expect(resume).toMatchObject({ agentId: 'claude-code', state: 'waiting' });
    expect(fake.started).toHaveLength(1);

    await service.runDueResumes(new Date(1_790_500_000_000 + 2 * 60_000));
    expect(fake.started[1]).toMatchObject({ agentId: 'claude-code' });
    expect(fake.started[1]!.prompt).toContain('Your usage limit has reset');
  });

  it('redirects a launch of a limited agent', async () => {
    const fake = fakeRuntime(db, ['claude-code', 'codex']);
    const service = new NeverIdleService(fake.runtime);
    await db.documents.put('vendor_limits', 'x', USER, {
      agentId: 'claude-code',
      deviceId: DEVICE,
      detectedAt: new Date().toISOString(),
      resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
      resetKnown: true,
      message: 'limit',
      sessionId: 's',
    });
    expect(await service.substituteForLaunch(USER, DEVICE, 'claude-code')).toMatchObject({
      agentId: 'codex',
    });
    await service.saveSettings(USER, { enabled: false });
    expect(await service.substituteForLaunch(USER, DEVICE, 'claude-code')).toBeNull();
  });
});

// ----------------------------------------------------------------- contest

describe('contest', () => {
  let db: MemoryDatabase;

  beforeEach(async () => {
    db = new MemoryDatabase();
    await seed(db);
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('runs every vendor, reviews each with a different vendor, and picks the winner', async () => {
    const fake = fakeRuntime(db, ['claude-code', 'codex', 'opencode']);
    const service = new ContestService(fake.runtime);
    const contest = await service.create(USER, {
      projectId: 'proj_1',
      deviceId: DEVICE,
      task: 'Add a cart total',
      agents: ['claude-code', 'codex'],
    });
    await settle();
    const entries = fake.started.filter((item) => item.metadata['contestRole'] === 'entry');
    expect(entries.map((item) => item.agentId).sort()).toEqual(['claude-code', 'codex']);
    // Isolated: every entry works in its own workspace.
    expect(new Set(entries.map((item) => item.projectRoot)).size).toBe(2);

    for (const entry of entries) {
      fake.evaluations.set(
        entry.projectRoot,
        evaluation({ passed: entry.agentId === 'codex', files: ['src/cart.ts'] }),
      );
      await finish(db, entry.sessionId, 'completed', 'done');
      await service.onSessionFinished(entry.sessionId);
    }
    await settle();

    const reviews = fake.started.filter((item) => item.metadata['contestRole'] === 'review');
    expect(reviews).toHaveLength(2);
    for (const review of reviews) {
      // Never reviewed by its own author, and never told who wrote it.
      expect(review.agentId).not.toBe(review.metadata['entryAgent']);
      expect(review.prompt).not.toMatch(/Claude|Codex/);
      await finish(
        db,
        review.sessionId,
        'completed',
        '```odysseus-score\n{"score": 8, "verdict": "approve", "summary": "Good", "issues": []}\n```',
      );
      await service.onSessionFinished(review.sessionId);
    }

    const decided = await service.get(USER, contest.id);
    expect(decided.state).toBe('decided');
    expect(decided.winnerAgentId).toBe('codex');
    const codex = decided.entries.find((entry) => entry.agentId === 'codex')!;
    expect(codex.score).toBe(60 + 32);
    expect(decided.decisionReason).toContain('Codex scored 92');

    const applied = await service.apply(USER, contest.id);
    expect(applied.applied?.branch).toBe(fake.branches[0]);
    expect(fake.branches[0]).toMatch(/^odysseus\/contest-.+-codex$/);
  });

  it('refuses agents that are not installed on the machine', async () => {
    const fake = fakeRuntime(db, ['claude-code']);
    const service = new ContestService(fake.runtime);
    await expect(
      service.create(USER, {
        projectId: 'proj_1',
        deviceId: DEVICE,
        task: 'x',
        agents: ['claude-code', 'codex'],
      }),
    ).rejects.toThrow(/Codex is not installed/);
  });
});

// --------------------------------------------------------------- benchmark

describe('leaderboard benchmark', () => {
  it('replays past changes against their own tests and ranks the agents', async () => {
    const db = new MemoryDatabase();
    await seed(db);
    const fake = fakeRuntime(db, ['claude-code', 'codex']);
    fake.setChanges([
      {
        commit: 'aaa',
        parent: 'p_aaa',
        title: 'Add cart total',
        body: '',
        date: '2026-09-01',
        files: [
          { path: 'src/cart.ts', added: 10, removed: 2 },
          { path: 'tests/cart.test.ts', added: 20, removed: 0 },
        ],
        testFiles: ['tests/cart.test.ts'],
      },
    ]);
    const service = new BenchmarkService(fake.runtime);
    const benchmark = await service.create(USER, {
      projectId: 'proj_1',
      deviceId: DEVICE,
      agents: ['claude-code', 'codex'],
      changes: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Started from the commit before the change, with its title as the task.
    expect(fake.started.every((item) => item.projectRoot.endsWith('-p_aaa'))).toBe(true);
    expect(fake.started[0]!.prompt).toContain('Add cart total');

    for (const attempt of fake.started) {
      fake.evaluations.set(
        attempt.projectRoot,
        evaluation({ passed: attempt.agentId === 'claude-code', files: ['src/cart.ts'] }),
      );
      await finish(db, attempt.sessionId, 'completed', 'done');
      await service.onSessionFinished(attempt.sessionId);
    }

    const done = await service.get(USER, benchmark.id);
    expect(done.state).toBe('completed');
    // Workspaces are removed once graded.
    expect(fake.removed).toHaveLength(2);
    const board = await service.leaderboard(USER, 'proj_1');
    expect(board.rows.map((row) => [row.agentId, row.solved, row.rank])).toEqual([
      ['claude-code', 1, 1],
      ['codex', 0, 2],
    ]);
    expect(board.rows[0]!.averageOverlap).toBe(1);
  });
});
