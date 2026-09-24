import { randomUUID } from 'node:crypto';

import type {
  OrchestrationPlan,
  OrchestrationRun,
  OrchestrationStep,
  TaskKind,
} from '@odysseus/protocol';

import type { IDatabase } from '../db/types';
import type { ApprovalWorkflow } from '../policy/approval-workflow';
import type { PolicyEngineService } from '../policy/policy-engine-service';
import type { TunnelServer } from '../tunnel/tunnel-server';
import type { ProjectRecord, SessionRecord } from '../types';

import { buildStepPrompt, parsePlan, type PlannedStep } from './agent-roles';
import { type AgentRouter } from './agent-router';
import { type ContextAgent } from './context-agent';
import { CostGovernor } from './cost-governor';
import { RiskEngine } from './risk-engine';
import { collectOutput, outcomeFor } from './step-outcome';

/** A failing test or review may send work back to a builder this many times. */
export const DEFAULT_MAX_FIX_ATTEMPTS = 2;
/** Planning is read-only work that every capable agent can do; these do it best. */
const PLANNER_PREFERENCE = ['claude', 'codex'];
const TERMINAL_SESSION = new Set(['completed', 'failed', 'cancelled', 'crashed']);
const DONE_RUN = new Set(['completed', 'failed', 'cancelled']);

type StepInput = Pick<
  OrchestrationStep,
  'id' | 'title' | 'taskKind' | 'prompt' | 'dependsOn' | 'requiredAgentId'
>;

export interface OrchestratorAgents {
  /** Brings relevant imported conversations into a step's prompt. */
  context?: ContextAgent;
}

/**
 * Coordinates a DAG of scoped single-agent sessions; it never grants a child
 * more than policy permits.
 *
 * Every step is an ordinary session on one of the user's machines, so every
 * step goes through the same router, risk score, policy decision, approval and
 * budget check as a session the user started by hand. What the orchestrator
 * adds is the order, the hand-off, and three kinds of self-extension:
 *
 *  - a planning step's plan becomes the run's remaining steps;
 *  - a failed test step sends the failures to a builder, then re-tests;
 *  - a review that requests changes sends the findings to a builder, then
 *    re-reviews.
 *
 * `advance` is the only thing that moves a run. It is called when a run is
 * created, whenever one of its sessions finishes, when an approval is decided
 * and on request — and it is serialised per run, because two finishing
 * sessions arriving together must not both dispatch the same next step.
 */
