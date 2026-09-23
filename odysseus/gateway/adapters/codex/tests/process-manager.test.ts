import { describe, expect, it } from 'vitest';
import { CodexProcessManager } from '../src/process-manager';
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
    expect(parser.parseLine('{"type":"turn.completed","usage":{"input_tokens":3}}').terminal).toBe(
      true,
    );
  });
});
