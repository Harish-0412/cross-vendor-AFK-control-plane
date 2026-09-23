import { join } from 'node:path';

import type { IntegrationDataUpdate, IntegrationScope } from '@odysseus/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IntegrationManager } from '../src/integration-manager';
import { HistorySync } from '../src/sync/history-sync';

import { CODE, createHome, createSigner, makeRequest, writeFile } from './helpers';

const SESSION_ID = '0194e3a2-7b1c-4f6e-9d2a-5c8b1e4f7a90';
const j = (value: unknown) => JSON.stringify(value);

describe('history sync', () => {
  let home: ReturnType<typeof createHome>;
  let manager: IntegrationManager;
  let sync: HistorySync;
  let updates: IntegrationDataUpdate[];

  beforeEach(() => {
    home = createHome();
    writeFile(
      join(
        home.home,
        '.codex',
        'sessions',
        '2026',
        '09',
        '10',
        `rollout-2026-09-10T10-00-00-${SESSION_ID}.jsonl`,
      ),
      [
        j({
          timestamp: '2026-09-10T10:00:00Z',
          type: 'session_meta',
          payload: {
            id: SESSION_ID,
            timestamp: '2026-09-10T10:00:00Z',
            cwd: join(home.home, 'project'),
          },
        }),
        j({
          timestamp: '2026-09-10T10:00:03Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Hello Codex' }],
          },
        }),
        j({
          timestamp: '2026-09-10T10:00:08Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { total_token_usage: { total_tokens: 50 } },
            rate_limits: {
              primary: { used_percent: 5, window_minutes: 300, resets_at: 1789990846 },
            },
          },
        }),
        '',
      ].join('\n'),
    );
    writeFile(join(home.home, '.codex', 'auth.json'), '{"secret":true}');
    updates = [];
    manager = new IntegrationManager({ signer: createSigner(), ctx: home });
    sync = new HistorySync({ manager, ctx: home, emit: (update) => updates.push(update) });
  });

  afterEach(() => home.cleanup());

  async function grant(scopes: IntegrationScope[]) {
    const request = makeRequest('codex', scopes);
    await manager.receiveRequest(request);
    expect((await manager.approve(request.requestId, CODE, { interactive: true })).ok).toBe(true);
  }

  const summaries = () =>
    updates.flatMap((update) => (update.kind === 'history_summaries' ? update.conversations : []));

  it('syncs nothing without a grant', async () => {
    await expect(sync.syncAll('codex')).rejects.toThrow(/Access refused/);
    expect(summaries()).toHaveLength(0);
  });

  it('lists conversations with ~ workspace paths and no usage when only history is granted', async () => {
    await grant(['history.read']);
    await sync.syncAll('codex');
    const [summary] = summaries();
    expect(summary).toMatchObject({
      externalId: SESSION_ID,
      title: 'Hello Codex',
      workspace: '~/project',
    });
    expect(summary!.tokens).toBeUndefined();
    expect(updates.some((update) => update.kind === 'usage_snapshot')).toBe(false);
  });

  it('adds token totals and plan limits when usage is granted too', async () => {
    await grant(['history.read', 'usage.read']);
    await sync.syncAll('codex');
    expect(summaries()[0]!.tokens?.total).toBe(50);
    const usage = updates.find((update) => update.kind === 'usage_snapshot');
    expect(
      usage && usage.kind === 'usage_snapshot' && usage.snapshot.windows?.[0]?.usedPercent,
    ).toBe(5);
  });

  it('sends content only for a conversation id it listed itself', async () => {
    await grant(['history.read']);
    await sync.syncAll('codex');
    await sync.syncContent('codex', SESSION_ID);
    const content = updates.filter((update) => update.kind === 'history_content');
    expect(content.length).toBeGreaterThan(0);
  });

  it('cannot be steered to another file by a crafted conversation id', async () => {
    await grant(['history.read']);
    for (const id of [
      '../../auth.json',
      '..\\..\\auth.json',
      join(home.home, '.codex', 'auth.json'),
      'auth',
    ]) {
      await expect(sync.syncContent('codex', id)).rejects.toThrow(/Invalid conversation id/);
    }
    // A well-formed id it never saw is refused too — it is never turned into a path.
    await expect(sync.syncContent('codex', '11111111-2222-4333-8444-555555555555')).rejects.toThrow(
      /No readable transcript/,
    );
    expect(JSON.stringify(updates)).not.toContain('secret');
  });

  it('stops reading as soon as the grant is revoked', async () => {
    await grant(['history.read']);
    await sync.syncAll('codex');
    await manager.revoke('codex', 'web');
    sync.forget('codex');
    await expect(sync.syncAll('codex')).rejects.toThrow(/Access refused/);
    await expect(sync.syncContent('codex', SESSION_ID)).rejects.toThrow();
  });

  it('syncs Claude Code metadata, content, and exact token classes through the same path', async () => {
    writeFile(
      join(home.home, '.claude', 'projects', 'C--project', `${SESSION_ID}.jsonl`),
      [
        j({
          type: 'user',
          sessionId: SESSION_ID,
          timestamp: '2026-09-12T08:00:00Z',
          cwd: join(home.home, 'project'),
          message: { role: 'user', content: 'Hello Claude' },
        }),
        j({
          type: 'assistant',
          sessionId: SESSION_ID,
          timestamp: '2026-09-12T08:00:01Z',
          message: {
            id: 'msg_1',
            role: 'assistant',
            model: 'claude-sonnet-4-5',
            content: [{ type: 'text', text: 'Hello' }],
            usage: {
              input_tokens: 10,
              cache_read_input_tokens: 4,
              cache_creation_input_tokens: 3,
              output_tokens: 5,
            },
          },
        }),
        '',
      ].join('\n'),
    );
    const request = makeRequest('claude', ['history.read', 'usage.read']);
    await manager.receiveRequest(request);
    expect((await manager.approve(request.requestId, CODE, { interactive: true })).ok).toBe(true);

    await sync.syncAll('claude');
    const summary = summaries().find((item) => item.integration === 'claude');
    expect(summary).toMatchObject({
      externalId: SESSION_ID,
      title: 'Hello Claude',
      workspace: '~/project',
      tokens: { input: 10, cachedInput: 4, cacheWriteInput: 3, output: 5, total: 22 },
    });

    await sync.syncContent('claude', SESSION_ID);
    const content = updates.find(
      (update) => update.kind === 'history_content' && update.integration === 'claude',
    );
    expect(
      content && content.kind === 'history_content' && content.items.map((item) => item.kind),
    ).toEqual(['user', 'assistant']);
  });

  it('pauses production reads when the final website disconnects', async () => {
    const guarded = new HistorySync({
      manager,
      ctx: home,
      emit: (update) => updates.push(update),
      requireBrowserPresence: true,
    });
    await grant(['history.read']);
    await expect(guarded.syncAll('codex')).rejects.toThrow(/web client.*paused/i);
    guarded.setBrowserPresence(true);
    await expect(guarded.syncAll('codex')).resolves.toMatchObject({ conversations: 1 });
    guarded.setBrowserPresence(false);
    await expect(guarded.syncContent('codex', SESSION_ID)).rejects.toThrow(/web client.*paused/i);
  });
});