export class MultiAgentOrchestrator {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: IDatabase,
    private readonly tunnel: TunnelServer,
    private readonly policy: PolicyEngineService,
    private readonly approvals: ApprovalWorkflow,
    private readonly router: AgentRouter,
    private readonly risk = new RiskEngine(),
    private readonly costs = new CostGovernor(db),
    private readonly agents: OrchestratorAgents = {},
  ) {}

  async createRun(input: {
    organizationId: string;
    userId: string;
    projectId: string;
    title: string;
    goal?: string;
    maxFixAttempts?: number;
    steps: StepInput[];
  }): Promise<OrchestrationRun> {
    const membership = await this.db.organizations.getMembership(
      input.organizationId,
      input.userId,
    );
    if (!membership) throw new Error('User is not a member of this organization');
    const project = await this.db.projects.findById(input.projectId);
    if (!project || project.organizationId !== input.organizationId)
      throw new Error('Project is not in this organization');
    validateDag(input.steps);
    const now = new Date();
    const plan: OrchestrationPlan = {
      id: `plan_${randomUUID().replace(/-/g, '')}`,
      projectId: input.projectId,
      title: input.title,
      steps: input.steps.map((step) => ({
        id: step.id,
        title: step.title,
        taskKind: step.taskKind,
        prompt: step.prompt,
        dependsOn: [...step.dependsOn],
        ...(step.requiredAgentId ? { requiredAgentId: step.requiredAgentId } : {}),
        state: 'pending',
      })),
      createdAt: now,
    };
    const run: OrchestrationRun = {
      id: `orch_${randomUUID().replace(/-/g, '')}`,
      organizationId: input.organizationId,
      userId: input.userId,
      ...(input.goal ? { goal: input.goal } : {}),
      maxFixAttempts: clampAttempts(input.maxFixAttempts),
      plan,
      state: 'planned',
      createdAt: now,
      updatedAt: now,
    };
    await this.db.orchestration.createRun(run);
    return this.advance(run.id);
  }

  /**
   * Start from a goal alone: the first step is the planner agent, whose plan
   * becomes the rest of the run.
   */
  async createPlannedRun(input: {
    organizationId: string;
    userId: string;
    projectId: string;
    goal: string;
    plannerAgentId?: string;
    maxFixAttempts?: number;
  }): Promise<OrchestrationRun> {
    const goal = input.goal.trim();
    if (!goal) throw new Error('A goal is required');
    if (goal.length > 4_000) throw new Error('The goal is longer than 4000 characters');
    return this.createRun({
      organizationId: input.organizationId,
      userId: input.userId,
      projectId: input.projectId,
      title: goal.split('\n')[0]!.slice(0, 120),
      goal,
      ...(input.maxFixAttempts !== undefined ? { maxFixAttempts: input.maxFixAttempts } : {}),
      steps: [
        {
          id: 'plan',
          title: 'Plan the work',
          taskKind: 'planning',
          prompt: `Plan how to achieve this goal in this repository:\n\n${goal}`,
          dependsOn: [],
          ...(input.plannerAgentId ? { requiredAgentId: input.plannerAgentId } : {}),
        },
      ],
    });
  }

  /** Move the run forward. Safe to call at any time and from anywhere. */
  advance(runId: string): Promise<OrchestrationRun> {
    return this.withLock(runId, () => this.advanceNow(runId));
  }

  /** One change to a run at a time; the caller still sees its own failure. */
  private withLock<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.locks.set(runId, next);
    next
      .catch(() => undefined)
      .finally(() => {
        if (this.locks.get(runId) === next) this.locks.delete(runId);
      });
    return next;
  }

  /** Called with any session that reached a final state. */
  async onSessionFinished(sessionId: string): Promise<void> {
    const session = await this.db.sessions.findById(sessionId);
    const runId = session?.config.metadata?.['orchestrationRunId'];
    if (typeof runId === 'string') await this.advance(runId);
  }

  cancel(runId: string, reason = 'Cancelled by the user'): Promise<OrchestrationRun> {
    return this.withLock(runId, () => this.cancelNow(runId, reason));
  }

  private async cancelNow(runId: string, reason: string): Promise<OrchestrationRun> {
    const run = await this.db.orchestration.findRun(runId);
    if (!run) throw new Error('Orchestration run not found');
    if (DONE_RUN.has(run.state)) return run;
    for (const step of run.plan.steps) {
      if (step.state === 'pending' || (step.state === 'blocked' && !step.sessionId)) {
        step.state = 'skipped';
        continue;
      }
      if ((step.state === 'running' || step.state === 'blocked') && step.sessionId) {
        const session = await this.db.sessions.findById(step.sessionId);
        if (session && !TERMINAL_SESSION.has(session.state)) {
          await this.tunnel
            .sendCommandToDevice(session.deviceId, 'session.stop', {
              sessionId: session.id,
              force: true,
              reason,
            })
            .catch(() => undefined);
          await this.db.sessions.update(session.id, { state: 'cancelled' });
        }
        step.state = 'failed';
        step.error = reason;
        step.finishedAt = new Date();
      }
    }
    return (await this.db.orchestration.updateRun(run.id, {
      plan: run.plan,
      state: 'cancelled',
      error: reason,
    }))!;
  }

  // ------------------------------------------------------------ the loop

  private async advanceNow(runId: string): Promise<OrchestrationRun> {
    const run = await this.db.orchestration.findRun(runId);
    if (!run) throw new Error('Orchestration run not found');
    if (DONE_RUN.has(run.state)) return run;
    const project = await this.db.projects.findById(run.plan.projectId);
    if (!project) throw new Error('Project not found');

    await this.reconcile(run);

    if (!run.error) {
      // Steps that could not start last time (no agent online, budget) are
      // tried again; a step waiting on its approval keeps waiting.
      for (const step of run.plan.steps) {
        if (step.state === 'blocked' && !step.sessionId) {
          step.state = 'pending';
          delete step.error;
        }
      }
      await this.dispatchReady(run, project);
    }

    const steps = run.plan.steps;
    run.state = run.error
      ? 'failed'
      : steps.every((step) => step.state === 'completed' || step.state === 'skipped')
        ? 'completed'
        : steps.some((step) => step.state === 'failed')
          ? 'failed'
          : steps.some((step) => step.state === 'blocked' && step.sessionId)
            ? 'waiting_for_approval'
            : 'running';
    if (run.state === 'failed' && !run.error)
      run.error = steps.find((step) => step.state === 'failed')?.error ?? 'A step failed';
    if (run.state === 'completed') run.completedAt = new Date();
    return (await this.db.orchestration.updateRun(run.id, {
      plan: run.plan,
      state: run.state,
      ...(run.error ? { error: run.error } : {}),
      ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    }))!;
  }

  /** Bring every dispatched step up to date with its session. */
  private async reconcile(run: OrchestrationRun): Promise<void> {
    for (const step of [...run.plan.steps]) {
      if (!step.sessionId || (step.state !== 'running' && step.state !== 'blocked')) continue;
      const session = await this.db.sessions.findById(step.sessionId);
      if (!session) continue;
      if (step.state === 'blocked') {
        // Waiting on an approval: approved sessions start running, denied
        // ones end, and either way the step follows.
        if (session.state === 'running' || TERMINAL_SESSION.has(session.state)) {
          step.state = 'running';
          delete step.error;
        } else continue;
      }
      if (!TERMINAL_SESSION.has(session.state)) continue;
      await this.finishStep(run, step, session);
      if (run.error) return;
    }
  }

  private async finishStep(
    run: OrchestrationRun,
    step: OrchestrationStep,
    session: SessionRecord,
  ): Promise<void> {
    step.finishedAt = session.completedAt ?? new Date();
    if (session.state !== 'completed') {
      step.state = 'failed';
      step.error = session.error ?? `The ${step.agentId ?? 'agent'} session ${session.state}`;
      return;
    }

    const collected = await collectOutput(this.db, session.id);
    step.outcome = outcomeFor(step, collected);
    step.state = 'completed';

    if (step.taskKind === 'planning') {
      const parsed = parsePlan(collected.text);
      if (!parsed.ok) {
        step.state = 'failed';
        step.error = parsed.error;
        return;
      }
      try {
        this.expandPlan(run, step, parsed.steps);
      } catch (error) {
        step.state = 'failed';
        step.error = error instanceof Error ? error.message : String(error);
      }
      return;
    }

    if (step.taskKind === 'test') {
      if (step.outcome.testsPassed === undefined) {
        step.state = 'failed';
        step.error = 'The test agent did not report PASS or FAIL';
        return;
      }
      if (!step.outcome.testsPassed) this.sendBack(run, step, 'test_fix');
      return;
    }

    if (step.taskKind === 'security_review') {
      if (!step.outcome.verdict) {
        step.state = 'failed';
        step.error = 'The reviewer did not return a review';
        return;
      }
      if (step.outcome.verdict === 'changes_requested') this.sendBack(run, step, 'review_fix');
    }
  }

  /**
   * Replace the planning step's successors with the planner's plan. Planned
   * steps run after the planning step, and a plan that changes code always
   * ends in a test and a review, whether or not the planner remembered.
   */
  private expandPlan(run: OrchestrationRun, planStep: OrchestrationStep, planned: PlannedStep[]) {
    const taken = new Set(run.plan.steps.map((step) => step.id));
    const rename = new Map<string, string>();
    for (const step of planned) {
      let id = step.id;
      for (let n = 2; taken.has(id); n += 1) id = `${step.id}-${n}`;
      taken.add(id);
      rename.set(step.id, id);
    }
    const added: OrchestrationStep[] = planned.map((step) => ({
      id: rename.get(step.id)!,
      title: step.title,
      taskKind: step.taskKind,
      prompt: step.prompt,
      dependsOn: step.dependsOn.length
        ? step.dependsOn.map((dep) => rename.get(dep)!)
        : [planStep.id],
      ...(step.requiredAgentId ? { requiredAgentId: step.requiredAgentId } : {}),
      state: 'pending',
      origin: 'planner',
    }));

    const builds = added.filter((step) => step.taskKind === 'implementation');
    if (builds.length) {
      let tests = added.filter((step) => step.taskKind === 'test');
      if (!tests.length) {
        const test = guaranteeStep(
          taken,
          'test',
          'Run the tests',
          'test',
          'Run the project tests that cover the changes made by the builder steps.',
          builds.map((step) => step.id),
        );
        added.push(test);
        tests = [test];
      }
      if (!added.some((step) => step.taskKind === 'security_review')) {
        added.push(
          guaranteeStep(
            taken,
            'review',
            'Review the changes',
            'security_review',
            'Review all the code changes made for this goal for bugs and security problems.',
            [...builds, ...tests].map((step) => step.id),
          ),
        );
      }
    }

    validateDag([...run.plan.steps, ...added]);
    run.plan.steps.push(...added);
  }

  /**
   * A check failed. Send its report to a builder and check again, rewiring
   * everything that waited on the check to wait on the re-check instead. The
   * run fails once the attempts are used up — an endless fix loop spends the
   * user's plan and never tells them anything.
   */
  private sendBack(
    run: OrchestrationRun,
    check: OrchestrationStep,
    origin: 'test_fix' | 'review_fix',
  ): void {
    const attempt = check.attempt ?? 1;
    const max = run.maxFixAttempts ?? DEFAULT_MAX_FIX_ATTEMPTS;
    const what =
      origin === 'test_fix' ? 'Tests are still failing' : 'The review still requests changes';
    if (attempt > max) {
      run.error = `${what} after ${max} fix attempt${max === 1 ? '' : 's'} (${check.title})`;
      return;
    }
    const base = check.id.replace(/-recheck-\d+$/, '');
    const taken = new Set(run.plan.steps.map((step) => step.id));
    const fixId = uniqueId(taken, `${base}-fix-${attempt}`);
    const recheckId = uniqueId(taken, `${base}-recheck-${attempt}`);
    const fix: OrchestrationStep = {
      id: fixId,
      title:
        origin === 'test_fix'
          ? `Fix failing tests (attempt ${attempt})`
          : `Address review findings (attempt ${attempt})`,
      taskKind: 'implementation',
      prompt:
        origin === 'test_fix'
          ? 'The test agent reported failures (shown above). Fix the code so the tests pass. ' +
            'Do not weaken, skip or delete tests to make them pass.'
          : 'The reviewer requested changes (findings above). Fix every high and critical ' +
            'finding, and the others where the fix is clear.',
      dependsOn: [check.id],
      state: 'pending',
      origin,
      attempt,
    };
    const recheck: OrchestrationStep = {
      id: recheckId,
      title: `${check.title.replace(/ \(re-check \d+\)$/, '')} (re-check ${attempt})`,
      taskKind: check.taskKind,
      prompt: check.prompt,
      dependsOn: [fixId],
      ...(check.requiredAgentId ? { requiredAgentId: check.requiredAgentId } : {}),
      state: 'pending',
      origin,
      attempt: attempt + 1,
    };
    for (const step of run.plan.steps) {
      if (step.id !== fix.id && step.dependsOn.includes(check.id))
        step.dependsOn = step.dependsOn.map((dep) => (dep === check.id ? recheckId : dep));
    }
    run.plan.steps.push(fix, recheck);
  }

  // ------------------------------------------------------------ dispatch

  private async dispatchReady(run: OrchestrationRun, project: ProjectRecord): Promise<void> {
    const byId = new Map(run.plan.steps.map((step) => [step.id, step]));
    // Builders share one working tree. Two at once would edit the same files
    // under each other, so they take turns; readers may overlap.
    let builderBusy = run.plan.steps.some(
      (step) =>
        writes(step.taskKind) &&
        (step.state === 'running' || (step.state === 'blocked' && step.sessionId)),
    );

    for (const step of run.plan.steps.filter(
      (candidate) =>
        candidate.state === 'pending' &&
        candidate.dependsOn.every((id) => byId.get(id)?.state === 'completed'),
    )) {
      if (writes(step.taskKind)) {
        if (builderBusy) continue;
        builderBusy = true;
      }
      const started = await this.dispatch(run, project, step, byId);
      if (!started && writes(step.taskKind)) builderBusy = false;
    }
  }

  /** Start one step. Returns false when it could not start. */
  private async dispatch(
    run: OrchestrationRun,
    project: ProjectRecord,
    step: OrchestrationStep,
    byId: Map<string, OrchestrationStep>,
  ): Promise<boolean> {
    const risk = this.risk.assess({
      taskKind: step.taskKind,
      prompt: step.prompt,
      protectedProject: Boolean(project.preferences.protectedBranches.length),
    });
    const route = await this.route(run, project, step, risk.score);
    if (!route.selected) {
      step.state = 'blocked';
      step.error = step.requiredAgentId
        ? `${step.requiredAgentId} is not available on any online machine`
        : 'No eligible online agent';
      return false;
    }
    const budget = await this.costs.usage('organization', run.organizationId);
    if (budget.some((usage) => usage.exceeded)) {
      step.state = 'blocked';
      step.error = 'Organization budget exceeded';
      return false;
    }

    const prompt = await this.composePrompt(run, project, step, byId);
    const sessionId = `sess_${randomUUID().replace(/-/g, '')}`;
    const session = await this.db.sessions.create({
      id: sessionId,
      userId: run.userId,
      deviceId: route.selected.deviceId,
      gatewayId: route.selected.gatewayId,
      agentId: route.selected.agentId,
      projectId: project.id,
      organizationId: run.organizationId,
      projectRoot: project.root,
      state: 'initializing',
      trustProfile: project.preferences.defaultTrustProfile ?? 'default',
      config: {
        projectRoot: project.root,
        adapter: route.selected.agentId,
        prompt,
        metadata: {
          orchestrationRunId: run.id,
          orchestrationStepId: step.id,
          orchestrationRole: step.taskKind,
        },
      },
      startedAt: new Date(),
    });
    const policyDecision = await this.policy.evaluate('process.exec', risk.level, {
      resource: `orchestration:${step.taskKind}`,
      projectId: project.id,
      deviceId: route.selected.deviceId,
      sessionId,
      userId: run.userId,
    });
    step.risk = risk;
    step.routingDecision = route;
    step.sessionId = sessionId;
    step.agentId = route.selected.agentId;
    step.startedAt = new Date();
    if (policyDecision.decision === 'deny') {
      step.state = 'failed';
      step.error = policyDecision.reason;
      await this.db.sessions.update(sessionId, { state: 'failed', error: step.error });
      return false;
    }
    if (policyDecision.decision === 'require_approval') {
      const approval = await this.approvals.createApproval({
        sessionId,
        deviceId: route.selected.deviceId,
        userId: run.userId,
        actionType: 'process.exec',
        description: `Orchestration step: ${step.title}`,
        details: {
          riskClass: risk.level,
          resource: `orchestration:${step.taskKind}`,
          orchestrationRunId: run.id,
          orchestrationStepId: step.id,
          pendingCommand: {
            commandType: 'session.start',
            payload: { sessionId, config: session.config },
          },
        },
        policyVersion: policyDecision.policyVersion,
        matchedRules: policyDecision.matchedRules,
        ...(policyDecision.requiredRole ? { requiredRole: policyDecision.requiredRole } : {}),
        ...(policyDecision.expiresAt ? { expiresAt: policyDecision.expiresAt } : {}),
      });
      step.state = 'blocked';
      step.error = `Approval required: ${approval.id}`;
      await this.db.sessions.update(sessionId, { state: 'waiting_for_approval' });
      return true;
    }
    const dispatched = await this.tunnel.sendCommandToDevice(
      route.selected.deviceId,
      'session.start',
      { sessionId, config: session.config },
    );
    if (!dispatched.delivered) {
      step.state = 'blocked';
      step.error = 'Selected gateway went offline';
      delete step.sessionId;
      await this.db.sessions.update(sessionId, { state: 'failed', error: step.error });
      return false;
    }
    step.state = 'running';
    await this.db.sessions.update(sessionId, { state: 'running' });
    return true;
  }

  private async route(
    run: OrchestrationRun,
    project: ProjectRecord,
    step: OrchestrationStep,
    maxRiskScore: number,
  ) {
    const request = (requiredAgentId?: string) =>
      this.router.route(run.userId, {
        projectId: project.id,
        taskKind: step.taskKind,
        ...(requiredAgentId ? { requiredAgentId } : {}),
        maxRiskScore,
      });
    if (step.requiredAgentId) return request(step.requiredAgentId);
    if (step.taskKind === 'planning') {
      for (const agent of PLANNER_PREFERENCE) {
        const decision = await request(agent);
        if (decision.selected) return decision;
      }
    }
    return request(project.preferences.preferredAdapter);
  }

  /** The step's role, the goal, its predecessors' work and relevant history. */
  private async composePrompt(
    run: OrchestrationRun,
    project: ProjectRecord,
    step: OrchestrationStep,
    byId: Map<string, OrchestrationStep>,
  ): Promise<string> {
    const dependencies = step.dependsOn
      .map((id) => byId.get(id))
      .filter((dep): dep is OrchestrationStep => Boolean(dep));

    let history: string | undefined;
    if (this.agents.context && (step.taskKind === 'planning' || writes(step.taskKind))) {
      const selection = await this.agents.context
        .select(run.userId, `${run.goal ?? ''} ${step.title} ${step.prompt}`, project.root)
        .catch(() => ({ block: '', conversationIds: [] }));
      if (selection.block) {
        history = selection.block;
        step.contextConversationIds = selection.conversationIds;
      }
    }

    let diff: string | undefined;
    if (step.taskKind === 'security_review') diff = await this.latestDiff(step, byId);

    return buildStepPrompt(step, { goal: run.goal, dependencies, history, diff });
  }

  /**
   * The uncommitted changes as of the most recent builder this review
   * depends on. Builders share one working tree, so the latest one's diff
   * contains the earlier ones' work too.
   */
  private async latestDiff(
    step: OrchestrationStep,
    byId: Map<string, OrchestrationStep>,
  ): Promise<string | undefined> {
    const builders: OrchestrationStep[] = [];
    const seen = new Set<string>();
    const walk = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const dep = byId.get(id);
      if (!dep) return;
      if (writes(dep.taskKind) && dep.sessionId && dep.state === 'completed') builders.push(dep);
      dep.dependsOn.forEach(walk);
    };
    step.dependsOn.forEach(walk);
    const latest = builders.sort(
      (a, b) =>
        (b.finishedAt ? +new Date(b.finishedAt) : 0) - (a.finishedAt ? +new Date(a.finishedAt) : 0),
    )[0];
    if (!latest?.sessionId) return undefined;
    const session = await this.db.sessions.findById(latest.sessionId);
    if (!session) return undefined;
    if (session.reviewBundle?.diff) return session.reviewBundle.diff;
    const ack = await this.tunnel
      .sendCommandToDevice(
        session.deviceId,
        'session.diff_collection',
        { sessionId: session.id, projectRoot: session.projectRoot },
        30_000,
      )
      .catch(() => undefined);
    const payload = ack?.payload as { result?: { diff?: unknown }; diff?: unknown } | undefined;
    const diff = payload?.result?.diff ?? payload?.diff;
    return typeof diff === 'string' && diff ? diff : undefined;
  }
}

