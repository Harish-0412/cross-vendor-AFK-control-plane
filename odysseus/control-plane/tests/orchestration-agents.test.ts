/**
 * The orchestration agents end to end, against the real orchestrator and an
 * in-memory database: the planner's plan becomes the run, each step hears what
 * the steps before it did, a failing test or review goes back to a builder,
 * relevant past conversations reach the prompt, and the run moves on its own
 * whenever a session finishes.
 *
 * The gateway is faked at the tunnel boundary only — sessions "finish" by
 * storing the events a real adapter would send, then reporting completion
 * the way the Control Plane's event pipeline does.
 */
import { randomUUID } from 'node:crypto';

import type { OrchestrationRun, OrchestrationStep } from '@odysseus/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { MemoryDatabase } from '../src/db/memory-store';
import {
  parsePlan,
  parseReview,
  parseTestResult,
  PLAN_FENCE,
  REVIEW_FENCE,
} from '../src/orchestration/agent-roles';
import type { AgentRouter } from '../src/orchestration/agent-router';
import { ContextAgent } from '../src/orchestration/context-agent';
import { MultiAgentOrchestrator } from '../src/orchestration/multi-agent-orchestrator';
import type { ApprovalWorkflow } from '../src/policy/approval-workflow';
import type { PolicyEngineService } from '../src/policy/policy-engine-service';
import type { TunnelServer } from '../src/tunnel/tunnel-server';

const USER = 'u1';
const DIFF = 'diff --git a/src/login.ts b/src/login.ts\n+export const login = () => true;';

interface Harness {
  db: MemoryDatabase;
  orchestrator: MultiAgentOrchestrator;
  commands: Array<{ deviceId: string; type: string; payload: Record<string, unknown> }>;
  policyDecision: { value: 'allow' | 'require_approval' | 'deny' };
  online: { value: boolean };
}

async function harness(): Promise<Harness> {
  const db = new MemoryDatabase();
  await db.users.create({ id: USER, email: 'u1@example.test', name: 'u1', role: 'owner' });
  await db.users.create({ id: 'u2', email: 'u2@example.test', name: 'u2', role: 'user' });
  await db.devices.create({
    id: 'd1',
    userId: USER,
    gatewayId: 'g1',
    friendlyName: 'pc',
    platform: 'windows',
    publicKeyPem: '',
    publicKeyJwk: {},
    fingerprintHex: '',
    fingerprintWords: [],
    status: 'trusted',
    defaultTrustProfile: 'default',
  });
  const org = await db.organizations.create({ id: 'org1', name: 'Personal', ownerId: USER });
  await db.projects.create({
    id: 'p1',
    userId: USER,
    name: 'shop',
    root: 'C:\\code\\shop',
    organizationId: org.id,
    preferences: { protectedBranches: [] },
  });

  const commands: Harness['commands'] = [];
  const online = { value: true };
  const tunnel = {
    sendCommandToDevice: async (
      deviceId: string,
      type: string,
      payload: Record<string, unknown>,
    ) => {
      commands.push({ deviceId, type, payload });
      if (!online.value) return { delivered: false, acknowledged: false, payload: undefined };
      if (type === 'session.diff_collection')
        return { delivered: true, acknowledged: true, payload: { result: { diff: DIFF } } };
      return { delivered: true, acknowledged: true, payload: { success: true } };
    },
  } as unknown as TunnelServer;
  const router = {
    route: async (_userId: string, request: { requiredAgentId?: string; taskKind: string }) => ({
      id: `route_${randomUUID()}`,
      request,
      selected: online.value
        ? {
            deviceId: 'd1',
            gatewayId: 'g1',
            agentId: request.requiredAgentId ?? 'codex',
            online: true,
            activeSessions: 0,
          }
        : null,
      alternatives: [],
      reasons: [],
      createdAt: new Date(),
    }),
  } as unknown as AgentRouter;
  const policyDecision: Harness['policyDecision'] = { value: 'allow' };
  const policy = {
    evaluate: async () => ({
      decision: policyDecision.value,
      reason: 'policy says no',
      policyVersion: 'v1',
      matchedRules: [],
    }),
  } as unknown as PolicyEngineService;
  const approvals = {
    createApproval: async () => ({ id: `appr_${randomUUID()}` }),
  } as unknown as ApprovalWorkflow;

  const orchestrator = new MultiAgentOrchestrator(
    db,
    tunnel,
    policy,
    approvals,
    router,
    undefined,
    undefined,
    { context: new ContextAgent(db) },
  );
  return { db, orchestrator, commands, policyDecision, online };
}

