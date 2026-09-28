import { randomUUID } from 'node:crypto';

import {
  USAGE_ALERT_PERCENT,
  usageWindowLabel,
  type AgentQuota,
  type BudgetLimit,
  type BudgetUsage,
  type IntegrationId,
} from '@odysseus/protocol';

import type { IDatabase } from '../db/types';

/** Agents whose plan usage an integration reports, by the integration's id. */
const AGENT_INTEGRATION: Record<string, IntegrationId> = {
  codex: 'codex',
  'claude-code': 'claude',
  antigravity: 'antigravity',
};

/**
 * A plan limit an agent stopped at, as the never-idle service records it
 * (`vendor_limits`). Only the fields read here are named.
 */
interface RecordedLimit {
  agentId: string;
  deviceId: string;
  resetsAt: string;
  resetKnown?: boolean;
  detectedAt?: string;
}

const QUOTA_ORDER: Record<AgentQuota['state'], number> = {
  exhausted: 0,
  low: 1,
  available: 2,
  unknown: 3,
};

/**
 * Budgets in tokens and dollars, and — because most people pay for coding
 * agents by subscription — the plan windows those subscriptions impose: a
 * 5-hour limit, a weekly cap. An agent out of its window is as unavailable
 * as one whose machine is off, and the router treats it that way.
 */
export class CostGovernor {
  constructor(private readonly db: IDatabase) {}

  /**
   * How much of an agent's plan is left on one machine.
   *
   * A recorded limit hit wins: the provider has already refused the agent.
   * Otherwise the provider's own window figures decide (Codex reports them);
   * a window whose reset time has passed counts as fresh. With neither, the
   * state is `unknown` — never a guess.
   */
  async quota(
    userId: string,
    deviceId: string,
    agentId: string,
    now = new Date(),
  ): Promise<AgentQuota> {
    return this.quotaFrom(await this.activeLimits(userId, now), deviceId, agentId, now);
  }

  /** Every agent on every machine the user has, most constrained first. */
  async quotaOverview(userId: string, now = new Date()): Promise<AgentQuota[]> {
    const [devices, limits, usage] = await Promise.all([
      this.db.devices.listByUser(userId),
      this.activeLimits(userId, now),
      this.db.providerUsage.listByUser(userId),
    ]);
    const pairs = new Map<string, { deviceId: string; agentId: string }>();
    const add = (deviceId: string, agentId: string) =>
      pairs.set(`${deviceId}|${agentId}`, { deviceId, agentId });
    for (const device of devices)
      for (const agent of device.availableAgents ?? []) add(device.id, agent.id);
    for (const limit of limits) add(limit.deviceId, limit.agentId);
    for (const record of usage) {
      const agentId = Object.keys(AGENT_INTEGRATION).find(
        (id) => AGENT_INTEGRATION[id] === record.integration,
      );
      if (agentId && record.snapshot.windows?.length) add(record.deviceId, agentId);
    }
    const quotas = await Promise.all(
      [...pairs.values()].map((pair) => this.quotaFrom(limits, pair.deviceId, pair.agentId, now)),
    );
    return quotas.sort(
      (a, b) =>
        QUOTA_ORDER[a.state] - QUOTA_ORDER[b.state] ||
        (b.window?.usedPercent ?? 0) - (a.window?.usedPercent ?? 0) ||
        a.agentId.localeCompare(b.agentId),
    );
  }

