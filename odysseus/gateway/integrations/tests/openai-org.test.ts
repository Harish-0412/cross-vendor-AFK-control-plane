import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalCredentialStore } from '../src/credential-store';
import { OpenAiOrgClient } from '../src/openai-org';
import { createHome } from './helpers';

describe('OpenAI organization usage', () => {
  const homes: ReturnType<typeof createHome>[] = [];
  afterEach(() => homes.splice(0).forEach((home) => home.cleanup()));

  it('encrypts the Admin key at rest', async () => {
    const ctx = createHome();
    homes.push(ctx);
    const store = new LocalCredentialStore(ctx);
    await store.save('openai-org', 'sk-admin-secret-value');
    expect(await store.load('openai-org')).toBe('sk-admin-secret-value');
    const { readFile } = await import('node:fs/promises');
    const onDisk = await readFile(`${ctx.odysseusHome}/credentials/openai-org.json`, 'utf8');
    expect(onDisk).not.toContain('sk-admin-secret-value');
  });

  it('paginates provider data and reports exact costs and tokens without estimates', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes('/usage/completions')
        ? {
            data: [
              {
                results: [
                  {
                    input_tokens: 10,
                    input_cached_tokens: 3,
                    output_tokens: 4,
                    num_model_requests: 2,
                    model: 'gpt-test',
                  },
                ],
              },
            ],
          }
        : url.includes('page=next')
          ? {
              data: [
                {
                  start_time: 2,
                  end_time: 3,
                  results: [
                    {
                      amount: { value: 2.5, currency: 'usd' },
                      project_id: 'p2',
                      line_item: 'tools',
                    },
                  ],
                },
              ],
            }
          : {
              data: [
                {
                  start_time: 1,
                  end_time: 2,
                  results: [
                    {
                      amount: { value: 1.25, currency: 'usd' },
                      project_id: 'p1',
                      line_item: 'models',
                    },
                  ],
                },
              ],
              next_page: 'next',
            };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const snapshot = await new OpenAiOrgClient(
      fetcher as typeof fetch,
      'https://example.test/v1/organization',
    ).snapshot('secret', new Date('2026-09-23T00:00:00Z'));
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(snapshot.organization?.totalCost).toBe(3.75);
    expect(snapshot.organization).toMatchObject({
      inputTokens: 10,
      cachedInputTokens: 3,
      outputTokens: 4,
      requests: 2,
    });
    for (const call of fetcher.mock.calls) expect(String(call[0])).not.toContain('secret');
  });
});
