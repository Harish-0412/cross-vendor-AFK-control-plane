/**
 * What the cross-vendor features need from the rest of the Control Plane:
 * which agents a machine can run, starting a session through the same policy
 * and approval gates as any other session, and the workstation's isolated
 * workspaces.
 */
import { randomUUID } from 'node:crypto';

import type { AgentInfo, TaskKind } from '@odysseus/protocol';

import type { IDatabase } from '../db/types';
import { RiskEngine } from '../orchestration/risk-engine';
import { collectOutput, type CollectedOutput } from '../orchestration/step-outcome';
import type { ApprovalWorkflow } from '../policy/approval-workflow';
import type { PolicyEngineService } from '../policy/policy-engine-service';
import type { ConnectionRegistry } from '../tunnel/connection-registry';
import type { TunnelServer } from '../tunnel/tunnel-server';

import type { RecentChange, WorkspaceEvaluation } from './types';

export const TERMINAL_SESSION_STATES = new Set(['completed', 'failed', 'cancelled', 'crashed']);

/** Friendly names, used in prompts and in the web app. */
export const AGENT_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
  freebuff: 'Freebuff',
  mock: 'Mock agent',
};

export const agentName = (id: string): string => AGENT_NAMES[id] ?? id;

export interface StartedSession {
  sessionId: string;
  state: 'running' | 'waiting_for_approval' | 'failed';
  error?: string;
}

export class ArenaRuntime {
  private readonly risk = new RiskEngine();

  constructor(
    readonly db: IDatabase,
    private readonly tunnel: TunnelServer,
    private readonly registry: ConnectionRegistry,
    private readonly policy: PolicyEngineService,
    private readonly approvals: ApprovalWorkflow,
  ) {}

  isOnline(deviceId: string): boolean {
    return this.registry.isDeviceAcceptingSessions(deviceId);
  }

  /** Agents installed and not unhealthy on a machine, asked live. */
  async installedAgents(deviceId: string): Promise<string[]> {
    const response = await this.tunnel.sendCommandToDevice(deviceId, 'system.inventory', {}, 8_000);
    const payload = unwrap(response.payload) as { agents?: AgentInfo[] } | undefined;
    if (!payload?.agents) return [];
    return payload.agents
      .filter((agent) => agent.installed && agent.health.status !== 'unhealthy')
      .map((agent) => agent.metadata.id);
  }

  /**
   * Record and start a session. Policy decides as it does for every other
   * session: allowed sessions start now, others wait for an approval.
   */
  async startSession(input: {
    userId: string;
    deviceId: string;
    agentId: string;
    projectId?: string | undefined;
    projectRoot: string;
    prompt: string;
    taskKind: TaskKind;
    purpose: string;
    metadata: Record<string, unknown>;
  }): Promise<StartedSession> {
    const device = await this.db.devices.findById(input.deviceId);
    if (!device || device.userId !== input.userId) {
      return { sessionId: '', state: 'failed', error: 'Machine not found' };
    }
    const sessionId = `sess_${randomUUID().replace(/-/g, '')}`;
    const config = {
      projectRoot: input.projectRoot,
      adapter: input.agentId,
      prompt: input.prompt,
      metadata: {
        ...input.metadata,
        sessionId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
      },
    };
    await this.db.sessions.create({
      id: sessionId,
      userId: input.userId,
      deviceId: input.deviceId,
      gatewayId: device.gatewayId,
      agentId: input.agentId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      projectRoot: input.projectRoot,
      state: 'initializing',
      trustProfile: device.defaultTrustProfile,
      config,
      startedAt: new Date(),
    });

    const risk = this.risk.assess({ taskKind: input.taskKind, prompt: input.prompt });
    const decision = await this.policy.evaluate('process.exec', risk.level, {
      resource: `arena:${input.purpose}`,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      deviceId: input.deviceId,
      sessionId,
      userId: input.userId,
    });
    if (decision.decision === 'deny') {
      await this.db.sessions.update(sessionId, { state: 'failed', error: decision.reason });
      return { sessionId, state: 'failed', error: decision.reason };
    }
    if (decision.decision === 'require_approval') {
      await this.approvals.createApproval({
        sessionId,
        deviceId: input.deviceId,
        userId: input.userId,
        actionType: 'process.exec',
        description: `${agentName(input.agentId)}: ${input.purpose}`,
        details: {
          riskClass: risk.level,
          resource: `arena:${input.purpose}`,
          pendingCommand: { commandType: 'session.start', payload: { sessionId, config } },
        },
        policyVersion: decision.policyVersion,
        matchedRules: decision.matchedRules,
        ...(decision.requiredRole ? { requiredRole: decision.requiredRole } : {}),
        ...(decision.expiresAt ? { expiresAt: decision.expiresAt } : {}),
      });
      await this.db.sessions.update(sessionId, { state: 'waiting_for_approval' });
      return { sessionId, state: 'waiting_for_approval' };
    }

    const ack = await this.tunnel.sendCommandToDevice(
      input.deviceId,
      'session.start',
      { sessionId, config },
      30_000,
    );
    const outcome = ack.payload as { success?: boolean; error?: string } | undefined;
    const error = !ack.delivered
      ? 'The machine is offline'
      : !ack.acknowledged
        ? 'The machine did not answer in time'
        : outcome?.success === false
          ? (outcome.error ?? 'The machine refused to start the agent')
          : undefined;
    if (error) {
      await this.db.sessions.update(sessionId, { state: 'failed', error });
      return { sessionId, state: 'failed', error };
    }
    await this.db.sessions.update(sessionId, { state: 'running' });
    return { sessionId, state: 'running' };
  }

