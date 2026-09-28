import type { IDatabase } from '../db/types';

/** How far back the Budgets page looks. */
export const SPEND_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One person's recorded usage over a recent window, across every session and
 * organization. Subscription tokens are counted but carry no dollar figure
 * (see `CostEventRecord.billing`), so `costUsd` is metered spend only.
 */
export interface SpendSummary {
  since: string;
  days: number;
  costUsd: number;
  dailyAverageUsd: number;
  tokens: number;
  subscriptionTokens: number;
}

export async function spendSummary(
  db: IDatabase,
  userId: string,
  now = new Date(),
  days = SPEND_WINDOW_DAYS,
): Promise<SpendSummary> {
  const since = new Date(now.getTime() - days * DAY_MS);
  const costs = (await db.orchestration.listCosts({ userId })).filter(
    (cost) => new Date(cost.recordedAt).getTime() >= since.getTime(),
  );
  const costUsd = costs.reduce((sum, cost) => sum + cost.costUsd, 0);
  return {
    since: since.toISOString(),
    days,
    costUsd,
    dailyAverageUsd: costUsd / days,
    tokens: costs.reduce((sum, cost) => sum + cost.tokens, 0),
    subscriptionTokens: costs
      .filter((cost) => cost.billing === 'subscription')
      .reduce((sum, cost) => sum + cost.tokens, 0),
  };
}
