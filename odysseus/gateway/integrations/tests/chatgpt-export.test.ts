import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatGptExportStore } from '../src/chatgpt-export';
import { IntegrationManager } from '../src/integration-manager';
import { CODE, createHome, createSigner, makeRequest } from './helpers';

describe('ChatGPT export import', () => {
  const homes: ReturnType<typeof createHome>[] = [];
  afterEach(() => homes.splice(0).forEach((home) => home.cleanup()));

  it('follows the current message branch, redacts locally, and keeps content on the workstation', async () => {
    const ctx = createHome();
    homes.push(ctx);
    const manager = new IntegrationManager({ signer: createSigner(), ctx });
    const request = makeRequest('chatgpt-export', ['history.read']);
    await manager.receiveRequest(request);
    expect((await manager.approve(request.requestId, CODE, { interactive: true })).ok).toBe(true);
    const id = '11111111-1111-4111-8111-111111111111';
    const exportData = [
      {
        id,
        title: 'API work',
        create_time: 1_700_000_000,
        update_time: 1_700_000_100,
        current_node: 'a2',
        mapping: {
          root: { id: 'root', parent: null, children: ['u1'], message: null },
          u1: {
            id: 'u1',
            parent: 'root',
            children: ['a1', 'a2'],
            message: {
              author: { role: 'user' },
              content: { parts: ['use sk-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuv'] },
              create_time: 1_700_000_001,
            },
          },
          a1: {
            id: 'a1',
            parent: 'u1',
            children: [],
            message: { author: { role: 'assistant' }, content: { parts: ['old branch'] } },
          },
          a2: {
            id: 'a2',
            parent: 'u1',
            children: [],
            message: {
              author: { role: 'assistant' },
              content: { parts: ['current answer'] },
              create_time: 1_700_000_002,
            },
          },
        },
      },
    ];
    const archive = join(ctx.home, 'export.zip');
    writeFileSync(
      archive,
      zipSync({ 'export/conversations.json': strToU8(JSON.stringify(exportData)) }),
    );
    const store = new ChatGptExportStore(ctx);
    expect(await store.importArchive(archive, manager)).toEqual({ imported: 1, skipped: 0 });
    expect((await store.summaries())[0]?.title).toBe('API work');
    const content = await store.content(id);
    expect(content.map((item) => item.text).join(' ')).toContain('current answer');
    expect(content.map((item) => item.text).join(' ')).not.toContain('old branch');
    expect(content.map((item) => item.text).join(' ')).not.toContain('sk-ABC');
  });
});