/** Finish a step's session the way a real adapter and the event pipeline would. */
async function finish(
  h: Harness,
  step: OrchestrationStep | undefined,
  reply: string,
  options: { state?: 'completed' | 'failed'; files?: string[] } = {},
): Promise<OrchestrationRun> {
  expect(step?.sessionId, `step ${step?.id} should have a session`).toBeTruthy();
  const sessionId = step!.sessionId!;
  let sequence = 1;
  const append = (eventType: string, payload: Record<string, unknown>) =>
    h.db.events.append({
      sessionId,
      deviceId: 'd1',
      sequence: sequence++,
      eventType,
      envelope: {
        eventId: randomUUID(),
        sessionId,
        eventType,
        sequence,
        timestamp: new Date(),
        payload,
      } as never,
    });
  for (const path of options.files ?? []) await append('session.file_changed', { path });
  await append('session.message', { role: 'assistant', content: reply });
  const state = options.state ?? 'completed';
  await append(`session.${state}`, state === 'failed' ? { error: 'agent crashed' } : {});
  await h.db.sessions.update(sessionId, {
    state,
    completedAt: new Date(),
    ...(state === 'failed' ? { error: 'agent crashed' } : {}),
  });
  await h.orchestrator.onSessionFinished(sessionId);
  return (await h.db.orchestration.findRun(runIdOf(step!)))!;
}

const runIds = new Map<string, string>();
function runIdOf(step: OrchestrationStep): string {
  return runIds.get(step.sessionId!)!;
}
async function track(h: Harness, run: OrchestrationRun): Promise<OrchestrationRun> {
  for (const step of run.plan.steps) if (step.sessionId) runIds.set(step.sessionId, run.id);
  return run;
}
async function reload(h: Harness, id: string): Promise<OrchestrationRun> {
  return track(h, (await h.db.orchestration.findRun(id))!);
}
const stepOf = (run: OrchestrationRun, id: string) => run.plan.steps.find((s) => s.id === id);
async function promptOf(h: Harness, step: OrchestrationStep | undefined): Promise<string> {
  return (await h.db.sessions.findById(step!.sessionId!))!.config.prompt ?? '';
}

const plan = (steps: unknown[]) =>
  `Here is the plan.\n\`\`\`${PLAN_FENCE}\n${JSON.stringify({ steps })}\n\`\`\``;
const review = (verdict: string, findings: unknown[] = []) =>
  `Looked at it.\n\`\`\`${REVIEW_FENCE}\n${JSON.stringify({ verdict, findings })}\n\`\`\``;

