import { describe, expect, it } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { CodexAdapter } from '../src/codex-adapter';
import { CodexProcessManager } from '../src/process-manager';
import type { CodexProcessController } from '../src/process-manager';
import { CodexStreamParser } from '../src/stream-parser';

describe('Codex adapter protocol', () => {
  it('uses JSON, a workspace sandbox, and resume without a shell bypass', () => {
    const manager = new CodexProcessManager('codex');
    expect(manager.buildArgs({ prompt: 'fix; echo unsafe' })).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      'fix; echo unsafe',
    ]);
    expect(manager.buildArgs({ prompt: 'continue', threadId: 'thread-1' })).toEqual([
      'exec',
      'resume',
      'thread-1',
      '--json',
      'continue',
    ]);
  });
  it('captures the thread and maps output/usage', () => {
    const parser = new CodexStreamParser('sess_test');
    expect(parser.parseLine('{"type":"thread.started","thread_id":"abc"}').threadId).toBe('abc');
    expect(
      parser.parseLine('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}')
        .envelopes[0]?.eventType,
    ).toBe('session.message');
    const completed = parser.parseLine('{"type":"turn.completed","usage":{"input_tokens":3}}');
    expect(completed.terminal).toBe(true);
    expect(completed.envelopes[0]?.eventType).toBe('session.status_changed');
    expect(completed.envelopes[0]?.payload).toMatchObject({ state: 'running', phase: 'idle' });
  });

  it('starts a thread and steers a second turn through resume while keeping the session active', async () => {
    const calls: Array<{ prompt: string; threadId?: string }> = [];
    const controller: CodexProcessController = {
      detect: async () => ({ path: 'codex', version: '0.149.1' }),
      validate: async () => ({ valid: true, version: '0.149.1', errors: [], warnings: [] }),
      run: (options) => {
        calls.push({
          prompt: options.prompt,
          ...(options.threadId ? { threadId: options.threadId } : {}),
        });
        return { child: {} as ChildProcessWithoutNullStreams, exited: Promise.resolve(0) };
      },
      watchStdout: (_child, onLine, onClose) => {
        queueMicrotask(() => {
          onLine('{"type":"thread.started","thread_id":"thread-live"}');
          onLine('{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}');
          onLine('{"type":"turn.completed","usage":{"input_tokens":1}}');
          onClose();
        });
      },
      watchStderr: () => undefined,
      stop: async () => undefined,
    };
    const adapter = new CodexAdapter(controller);
    const id = await adapter.startSession({ adapter: 'codex', projectRoot: '.', prompt: 'first' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await adapter.getState(id)).toBe('running');
    await adapter.sendMessage(id, 'second');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([{ prompt: 'first' }, { prompt: 'second', threadId: 'thread-live' }]);
    expect(await adapter.getState(id)).toBe('running');
  });
});
