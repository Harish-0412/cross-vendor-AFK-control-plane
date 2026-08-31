import { describe, test, expect } from 'vitest';

import { buildScenario, DEFAULT_SCENARIO_CONFIG, listScenarios } from '../src/scenarios';
import type { ScenarioConfig } from '../src/scenarios';

describe('Scenario builder', () => {
  const baseConfig: ScenarioConfig = {
    scenario: 'simple',
    baseDelayMs: 0,
    jitterMs: 0,
  };

  test('simple scenario produces expected event types', () => {
    const events = buildScenario({
      ...baseConfig,
      messageCount: 1,
      toolCallCount: 1,
      fileChangeCount: 1,
    });
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('session.started');
    expect(types[types.length - 1]).toBe('session.completed');
    expect(types).toContain('session.thinking');
    expect(types).toContain('session.message');
    expect(types).toContain('session.tool_call');
    expect(types).toContain('session.tool_result');
    expect(types).toContain('session.file_changed');
  });

  test('with_approval scenario includes approval events', () => {
    const events = buildScenario({ ...baseConfig, scenario: 'with_approval', approvalCount: 2 });
    const types = events.map((e) => e.type);
    expect(types).toContain('session.approval_required');
    expect(types).toContain('session.approval_granted');
    expect(types.filter((t) => t === 'session.approval_required').length).toBe(2);
  });

  test('failed scenario ends with session.failed', () => {
    const events = buildScenario({ ...baseConfig, scenario: 'failed' });
    expect(events[events.length - 1]!.type).toBe('session.failed');
    expect(events.map((e) => e.type)).toContain('session.tool_error');
  });

  test('cancelled scenario ends with session.cancelled', () => {
    const events = buildScenario({ ...baseConfig, scenario: 'cancelled' });
    expect(events[events.length - 1]!.type).toBe('session.cancelled');
  });

  test('long_task scenario contains many events', () => {
    const events = buildScenario({
      ...baseConfig,
      scenario: 'long_task',
      messageCount: 10,
      toolCallCount: 5,
      fileChangeCount: 3,
    });
    expect(events.length).toBeGreaterThan(20);
    const outputCount = events.filter((e) => e.type === 'session.output').length;
    expect(outputCount).toBe(10);
  });

  test('multi_turn scenario includes user message', () => {
    const events = buildScenario({ ...baseConfig, scenario: 'multi_turn' });
    const messages = events.filter(
      (e) => e.type === 'session.message',
    );
    expect(messages.length).toBeGreaterThanOrEqual(3);
  });

  test('crash_midway truncates events', () => {
    const full = buildScenario({ ...baseConfig, scenario: 'simple', messageCount: 5, toolCallCount: 3 });
    const crashed = buildScenario({
      ...baseConfig,
      scenario: 'crash_midway',
      crashAtEvent: 4,
      messageCount: 5,
      toolCallCount: 3,
    });
    expect(crashed.length).toBe(4);
    expect(full.length).toBeGreaterThan(crashed.length);
  });

  test('thinking_only scenario has only thinking + lifecycle events', () => {
    const events = buildScenario({ ...baseConfig, scenario: 'thinking_only' });
    const types = new Set(events.map((e) => e.type));
    expect(types.has('session.tool_call')).toBe(false);
    expect(types.has('session.file_changed')).toBe(false);
    expect(types.has('session.thinking')).toBe(true);
  });

  test('file_edits scenario produces file_changed events only', () => {
    const events = buildScenario({
      ...baseConfig,
      scenario: 'file_edits',
      fileChangeCount: 6,
    });
    const counts = events.reduce<Record<string, number>>((acc, e) => {
      acc[e.type] = (acc[e.type] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts['session.file_changed']).toBe(6);
    expect(counts['session.tool_call']).toBeUndefined();
  });

  test('approvals_chain has multiple approvals', () => {
    const events = buildScenario({
      ...baseConfig,
      scenario: 'approvals_chain',
    });
    const req = events.filter((e) => e.type === 'session.approval_required').length;
    const grant = events.filter((e) => e.type === 'session.approval_granted').length;
    expect(req).toBeGreaterThanOrEqual(4);
    expect(grant).toBeGreaterThanOrEqual(4);
  });

  test('listScenarios returns descriptors with durations', () => {
    const list = listScenarios();
    expect(list.length).toBe(10);
    for (const s of list) {
      expect(s.estimatedDurationMs).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
    }
  });

  test('DEFAULT_SCENARIO_CONFIG has sensible defaults', () => {
    expect(DEFAULT_SCENARIO_CONFIG.baseDelayMs).toBeGreaterThan(0);
    expect(DEFAULT_SCENARIO_CONFIG.messageCount).toBeGreaterThan(0);
    expect(DEFAULT_SCENARIO_CONFIG.toolCallCount).toBeGreaterThan(0);
  });
});
