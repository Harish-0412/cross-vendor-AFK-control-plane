import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EventEnvelope } from '@odysseus/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { AcpAdapter, chooseOutcome, describeAction } from '../src/acp-adapter';
import { ACP_PRESETS } from '../src/presets';

const fakeAgent = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));
const adapters: AcpAdapter[] = [];

function adapter(env: Record<string, string> = {}): AcpAdapter {
  const created = new AcpAdapter(ACP_PRESETS.claude, {
    env: { ...process.env, ...env },
    locate: () => ({ command: process.execPath, prefixArgs: [fakeAgent] }),
  });
  adapters.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((item) => item.shutdown()));
});

function project(): string {
  return mkdtempSync(join(tmpdir(), 'odysseus-acp-'));
}

/** Collect a session's events until one matches, or fail after a while. */
function watch(target: AcpAdapter, sessionId: string) {
  const events: EventEnvelope[] = [];
  target.streamEvents(sessionId, { onEvent: (event) => events.push(event) });
  const until = async (match: (event: EventEnvelope) => boolean): Promise<EventEnvelope> => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const found = events.find(match);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out; saw ${events.map((event) => event.eventType).join(', ')}`);
  };
  return { events, until };
}

const payload = (event: EventEnvelope) => event.payload as Record<string, unknown>;

describe('ACP adapter', () => {
  it('declares per-action approval, which headless Claude Code cannot offer', () => {
    expect(new AcpAdapter(ACP_PRESETS.claude).metadata()).toMatchObject({
      id: 'claude-acp',
      capabilities: { approvalInterception: 'supported' },
    });
  });

  it('says how to install the agent when it is missing', async () => {
    const missing = new AcpAdapter(ACP_PRESETS.codex, { locate: () => null });
    expect(await missing.installOrDetect()).toMatchObject({
      success: false,
      error: { code: 'ACP_AGENT_NOT_FOUND', message: expect.stringContaining('codex-acp') },
    });
  });

  it('runs a turn: handshake, streamed text in readable pieces, completion', async () => {
    const target = adapter();
    const id = await target.startSession({ projectRoot: project(), adapter: 'claude-acp' });
    const { events, until } = watch(target, id);
    await target.sendMessage(id, 'hello');
    const done = await until((event) => event.eventType === 'session.completed');

    expect(payload(done)).toMatchObject({ result: 'Hello', stopReason: 'end_turn' });
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(['session.thinking', 'session.message']),
    );
    // The two chunks arrive as one message, not two fragments.
    expect(events.filter((event) => event.eventType === 'session.message').map(payload)).toEqual([
      { role: 'assistant', content: 'Hello' },
    ]);
    expect(await target.checkpointSession(id)).toBe('fake-session-1');
    expect(target.metadata().version).toBe('9.9.9');
  });

  it('turns a permission request into an approval, and answers "allow once" when approved', async () => {
    const target = adapter();
    const id = await target.startSession({ projectRoot: project(), adapter: 'claude-acp' });
    const { until } = watch(target, id);
    await target.sendMessage(id, 'run tests');

    const asked = await until((event) => event.eventType === 'session.approval_required');
    expect(payload(asked)).toMatchObject({
      capability: 'process.exec',
      command: 'pnpm test',
      actionType: 'execute',
      description: 'Run pnpm test',
    });
    expect(await target.getState(id)).toBe('waiting_for_approval');

    await target.submitApprovalDecision(id, payload(asked)['approvalId'] as string, true);
    await until((event) => event.eventType === 'session.tool_result');
    const message = await until(
      (event) =>
        event.eventType === 'session.message' &&
        String(payload(event)['content']).startsWith('Tests'),
    );
    // Never "always": Odysseus keeps its own remembered rules.
    expect(payload(message)['content']).toBe('Tests passed (allow-once)');
  });

  it('accepts a decision made the instant the approval is announced', async () => {
    const target = adapter();
    const id = await target.startSession({ projectRoot: project(), adapter: 'claude-acp' });
    const { until } = watch(target, id);
    target.streamEvents(id, {
      onEvent: (event) => {
        if (event.eventType === 'session.approval_required')
          void target.submitApprovalDecision(id, payload(event)['approvalId'] as string, true);
      },
    });
    await target.sendMessage(id, 'run tests');
    const message = await until(
      (event) =>
        event.eventType === 'session.message' &&
        String(payload(event)['content']).startsWith('Tests'),
    );
    expect(payload(message)['content']).toBe('Tests passed (allow-once)');
  });

  it('answers "reject once" when denied', async () => {
    const target = adapter();
    const id = await target.startSession({ projectRoot: project(), adapter: 'claude-acp' });
    const { until } = watch(target, id);
    await target.sendMessage(id, 'run tests');
    const asked = await until((event) => event.eventType === 'session.approval_required');
    await target.submitApprovalDecision(id, payload(asked)['approvalId'] as string, false);
    const message = await until((event) => event.eventType === 'session.message');
    expect(payload(message)['content']).toBe('Skipped (reject-once)');
  });

  it('answers open permission requests "cancelled" when the session is cancelled', async () => {
    const target = adapter();
    const id = await target.startSession({ projectRoot: project(), adapter: 'claude-acp' });
    const { until } = watch(target, id);
    await target.sendMessage(id, 'run tests');
    await until((event) => event.eventType === 'session.approval_required');
    await target.abortSession(id, 'Stopped from the phone');
    await until((event) => event.eventType === 'session.cancelled');
    expect(await target.getState(id)).toBe('cancelled');
  });

  it('refuses to write a protected config file, and reports the attempt', async () => {
    const root = project();
    const target = adapter();
    const id = await target.startSession({ projectRoot: root, adapter: 'claude-acp' });
    const { until } = watch(target, id);
    await target.sendMessage(id, 'write config');
    const violation = await until((event) => event.eventType === 'policy.violation');
    expect(payload(violation)).toMatchObject({ reason: 'deny-floor', path: '.cursor/mcp.json' });
    const message = await until((event) => event.eventType === 'session.message');
    expect(payload(message)['content']).toMatch(
      /Refused: Odysseus policy does not allow agents to write/,
    );
    expect(existsSync(join(root, '.cursor', 'mcp.json'))).toBe(false);
  });

  it('reads and writes files inside the project for the agent', async () => {
    const root = project();
    const target = adapter();
    const id = await target.startSession({ projectRoot: root, adapter: 'claude-acp' });
    const { until } = watch(target, id);
    await target.sendMessage(id, 'write file');
    const changed = await until((event) => event.eventType === 'session.file_changed');
    expect(payload(changed)).toMatchObject({ path: 'src/new.ts' });
    const message = await until((event) => event.eventType === 'session.message');
    expect(payload(message)['content']).toBe('Read back: export const b = 2;');
    expect(readFileSync(join(root, 'src', 'new.ts'), 'utf8')).toContain('export const a = 1;');
  });

  it('keeps the agent inside the project', async () => {
    const target = adapter();
    const id = await target.startSession({ projectRoot: project(), adapter: 'claude-acp' });
    const { until } = watch(target, id);
    await target.sendMessage(id, 'read outside');
    const message = await until((event) => event.eventType === 'session.message');
    expect(payload(message)['content']).toMatch(
      /Refused: Odysseus keeps agents inside the project/,
    );
  });

  it('resumes the same agent session after a restart, without republishing its history', async () => {
    const target = adapter();
    const id = await target.startSession({
      projectRoot: project(),
      adapter: 'claude-acp',
      metadata: { resumeNativeSessionId: 'old-session-7' },
    });
    const { events, until } = watch(target, id);
    await target.sendMessage(id, 'continue');
    const message = await until((event) => event.eventType === 'session.message');
    expect(payload(message)['content']).toBe('Loaded old-session-7');
    expect(await target.checkpointSession(id)).toBe('old-session-7');
    expect(events.some((event) => String(payload(event)['content']).includes('old history'))).toBe(
      false,
    );
  });

  it('asks the person to sign in when the agent needs it', async () => {
    await expect(
      adapter({ FAKE_ACP_AUTH: 'required' }).startSession({
        projectRoot: project(),
        adapter: 'claude-acp',
      }),
    ).rejects.toThrow(/needs you to sign in first/);
  });

  it('refuses an agent speaking another ACP version', async () => {
    await expect(
      adapter({ FAKE_ACP_VERSION: '2' }).startSession({
        projectRoot: project(),
        adapter: 'claude-acp',
      }),
    ).rejects.toThrow(/speaks ACP version 2/);
  });

  it('reports a refusal as a failure', async () => {
    const target = adapter();
    const id = await target.startSession({ projectRoot: project(), adapter: 'claude-acp' });
    const { until } = watch(target, id);
    await target.sendMessage(id, 'refuse');
    const failed = await until((event) => event.eventType === 'session.failed');
    expect(payload(failed)).toMatchObject({
      stopReason: 'refusal',
      error: 'The agent refused to continue.',
    });
  });

  it('reports an agent that dies mid-turn as crashed', async () => {
    const target = adapter();
    const id = await target.startSession({ projectRoot: project(), adapter: 'claude-acp' });
    const { until } = watch(target, id);
    await target.sendMessage(id, 'crash');
    const crashed = await until((event) => event.eventType === 'session.crashed');
    expect(String(payload(crashed)['error'])).toMatch(/exited unexpectedly \(code 3\)/);
  });
});

describe('describing tool calls', () => {
  it('reads the command a shell wrapper runs', () => {
    expect(
      describeAction(
        { kind: 'execute', rawInput: { command: ['bash', '-lc', 'git push'] } },
        [],
        '/p',
      ),
    ).toEqual({
      capability: 'process.exec',
      command: 'git push',
    });
  });

  it('names the file an edit touches', () => {
    expect(
      describeAction(
        { kind: 'edit', locations: [{ path: '/p/.github/workflows/ci.yml' }] },
        [],
        '/p',
      ),
    ).toEqual({ capability: 'filesystem.write', resource: '/p/.github/workflows/ci.yml' });
    expect(
      describeAction(
        { kind: 'edit' },
        [{ type: 'diff', path: 'src/a.ts', oldText: 'a', newText: 'b' }],
        '/p',
      ),
    ).toEqual({ capability: 'filesystem.write', resource: '/p/src/a.ts' });
  });

  it('leaves an unreadable action for a person', () => {
    expect(describeAction({ kind: 'other', title: 'Do a thing' }, [], '/p')).toEqual({
      capability: 'process.exec',
    });
  });
});

describe('choosing the answer', () => {
  const options = [
    { optionId: 'a', kind: 'allow_always' },
    { optionId: 'b', kind: 'allow_once' },
    { optionId: 'c', kind: 'reject_once' },
  ];

  it('never picks "always"', () => {
    expect(chooseOutcome(options, true)).toEqual({
      outcome: { outcome: 'selected', optionId: 'b' },
    });
    expect(chooseOutcome([{ optionId: 'a', kind: 'allow_always' }], true)).toEqual({
      outcome: { outcome: 'cancelled' },
    });
  });

  it('rejects once, or cancels when rejecting is not offered', () => {
    expect(chooseOutcome(options, false)).toEqual({
      outcome: { outcome: 'selected', optionId: 'c' },
    });
    expect(chooseOutcome([{ optionId: 'b', kind: 'allow_once' }], false)).toEqual({
      outcome: { outcome: 'cancelled' },
    });
  });
});