function writes(kind: TaskKind): boolean {
  return kind === 'implementation' || kind === 'general';
}

function clampAttempts(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_FIX_ATTEMPTS;
  return Math.max(0, Math.min(5, Math.floor(value)));
}

function uniqueId(taken: Set<string>, wanted: string): string {
  let id = wanted;
  for (let n = 2; taken.has(id); n += 1) id = `${wanted}-${n}`;
  taken.add(id);
  return id;
}

function guaranteeStep(
  taken: Set<string>,
  id: string,
  title: string,
  taskKind: TaskKind,
  prompt: string,
  dependsOn: string[],
): OrchestrationStep {
  return {
    id: uniqueId(taken, id),
    title,
    taskKind,
    prompt,
    dependsOn,
    state: 'pending',
    origin: 'guarantee',
  };
}

function validateDag(steps: Array<Pick<OrchestrationStep, 'id' | 'dependsOn'>>): void {
  const ids = new Set(steps.map((step) => step.id));
  if (
    ids.size !== steps.length ||
    steps.some((step) => !step.id || step.dependsOn.some((id) => !ids.has(id) || id === step.id))
  )
    throw new Error('Invalid orchestration dependencies');
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('Orchestration plan contains a cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const parent of byId.get(id)!.dependsOn) visit(parent);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
}
