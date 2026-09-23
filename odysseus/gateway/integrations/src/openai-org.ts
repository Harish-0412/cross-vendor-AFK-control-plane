import type { OpenAiOrgUsage, ProviderUsageSnapshot } from '@odysseus/protocol';

interface ApiPage {
  data?: unknown;
  next_page?: unknown;
}
type Fetch = typeof fetch;

export class OpenAiOrgClient {
  constructor(
    private readonly fetcher: Fetch = fetch,
    private readonly baseUrl = 'https://api.openai.com/v1/organization',
  ) {}

  async validate(adminKey: string): Promise<void> {
    const end = Math.floor(Date.now() / 1000);
    await this.pages(`${this.baseUrl}/costs`, adminKey, {
      start_time: String(end - 86400),
      end_time: String(end),
      bucket_width: '1d',
      limit: '1',
    });
  }

  async snapshot(adminKey: string, now = new Date()): Promise<ProviderUsageSnapshot> {
    const end = Math.floor(now.getTime() / 1000);
    const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const start = Math.floor(startDate.getTime() / 1000);
    const [costBuckets, usageBuckets] = await Promise.all([
      this.pages(`${this.baseUrl}/costs`, adminKey, {
        start_time: String(start),
        end_time: String(end),
        bucket_width: '1d',
        limit: '31',
        'group_by[]': ['project_id', 'line_item'],
      }),
      this.pages(`${this.baseUrl}/usage/completions`, adminKey, {
        start_time: String(start),
        end_time: String(end),
        bucket_width: '1d',
        limit: '31',
        'group_by[]': ['project_id', 'model'],
      }),
    ]);
    const usage = aggregate(costBuckets, usageBuckets, startDate.toISOString(), now.toISOString());
    return {
      provider: 'openai-org',
      source: 'openai-costs-api',
      observedAt: now.toISOString(),
      organization: usage,
    };
  }

  private async pages(
    url: string,
    key: string,
    params: Record<string, string | string[]>,
  ): Promise<Record<string, unknown>[]> {
    const all: Record<string, unknown>[] = [];
    let page: string | undefined;
    for (let n = 0; n < 100; n += 1) {
      const query = new URLSearchParams();
      for (const [name, value] of Object.entries(params))
        for (const item of Array.isArray(value) ? value : [value]) query.append(name, item);
      if (page) query.set('page', page);
      const response = await this.fetcher(`${url}?${query}`, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      });
      if (!response.ok) {
        const message =
          response.status === 401 || response.status === 403
            ? 'OpenAI rejected this Admin key or it lacks organization usage permission'
            : `OpenAI Usage API returned HTTP ${response.status}`;
        throw new Error(message);
      }
      const body = (await response.json()) as ApiPage;
      if (Array.isArray(body.data))
        all.push(
          ...body.data.filter((item): item is Record<string, unknown> =>
            Boolean(item && typeof item === 'object'),
          ),
        );
      page = typeof body.next_page === 'string' && body.next_page ? body.next_page : undefined;
      if (!page) break;
    }
    return all;
  }
}

function aggregate(
  costBuckets: Record<string, unknown>[],
  usageBuckets: Record<string, unknown>[],
  periodStart: string,
  periodEnd: string,
): OpenAiOrgUsage {
  const daily = new Map<
    number,
    { startTime: string; endTime: string; amount: number; currency: string }
  >();
  const byProject = new Map<string, number>();
  const byLineItem = new Map<string, number>();
  let totalCost = 0;
  let currency = 'usd';
  for (const bucket of costBuckets) {
    const start = number(bucket['start_time']);
    const end = number(bucket['end_time']);
    let dayAmount = 0;
    for (const result of array(bucket['results'])) {
      const amount = number(object(result['amount'])['value']);
      currency = string(object(result['amount'])['currency']) ?? currency;
      totalCost += amount;
      dayAmount += amount;
      add(byProject, string(result['project_id']) ?? 'unattributed', amount);
      add(byLineItem, string(result['line_item']) ?? 'other', amount);
    }
    if (start)
      daily.set(start, {
        startTime: new Date(start * 1000).toISOString(),
        endTime: new Date((end || start + 86400) * 1000).toISOString(),
        amount: dayAmount,
        currency,
      });
  }
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let requests = 0;
  const byModel = new Map<
    string,
    { inputTokens: number; outputTokens: number; requests: number }
  >();
  for (const bucket of usageBuckets)
    for (const result of array(bucket['results'])) {
      const input = number(result['input_tokens']);
      const cached = number(result['input_cached_tokens']);
      const output = number(result['output_tokens']);
      const count = number(result['num_model_requests']);
      inputTokens += input;
      cachedInputTokens += cached;
      outputTokens += output;
      requests += count;
      const model = string(result['model']) ?? 'unknown';
      const previous = byModel.get(model) ?? { inputTokens: 0, outputTokens: 0, requests: 0 };
      previous.inputTokens += input;
      previous.outputTokens += output;
      previous.requests += count;
      byModel.set(model, previous);
    }
  return {
    periodStart,
    periodEnd,
    currency,
    totalCost,
    daily: [...daily.values()].sort((a, b) => a.startTime.localeCompare(b.startTime)),
    byProject: [...byProject].map(([id, amount]) => ({ id, amount })),
    byLineItem: [...byLineItem].map(([name, amount]) => ({ name, amount })),
    inputTokens,
    cachedInputTokens,
    outputTokens,
    requests,
    byModel: [...byModel].map(([model, totals]) => ({ model, ...totals })),
  };
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const array = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(object) : [];
const number = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;
const string = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;
function add(map: Map<string, number>, key: string, value: number) {
  map.set(key, (map.get(key) ?? 0) + value);
}