  private async quotaFrom(
    limits: RecordedLimit[],
    deviceId: string,
    agentId: string,
    now: Date,
  ): Promise<AgentQuota> {
    const hit = limits.find((limit) => limit.deviceId === deviceId && limit.agentId === agentId);
    if (hit)
      return {
        agentId,
        deviceId,
        state: 'exhausted',
        window: { label: 'Plan limit', resetsAt: hit.resetsAt },
        source: 'limit-hit',
        detail: `Plan limit reached; ${hit.resetKnown === false ? 'expected to reset' : 'resets'} ${inWords(Date.parse(hit.resetsAt) - now.getTime())}`,
        ...(hit.detectedAt ? { observedAt: hit.detectedAt } : {}),
      };

    const integration = AGENT_INTEGRATION[agentId];
    const record = integration ? await this.db.providerUsage.find(deviceId, integration) : null;
    const windows = (record?.snapshot.windows ?? []).map((window) => ({
      label: usageWindowLabel(window.windowMinutes),
      resetsAt: window.resetsAt,
      // A window whose reset has passed starts again from nothing.
      usedPercent: Date.parse(window.resetsAt) <= now.getTime() ? 0 : window.usedPercent,
    }));
    const worst = windows.sort((a, b) => b.usedPercent - a.usedPercent)[0];
    if (record && worst) {
      const used = Math.round(worst.usedPercent);
      const state = used >= 100 ? 'exhausted' : used >= USAGE_ALERT_PERCENT ? 'low' : 'available';
      const resets = inWords(Date.parse(worst.resetsAt) - now.getTime());
      return {
        agentId,
        deviceId,
        state,
        window: worst,
        source: 'provider',
        detail:
          state === 'exhausted'
            ? `${worst.label} reached; resets ${resets}`
            : `${worst.label} ${used}% used; resets ${resets}`,
        observedAt: record.snapshot.observedAt,
      };
    }
    return {
      agentId,
      deviceId,
      state: 'unknown',
      source: 'none',
      detail: 'No plan usage reported for this agent',
    };
  }

  /** Limits still in force. Read-only: the never-idle service owns clean-up. */
  private async activeLimits(userId: string, now: Date): Promise<RecordedLimit[]> {
    const records = await this.db.documents.listByUser<RecordedLimit>('vendor_limits', userId);
    return records
      .map((record) => record.data)
      .filter((limit) => Date.parse(limit.resetsAt) > now.getTime());
  }

  async setBudget(
    data: Omit<BudgetLimit, 'id' | 'createdAt' | 'updatedAt'> & { id?: string },
  ): Promise<BudgetLimit> {
    const now = new Date();
    return this.db.orchestration.upsertBudget({
      ...data,
      id: data.id ?? `bud_${randomUUID().replace(/-/g, '')}`,
      createdAt: now,
      updatedAt: now,
    });
  }
  async recordUsage(data: {
    sessionId: string;
    userId: string;
    projectId?: string;
    organizationId?: string;
    tokens: number;
    costUsd: number;
    billing?: 'metered' | 'subscription' | undefined;
  }): Promise<BudgetUsage[]> {
    if (
      !Number.isFinite(data.tokens) ||
      data.tokens < 0 ||
      !Number.isFinite(data.costUsd) ||
      data.costUsd < 0
    )
      throw new Error('Usage must be non-negative finite values');
    await this.db.orchestration.appendCost(data);
    const scopes: Array<{ scope: BudgetLimit['scope']; scopeId?: string }> = [
      { scope: 'session', scopeId: data.sessionId },
      ...(data.projectId ? [{ scope: 'project' as const, scopeId: data.projectId }] : []),
      ...(data.organizationId
        ? [{ scope: 'organization' as const, scopeId: data.organizationId }]
        : []),
    ];
    return (
      await Promise.all(
        scopes
          .filter((item): item is { scope: BudgetLimit['scope']; scopeId: string } =>
            Boolean(item.scopeId),
          )
          .map((item) => this.usage(item.scope, item.scopeId)),
      )
    ).flat();
  }
  async usage(scope: BudgetLimit['scope'], scopeId: string): Promise<BudgetUsage[]> {
    const budgets = await this.db.orchestration.listBudgets(scope, scopeId);
    const costs = await this.db.orchestration.listCosts(
      scope === 'session'
        ? { sessionId: scopeId }
        : scope === 'project'
          ? { projectId: scopeId }
          : { organizationId: scopeId },
    );
    const tokens = costs.reduce((sum, item) => sum + item.tokens, 0);
    const costUsd = costs.reduce((sum, item) => sum + item.costUsd, 0);
    return budgets.map((limit) => {
      const tokenRatio = limit.tokenLimit ? tokens / limit.tokenLimit : 0;
      const costRatio = limit.costLimitUsd ? costUsd / limit.costLimitUsd : 0;
      const ratio = Math.max(tokenRatio, costRatio);
      return {
        scope,
        scopeId,
        tokens,
        costUsd,
        limit,
        exceeded: ratio >= 1,
        alertTriggered: ratio >= limit.alertPercent / 100,
      };
    });
  }
}

/** "in 2 h 10 min", "in 40 min", "now". */
function inWords(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 60_000) return 'now';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `in ${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  return `in ${Math.round(hours / 24)} days`;
}
