import { randomUUID } from 'node:crypto';

import type { BudgetLimit, BudgetUsage } from '@odysseus/protocol';

import type { IDatabase } from '../db/types';

export class CostGovernor {
  constructor(private readonly db: IDatabase) {}
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
