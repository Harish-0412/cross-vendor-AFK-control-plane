import { PassThrough, Writable } from 'node:stream';

import type { EventEnvelope, Sandbox, SandboxConfig, SandboxManager } from '@odysseus/protocol';
import { describe, expect, it } from 'vitest';

import { AntigravityAdapter, buildAntigravityArgs } from '../src/antigravity-adapter';

describe('Antigravity live adapter', () => {
  it('builds the verified, sandboxed bidirectional CLI invocation without a permission bypass', () => {
    const args = buildAntigravityArgs({
      adapter: 'antigravity',
      projectRoot: '.',
      prompt: 'ignored',
      model: 'gemini-test',
      metadata: { effort: 'high' },
      timeout: 61_000,
    });
    expect(args).toEqual([
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--mode',
      'accept-edits',
      '--sandbox',
      '--disable-slash-commands',
      '--model',
      'gemini-test',
      '--effort',
      'high',
      '--print-timeout',
      '61s',
    ]);
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(
      buildAntigravityArgs({
        adapter: 'antigravity',
        projectRoot: '.',
        sandbox: { profile: 'strict' },
      }),
    ).toContain('plan');
  });

  it('keeps one process alive, queues phone prompts, and returns to idle after every turn', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const writes: string[] = [];
    let createdConfig: SandboxConfig | undefined;
    let resolveExit!: (value: { exitCode: number | null; signal: string | null }) => void;
    const exited = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
      resolveExit = resolve;
    });
    const stdin = new Writable({
      write(chunk, _encoding, done) {
        writes.push(chunk.toString());
        done();
      },
    });
    const sandbox = {
      id: 'sbx_test',
      state: 'running',
      pid: 42,
      projectRoot: 'C:\\project',
      createdAt: new Date(),
      stdin,
      stdout,
      stderr,
      stop: async () => {
        resolveExit({ exitCode: 0, signal: null });
        return 0;
      },
      kill: async () => resolveExit({ exitCode: null, signal: 'SIGKILL' }),
      waitForExit: () => exited,
    } as unknown as Sandbox;
    const manager = {
      create: async (config: SandboxConfig) => {
        createdConfig = config;
        return sandbox;
      },
      destroy: async () => resolveExit({ exitCode: 0, signal: null }),
    } as unknown as SandboxManager;
    const adapter = new AntigravityAdapter(manager, 'agy-test');
    const seen: EventEnvelope[] = [];

    const id = await adapter.startSession({
      adapter: 'antigravity',
      projectRoot: 'C:\\project',
      prompt: 'first turn',
    });
    adapter.streamEvents(id, { onEvent: (event) => seen.push(event) });
    expect(createdConfig?.agentBinary).toBe('agy-test');
    expect(createdConfig?.agentArgs).toEqual(
      buildAntigravityArgs({
        adapter: 'antigravity',
        projectRoot: 'C:\\project',
        prompt: 'first turn',
      }),
    );
    expect(writes).toHaveLength(0);

    stdout.write(
      '{"event":"init","conversation_id":"conversation-live","init":{"permission_mode":"request-review"}}\n',
    );
    await tick();
    expect(JSON.parse(writes[0]!)).toEqual({
      event: 'user',
      message: { content: 'first turn' },
    });
    await adapter.sendMessage(id, 'second turn');
    expect(writes).toHaveLength(1);

    stdout.write(
      '{"event":"result","result":{"conversation_id":"conversation-live","status":"SUCCESS","response":"first done","num_turns":1}}\n',
    );
    await tick();
    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[1]!)).toEqual({
      event: 'user',
      message: { content: 'second turn' },
    });

    stdout.write(
      '{"event":"result","result":{"conversation_id":"conversation-live","status":"SUCCESS","response":"second done","num_turns":2}}\n',
    );
    await tick();
    expect(await adapter.getState(id)).toBe('running');
    expect(await adapter.checkpointSession(id)).toBe('conversation-live');
    expect(
      seen.filter(
        (event) =>
          event.eventType === 'session.message' &&
          (event.payload as { role?: string }).role === 'assistant',
      ),
    ).toHaveLength(2);
    expect(seen.at(-1)?.payload).toMatchObject({ state: 'running', phase: 'idle' });

    await adapter.abortSession(id, 'test complete');
    expect(await adapter.getState(id)).toBe('cancelled');
  });
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