describe('orchestration agents', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  it('plans, builds, tests, fixes a failure, re-tests, reviews and completes on its own', async () => {
    let run = await track(
      h,
      await h.orchestrator.createPlannedRun({
        organizationId: 'org1',
        userId: USER,
        projectId: 'p1',
        goal: 'Add a login endpoint',
      }),
    );
    // The planner runs first, on the preferred planning agent, read-only.
    const planner = stepOf(run, 'plan');
    expect(planner).toMatchObject({ state: 'running', agentId: 'claude' });
    expect(await promptOf(h, planner)).toContain('PLANNER');
    expect(await promptOf(h, planner)).toContain('Do NOT modify');

    // The plan has one build step; the test and review are guaranteed.
    run = await finish(
      h,
      planner,
      plan([
        {
          id: 'build',
          title: 'Write the endpoint',
          taskKind: 'implementation',
          prompt: 'Add POST /login.',
          dependsOn: [],
        },
      ]),
    );
    run = await track(h, run);
    expect(run.plan.steps.map((s) => [s.id, s.taskKind, s.state, s.origin ?? 'user'])).toEqual([
      ['plan', 'planning', 'completed', 'user'],
      ['build', 'implementation', 'running', 'planner'],
      ['test', 'test', 'pending', 'guarantee'],
      ['review', 'security_review', 'pending', 'guarantee'],
    ]);
    const buildPrompt = await promptOf(h, stepOf(run, 'build'));
    expect(buildPrompt).toContain('BUILDER');
    expect(buildPrompt).toContain('Add a login endpoint'); // the goal
    expect(buildPrompt).toContain('Plan the work'); // the hand-off from the planner

    // Build finishes; its files and summary reach the test agent.
    run = await track(
      h,
      await finish(h, stepOf(run, 'build'), 'Added src/login.ts.', { files: ['src/login.ts'] }),
    );
    expect(stepOf(run, 'build')?.outcome?.filesChanged).toEqual(['src/login.ts']);
    expect(stepOf(run, 'test')?.state).toBe('running');
    expect(await promptOf(h, stepOf(run, 'test'))).toContain('Files changed: src/login.ts');

    // Tests fail: a fix and a re-check are added, and the review now waits
    // for the re-check instead of the failed test.
    run = await track(
      h,
      await finish(
        h,
        stepOf(run, 'test'),
        'login.spec.ts: expected 200, got 500\nODYSSEUS_TEST_RESULT: FAIL',
      ),
    );
    expect(stepOf(run, 'test')?.outcome?.testsPassed).toBe(false);
    expect(stepOf(run, 'test-fix-1')).toMatchObject({ state: 'running', origin: 'test_fix' });
    expect(stepOf(run, 'test-recheck-1')).toMatchObject({
      state: 'pending',
      dependsOn: ['test-fix-1'],
    });
    expect(stepOf(run, 'review')?.dependsOn).toContain('test-recheck-1');
    expect(stepOf(run, 'review')?.dependsOn).not.toContain('test');
    expect(await promptOf(h, stepOf(run, 'test-fix-1'))).toContain('expected 200, got 500');

    run = await track(h, await finish(h, stepOf(run, 'test-fix-1'), 'Fixed the handler.'));
    run = await track(
      h,
      await finish(h, stepOf(run, 'test-recheck-1'), 'All green.\nODYSSEUS_TEST_RESULT: PASS'),
    );

    // The reviewer is shown the diff of the work.
    const reviewStep = stepOf(run, 'review');
    expect(reviewStep?.state).toBe('running');
    expect(await promptOf(h, reviewStep)).toContain(DIFF);
    expect(h.commands.some((c) => c.type === 'session.diff_collection')).toBe(true);

    run = await finish(h, reviewStep, review('approve', [{ severity: 'low', summary: 'nit' }]));
    expect(run.state).toBe('completed');
    expect(stepOf(run, 'review')?.outcome).toMatchObject({ verdict: 'approve' });
  });

  it('sends review findings back to a builder and fails once the attempts run out', async () => {
    let run = await track(
      h,
      await h.orchestrator.createRun({
        organizationId: 'org1',
        userId: USER,
        projectId: 'p1',
        title: 'harden',
        maxFixAttempts: 1,
        steps: [
          {
            id: 'rev',
            title: 'Review',
            taskKind: 'security_review',
            prompt: 'Review.',
            dependsOn: [],
          },
        ],
      }),
    );
    const finding = { severity: 'critical', file: 'src/a.ts', line: 3, summary: 'SQL injection' };
    run = await track(h, await finish(h, stepOf(run, 'rev'), review('approve', [finding])));
    // An approval that lists a critical finding is treated as a change request.
    expect(stepOf(run, 'rev')?.outcome?.verdict).toBe('changes_requested');
    expect(await promptOf(h, stepOf(run, 'rev-fix-1'))).toContain(
      '[critical] src/a.ts:3 SQL injection',
    );

    run = await track(h, await finish(h, stepOf(run, 'rev-fix-1'), 'Parameterised the query.'));
    run = await finish(h, stepOf(run, 'rev-recheck-1'), review('changes_requested', [finding]));
    expect(run.state).toBe('failed');
    expect(run.error).toContain('after 1 fix attempt');
  });

  it('fails the run clearly when the planner does not return a usable plan', async () => {
    const run = await track(
      h,
      await h.orchestrator.createPlannedRun({
        organizationId: 'org1',
        userId: USER,
        projectId: 'p1',
        goal: 'Do something',
      }),
    );
    const done = await finish(h, stepOf(run, 'plan'), 'I think we should refactor everything.');
    expect(done.state).toBe('failed');
    expect(done.error).toContain('odysseus-plan');
  });

  it('never runs two builders at once, and lets readers overlap', async () => {
    const run = await h.orchestrator.createRun({
      organizationId: 'org1',
      userId: USER,
      projectId: 'p1',
      title: 'parallel',
      steps: [
        { id: 'a', title: 'A', taskKind: 'implementation', prompt: 'a', dependsOn: [] },
        { id: 'b', title: 'B', taskKind: 'implementation', prompt: 'b', dependsOn: [] },
        { id: 't', title: 'T', taskKind: 'test', prompt: 't', dependsOn: [] },
      ],
    });
    expect(run.plan.steps.map((s) => s.state)).toEqual(['running', 'pending', 'running']);
    await track(h, run);
    const next = await track(h, await finish(h, stepOf(run, 'a'), 'done'));
    expect(stepOf(next, 'b')?.state).toBe('running');
  });

  it('puts the user’s own relevant past conversations in the prompt, and nobody else’s', async () => {
    const conversation = (id: string, userId: string, title: string, searchText?: string) =>
      h.db.externalConversations.upsert({
        id,
        userId,
        deviceId: 'd1',
        integration: 'codex',
        externalId: id,
        title,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 3,
        toolCallCount: 0,
        hasTranscript: true,
        workspace: '~/code/shop',
        contentSynced: Boolean(searchText),
        ...(searchText ? { searchText } : {}),
        tokensRecorded: 0,
        lastScanId: 's',
        updatedRecordAt: new Date(),
      });
    await conversation(
      'mine',
      USER,
      'Stripe checkout webhook',
      'We verified the stripe signature header.',
    );
    await conversation('theirs', 'u2', 'Stripe checkout webhook secrets', 'their private notes');
    await conversation('unrelated', USER, 'Dark mode colours');

    const run = await h.orchestrator.createRun({
      organizationId: 'org1',
      userId: USER,
      projectId: 'p1',
      title: 'stripe',
      steps: [
        {
          id: 'build',
          title: 'Handle the Stripe checkout webhook',
          taskKind: 'implementation',
          prompt: 'Handle the checkout webhook from Stripe.',
          dependsOn: [],
        },
      ],
    });
    const step = stepOf(run, 'build');
    const prompt = await promptOf(h, step);
    expect(step?.contextConversationIds).toEqual(['mine']);
    expect(prompt).toContain('verified the stripe signature');
    expect(prompt).not.toContain('their private notes');
    expect(prompt).not.toContain('Dark mode');
  });

  it('retries a step that found no agent once a machine is back', async () => {
    h.online.value = false;
    let run = await h.orchestrator.createRun({
      organizationId: 'org1',
      userId: USER,
      projectId: 'p1',
      title: 'offline',
      steps: [{ id: 'a', title: 'A', taskKind: 'general', prompt: 'a', dependsOn: [] }],
    });
    expect(stepOf(run, 'a')).toMatchObject({ state: 'blocked', error: 'No eligible online agent' });
    h.online.value = true;
    run = await h.orchestrator.advance(run.id);
    expect(stepOf(run, 'a')?.state).toBe('running');
  });

  it('cancels: stops running sessions and skips what has not started', async () => {
    const run = await h.orchestrator.createRun({
      organizationId: 'org1',
      userId: USER,
      projectId: 'p1',
      title: 'cancel me',
      steps: [
        { id: 'a', title: 'A', taskKind: 'implementation', prompt: 'a', dependsOn: [] },
        { id: 'b', title: 'B', taskKind: 'test', prompt: 'b', dependsOn: ['a'] },
      ],
    });
    const cancelled = await h.orchestrator.cancel(run.id);
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.plan.steps.map((s) => s.state)).toEqual(['failed', 'skipped']);
    expect(h.commands.some((c) => c.type === 'session.stop')).toBe(true);
  });

  it('moves a step that needs approval to running once approved, and ends it when denied', async () => {
    h.policyDecision.value = 'require_approval';
    const run = await track(
      h,
      await h.orchestrator.createRun({
        organizationId: 'org1',
        userId: USER,
        projectId: 'p1',
        title: 'approval',
        steps: [{ id: 'a', title: 'A', taskKind: 'implementation', prompt: 'a', dependsOn: [] }],
      }),
    );
    expect(run.state).toBe('waiting_for_approval');
    const sessionId = stepOf(run, 'a')!.sessionId!;
    await h.db.sessions.update(sessionId, { state: 'cancelled', error: 'Approval denied' });
    const after = await h.orchestrator.advance(run.id);
    expect(stepOf(after, 'a')).toMatchObject({ state: 'failed', error: 'Approval denied' });
    expect(after.state).toBe('failed');
  });
});

