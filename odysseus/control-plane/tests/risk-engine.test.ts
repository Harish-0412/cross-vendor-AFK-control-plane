import { describe, expect, it } from 'vitest';
import type { TaskKind } from '@odysseus/protocol';

import { RiskEngine } from '../src/orchestration/risk-engine';

const engine = new RiskEngine();
const assess = (prompt: string, taskKind: TaskKind = 'implementation') =>
  engine.assess({ taskKind, prompt, protectedBranches: ['main'] });

describe('task risk engine', () => {
  it.each([
    'Add push notification support to the settings page',
    'Fix the commit message parser so it handles emoji',
    'Write release notes for 0.2',
    'Refactor the deployment docs page into smaller components',
    'Rename the secretary field to assistant',
  ])('does not gate ordinary work that merely mentions a word: %s', (prompt) => {
    expect(assess(prompt).requiresApproval).toBe(false);
  });

  it.each([
    ['Deploy the API to production', 'critical'],
    ['Publish the package to npm', 'critical'],
    ['Force-push the rebased branch', 'critical'],
    ['Push the changes to main', 'critical'],
    ['Push the changes to the feature branch', 'high'],
    ['Drop the users table and recreate it', 'high'],
    ['Wipe the staging database', 'high'],
  ] as const)('gates work that asks for something risky: %s → %s', (prompt, level) => {
    const risk = assess(prompt);
    expect(risk.level).toBe(level);
    expect(risk.requiresApproval).toBe(true);
  });

  it('scores a command quoted in the prompt as the action it is', () => {
    const risk = assess('Clean up with `git reset --hard origin/main` and continue', 'general');
    expect(risk.requiresApproval).toBe(true);
    expect(risk.factors.map((factor) => factor.name)).toContain('quoted-command');
  });

  it('lets a read-only planner through where a builder with the same goal is scored higher', () => {
    const goal = 'Add a --dry-run flag to the importer';
    expect(assess(goal, 'planning').score).toBeLessThan(assess(goal, 'implementation').score);
    expect(assess(goal, 'planning').level).toBe('low');
  });

  it('explains every factor', () => {
    const risk = assess('Push the changes to main');
    expect(risk.factors.map((factor) => factor.name)).toEqual(
      expect.arrayContaining(['role:implementation', 'push', 'protected-branch']),
    );
    expect(risk.factors.every((factor) => factor.detail)).toBe(true);
  });
});
