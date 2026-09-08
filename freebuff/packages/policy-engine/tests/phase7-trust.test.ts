import { describe, expect, it } from 'vitest';
import type { PolicyEvaluationContext, PolicyVersion } from '@freebuff/protocol';
import { evaluate } from '../src/evaluate';

const context: PolicyEvaluationContext = {
  capability: 'git.push',
  riskClass: 'high',
  trustProfile: 'default',
  deviceStatus: 'trusted',
  userId: 'usr_phase7',
};

const policy: PolicyVersion = {
  id: 'p_phase7',
  version: 'p_7',
  description: 'Phase 7 profile rules',
  rules: [{
    id: 'trusted-afk-push',
    description: 'Allow pushes for this deliberate AFK profile',
    match: { capability: 'git.push', riskClass: 'high', trustProfile: 'trusted-afk' },
    effect: 'allow',
    priority: 100,
  }],
  createdAt: new Date('2026-09-08T00:00:00Z'),
  createdBy: 'usr_phase7',
  isActive: true,
};

describe('Phase 7 trust profiles', () => {
  it('lets an explicitly scoped trusted-afk rule allow what default gates', () => {
    expect(evaluate(context, policy).decision).toBe('require_approval');
    expect(evaluate({ ...context, trustProfile: 'trusted-afk' }, policy).decision).toBe('allow');
  });

  it('makes locked observation-only even for LOW filesystem reads', () => {
    const read = { ...context, capability: 'filesystem.read' as const, riskClass: 'low' as const };
    for (const trustProfile of ['default', 'supervised', 'trusted-afk', 'read-only'] as const) {
      expect(evaluate({ ...read, trustProfile }, null).decision).toBe('allow');
    }
    expect(evaluate({ ...read, trustProfile: 'locked' }, null).decision).toBe('deny');
  });
});