  async stopSession(sessionId: string, reason: string): Promise<void> {
    const session = await this.db.sessions.findById(sessionId);
    if (!session || TERMINAL_SESSION_STATES.has(session.state)) return;
    await this.tunnel
      .sendCommandToDevice(session.deviceId, 'session.stop', { sessionId, force: true, reason })
      .catch(() => undefined);
    await this.db.sessions.update(sessionId, { state: 'cancelled', error: reason });
  }

  output(sessionId: string): Promise<CollectedOutput> {
    return collectOutput(this.db, sessionId);
  }

  // ---------------------------------------------------------- workspaces

  prepareWorkspace(
    deviceId: string,
    projectRoot: string,
    ref: string,
    label: string,
  ): Promise<{ workspaceRoot: string; commit: string }> {
    return this.command(deviceId, 'workspace.prepare', { projectRoot, ref, label }, 120_000);
  }

  evaluateWorkspace(
    deviceId: string,
    workspaceRoot: string,
    baseCommit: string,
    realTests?: { commit: string; paths: string[] },
  ): Promise<WorkspaceEvaluation> {
    return this.command(
      deviceId,
      'workspace.evaluate',
      { workspaceRoot, baseCommit, ...(realTests ? { realTests } : {}) },
      15 * 60_000,
    );
  }

  recentChanges(deviceId: string, projectRoot: string, limit: number): Promise<RecentChange[]> {
    return this.command(deviceId, 'git.recent_changes', { projectRoot, limit }, 60_000);
  }

  commitBranch(
    deviceId: string,
    workspaceRoot: string,
    branch: string,
    message: string,
  ): Promise<{ branch: string; commit: string }> {
    return this.command(
      deviceId,
      'workspace.commit_branch',
      { workspaceRoot, branch, message },
      60_000,
    );
  }

  removeWorkspace(deviceId: string, workspaceRoot: string): Promise<unknown> {
    return this.command(deviceId, 'workspace.remove', { workspaceRoot }, 120_000);
  }

  private async command<T>(
    deviceId: string,
    type: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<T> {
    const ack = await this.tunnel.sendCommandToDevice(deviceId, type, payload, timeoutMs);
    if (!ack.delivered) throw new Error('The machine is offline');
    if (!ack.acknowledged) throw new Error('The machine did not answer in time');
    const reply = ack.payload as
      { success?: boolean; result?: unknown; error?: string } | undefined;
    if (reply?.success === false) {
      throw new Error(
        /Unsupported command/.test(reply.error ?? '')
          ? 'The gateway on this machine is too old for this feature. Update it and start it again.'
          : (reply.error ?? `${type} failed`),
      );
    }
    return (reply?.result ?? reply) as T;
  }
}

function unwrap(value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'result' in value
    ? (value as { result: unknown }).result
    : value;
}