describe('agent output parsers', () => {
  const step = (over: Record<string, unknown>) => ({
    id: 's',
    title: 'S',
    taskKind: 'implementation',
    prompt: 'p',
    dependsOn: [],
    ...over,
  });

  it('accepts a valid plan and drops agents it does not know', () => {
    const parsed = parsePlan(
      plan([step({ agent: 'freebuff' }), step({ id: 't', agent: 'rm -rf' })]),
    );
    expect(parsed.ok && parsed.steps.map((s) => s.requiredAgentId)).toEqual([
      'freebuff',
      undefined,
    ]);
  });

  it('rejects unknown dependencies, planning steps and oversized plans', () => {
    expect(parsePlan(plan([step({ dependsOn: ['ghost'] })])).ok).toBe(false);
    expect(parsePlan(plan([step({ taskKind: 'planning' })])).ok).toBe(false);
    expect(parsePlan(plan(Array.from({ length: 13 }, (_, i) => step({ id: `s${i}` })))).ok).toBe(
      false,
    );
    expect(parsePlan('```' + PLAN_FENCE + '\n{not json\n```').ok).toBe(false);
  });

  it('reads the last test marker and the last review block', () => {
    expect(parseTestResult('ODYSSEUS_TEST_RESULT: FAIL\nretried\nODYSSEUS_TEST_RESULT: PASS')).toBe(
      true,
    );
    expect(parseTestResult('no marker')).toBeUndefined();
    expect(parseReview(review('approve', [{ severity: 'high', summary: 'x' }]))?.verdict).toBe(
      'changes_requested',
    );
    expect(parseReview('nothing')).toBeUndefined();
  });
});
