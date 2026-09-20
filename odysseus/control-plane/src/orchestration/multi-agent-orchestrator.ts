import { randomUUID } from 'node:crypto';

import type { OrchestrationPlan, OrchestrationRun, OrchestrationStep } from '@odysseus/protocol';

import type { IDatabase } from '../db/types';
import type { ApprovalWorkflow } from '../policy/approval-workflow';
import type { PolicyEngineService } from '../policy/policy-engine-service';
import type { TunnelServer } from '../tunnel/tunnel-server';

import { type AgentRouter } from './agent-router';
import { CostGovernor } from './cost-governor';
import { RiskEngine } from './risk-engine';

/** Coordinates a DAG of scoped single-agent sessions; it never grants a child more than policy permits. */
export class MultiAgentOrchestrator {
  constructor(
    private readonly db: IDatabase,
    private readonly tunnel: TunnelServer,
    private readonly policy: PolicyEngineService,
    private readonly approvals: ApprovalWorkflow,
    private readonly router: AgentRouter,
    private readonly risk = new RiskEngine(),
    private readonly costs = new CostGovernor(db),
  ) {}

  async createRun(input: {
    organizationId: string;
    userId: string;
    projectId: string;
    title: string;
    steps: Array<
      Pick<
        OrchestrationStep,
        'id' | 'title' | 'taskKind' | 'prompt' | 'dependsOn' | 'requiredAgentId'
      >
    >;
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
        ...step,
        dependsOn: [...step.dependsOn],
        state: 'pending',
      })),
      createdAt: now,
    };
    const run: OrchestrationRun = {
      id: `orch_${randomUUID().replace(/-/g, '')}`,
      organizationId: input.organizationId,
      userId: input.userId,
      plan,
      state: 'planned',
      createdAt: now,
      updatedAt: now,
    };
    await this.db.orchestration.createRun(run);
    return this.advance(run.id);
  }

  async advance(runId: string): Promise<OrchestrationRun> {
    const run = await this.db.orchestration.findRun(runId);
    if (!run) throw new Error('Orchestration run not found');
    if (run.state === 'completed' || run.state === 'failed' || run.state === 'cancelled')
      return run;
    const project = await this.db.projects.findById(run.plan.projectId);
    if (!project) throw new Error('Project not found');
    let waitingForApproval = false;
    for (const step of run.plan.steps.filter(
      (candidate) =>
        candidate.state === 'pending' &&
        candidate.dependsOn.every(
          (id) => run.plan.steps.find((item) => item.id === id)?.state === 'completed',
        ),
    )) {
      const risk = this.risk.assess({
        taskKind: step.taskKind,
        prompt: step.prompt,
        protectedProject: Boolean(project.preferences.protectedBranches.length),
      });
      const route = await this.router.route(run.userId, {
        projectId: project.id,
        taskKind: step.taskKind,
        ...(step.requiredAgentId ? { requiredAgentId: step.requiredAgentId } : {}),
        maxRiskScore: risk.score,
      });
      if (!route.selected) {
        step.state = 'blocked';
        step.error = 'No eligible online agent';
        continue;
      }
      const budget = await this.costs.usage('organization', run.organizationId);
      if (budget.some((usage) => usage.exceeded)) {
        step.state = 'blocked';
        step.error = 'Organization budget exceeded';
        continue;
      }
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
          prompt: step.prompt,
          metadata: { orchestrationRunId: run.id, orchestrationStepId: step.id },
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
      if (policyDecision.decision === 'deny') {
        step.state = 'blocked';
        step.error = policyDecision.reason;
        await this.db.sessions.update(sessionId, { state: 'failed', error: step.error });
        continue;
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
        waitingForApproval = true;
        continue;
      }
      const dispatched = await this.tunnel.sendCommandToDevice(
        route.selected.deviceId,
        'session.start',
        { sessionId, config: session.config },
      );
      if (!dispatched.delivered) {
        step.state = 'blocked';
        step.error = 'Selected gateway went offline';
        await this.db.sessions.update(sessionId, { state: 'failed', error: step.error });
        continue;
      }
      step.sessionId = sessionId;
      step.state = 'running';
      await this.db.sessions.update(sessionId, { state: 'running' });
    }
    for (const step of run.plan.steps.filter(
      (item) => item.state === 'running' && item.sessionId,
    )) {
      const session = await this.db.sessions.findById(step.sessionId!);
      if (session?.state === 'completed') step.state = 'completed';
      else if (session && ['failed', 'cancelled', 'crashed'].includes(session.state)) {
        step.state = 'failed';
        step.error = session.error ?? session.state;
      }
    }
    run.state = run.plan.steps.every((step) => step.state === 'completed')
      ? 'completed'
      : run.plan.steps.some((step) => step.state === 'failed')
        ? 'failed'
        : waitingForApproval
          ? 'waiting_for_approval'
          : 'running';
    if (run.state === 'completed') run.completedAt = new Date();
    run.updatedAt = new Date();
    return (await this.db.orchestration.updateRun(run.id, {
      plan: run.plan,
      state: run.state,
      ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    }))!;
  }
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
