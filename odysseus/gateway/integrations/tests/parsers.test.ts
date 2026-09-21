import { describe, expect, it } from 'vitest';

import { antigravityItems, summariseAntigravity } from '../src/sync/antigravity';
import { codexItems, codexUsage, summariseCodex } from '../src/sync/codex';

/** Fixture lines shaped exactly like records observed in real files. */
const ID = '0194e3a2-7b1c-4f6e-9d2a-5c8b1e4f7a90';
const j = (value: unknown) => JSON.stringify(value);
const KEY = 'sk-proj-AbCdEf1234567890AbCdEf1234567890AbCdEf12';

const codexSession = [
  j({ timestamp: '2026-09-10T10:00:00.000Z', type: 'session_meta', payload: { id: ID, timestamp: '2026-09-10T10:00:00.000Z', cwd: 'C:\\Users\\dev\\project' } }),
  j({ timestamp: '2026-09-10T10:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5-codex' } }),
  j({ timestamp: '2026-09-10T10:00:01.500Z', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Internal Codex instructions' }] } }),
  j({ timestamp: '2026-09-10T10:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>C:\\x</cwd>\n</environment_context>' }] } }),
  j({ timestamp: '2026-09-10T10:00:03.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Fix the login bug. My key is ${KEY}` }] } }),
  j({ timestamp: '2026-09-10T10:00:04.000Z', type: 'response_item', payload: { type: 'reasoning', summary: [], encrypted_content: 'gAAAAABencrypted' } }),
  j({ timestamp: '2026-09-10T10:00:05.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'shell', input: 'git status' } }),
  j({ timestamp: '2026-09-10T10:00:06.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', output: [{ type: 'output_text', text: 'nothing to commit' }] } }),
  '{"this is": not valid json',
  j({ timestamp: '2026-09-10T10:00:07.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed.' }] } }),
  j({
    timestamp: '2026-09-10T10:00:08.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 200, reasoning_output_tokens: 50, total_tokens: 1200 } },
      rate_limits: {
        primary: { used_percent: 14, window_minutes: 300, resets_at: 1789990846 },
        secondary: { used_percent: 19, window_minutes: 10080, resets_at: 1790489816 },
        credits: { has_credits: false, unlimited: false, balance: '0' },
        plan_type: 'plus',
      },
    },
  }),
];

describe('Codex parsing', () => {
  it('titles the conversation with the first thing the user typed, redacted', () => {
    const summary = summariseCodex(codexSession, { includeTokens: false })!;
    expect(summary.externalId).toBe(ID);
    // Injected <environment_context> is not the user's words and is skipped.
    expect(summary.title.startsWith('Fix the login bug')).toBe(true);
    expect(summary.title).not.toContain(KEY);
    expect(summary.model).toBe('gpt-5-codex');
    expect(summary.messageCount).toBe(2);
    expect(summary.toolCallCount).toBe(1);
  });

  it('reveals token usage only when usage.read is granted', () => {
    expect(summariseCodex(codexSession, { includeTokens: false })!.tokens).toBeUndefined();
    expect(summariseCodex(codexSession, { includeTokens: true })!.tokens).toEqual({
      input: 1000,
      cachedInput: 400,
      output: 200,
      reasoning: 50,
      total: 1200,
    });
  });

  it('builds content without Codex instructions, injected context or encrypted reasoning', () => {
    const { items } = codexItems(codexSession);
    expect(items.map((item) => item.kind)).toEqual(['user', 'tool_call', 'tool_result', 'assistant']);
    const all = JSON.stringify(items);
    expect(all).not.toContain('Internal Codex instructions');
    expect(all).not.toContain('environment_context');
    expect(all).not.toContain('encrypted');
    expect(all).not.toContain(KEY);
    expect(items[1]).toMatchObject({ toolName: 'shell', text: 'git status' });
  });

  it('reads plan limits exactly as recorded', () => {
    const usage = codexUsage(codexSession)!;
    expect(usage).toMatchObject({ provider: 'codex', planType: 'plus', observedAt: '2026-09-10T10:00:08.000Z' });
    expect(usage.windows).toEqual([
      { name: 'primary', usedPercent: 14, windowMinutes: 300, resetsAt: new Date(1789990846 * 1000).toISOString() },
      { name: 'secondary', usedPercent: 19, windowMinutes: 10080, resetsAt: new Date(1790489816 * 1000).toISOString() },
    ]);
    expect(usage.credits).toEqual({ hasCredits: false, unlimited: false, balance: '0' });
  });

  it('reports no usage at all when no limits were recorded, rather than a default', () => {
    expect(codexUsage(codexSession.slice(0, 5))).toBeNull();
  });

  it('refuses a session with no usable id', () => {
    const noId = codexSession.slice(1);
    expect(summariseCodex(noId, { includeTokens: false })).toBeNull();
    expect(summariseCodex(noId, { includeTokens: false, fallbackId: ID })?.externalId).toBe(ID);
  });
});

const antigravityTranscript = [
  j({ step_index: 0, type: 'USER_INPUT', created_at: '2026-09-01T09:00:00Z', content: `Build the dashboard ${KEY}`, source: 'USER_EXPLICIT' }),
  j({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-09-01T09:00:05Z', thinking: 'Plan it', tool_calls: [{ name: 'view_file', args: { path: 'a.ts' } }] }),
  j({ step_index: 2, type: 'GENERIC', created_at: '2026-09-01T09:00:06Z', content: 'file contents', truncated_fields: ['content'] }),
  j({ step_index: 3, type: 'ERROR_MESSAGE', created_at: '2026-09-01T09:00:07Z', error: 'tool failed' }),
  j({ step_index: 4, type: 'CHECKPOINT', created_at: '2026-09-01T09:00:08Z', content: 'checkpoint saved' }),
  j({ step_index: 5, type: 'PLANNER_RESPONSE', created_at: '2026-09-01T09:00:09Z', content: 'Done' }),
];

describe('Antigravity parsing', () => {
  it('summarises with a redacted title from the first user input', () => {
    const summary = summariseAntigravity(antigravityTranscript, ID)!;
    expect(summary.title.startsWith('Build the dashboard')).toBe(true);
    expect(summary.title).not.toContain(KEY);
    expect(summary.messageCount).toBe(2);
    expect(summary.toolCallCount).toBe(1);
  });

  it('keeps tool calls, tool results, errors and checkpoints — nothing collapses to "output"', () => {
    const { items } = antigravityItems(antigravityTranscript);
    expect(items.map((item) => item.kind)).toEqual([
      'user',
      'thinking',
      'tool_call',
      'tool_result',
      'error',
      'system',
      'assistant',
    ]);
  });

  it("marks content the transcript itself shortened", () => {
    const { items } = antigravityItems(antigravityTranscript);
    expect(items.find((item) => item.kind === 'tool_result')?.truncated).toBe(true);
    expect(items.find((item) => item.kind === 'user')?.truncated).toBeUndefined();
  });
});
