import { describe, expect, it } from 'vitest';
import type { PolicyEvaluationContext, PolicyVersion } from '@freebuff/protocol';
import { evaluate } from '../src/evaluate';

const policy: PolicyVersion = {
  id: 'phase9', version: 'phase9', description: 'phase9', rules: [], createdAt: new Date(), createdBy: 'test', isActive: true,
};
const base: PolicyEvaluationContext = {
  capability: 'git.branch_create', riskClass: 'low', trustProfile: 'default', deviceStatus: 'trusted', userId: 'test',
};

describe('Phase 9 Git risk defaults and deny floor', () => {
  it.each([
    ['git.branch_create', 'low', 'allow'],
    ['git.branch_create', 'medium', 'allow'],
    ['git.commit', 'medium', 'allow'],
    ['git.push', 'high', 'require_approval'],
  ] as const)('%s at %s resolves to %s', (capability, riskClass, expected) => {
    expect(evaluate({ ...base, capability, riskClass }, policy).decision).toBe(expected);
  });

  it.each(['main', 'master'])('cannot allow a force push to %s even with an explicit allow rule', (branch) => {
    const permissive = { ...policy, rules: [{ id: 'allow', description: 'allow', match: { capability: 'git.push' as const }, effect: 'allow' as const, priority: 999 }] };
    expect(evaluate({ ...base, capability: 'git.push', riskClass: 'high', resource: branch, force: true }, permissive).decision).toBe('deny');
  });

  it('requires an ordinary push under supervised but honors a trusted-afk-scoped allow rule', () => {
    const scoped = { ...policy, rules: [{ id: 'afk', description: 'AFK push', match: { capability: 'git.push' as const, trustProfile: 'trusted-afk' as const }, effect: 'allow' as const, priority: 10 }] };
    expect(evaluate({ ...base, capability: 'git.push', riskClass: 'high', trustProfile: 'supervised' }, scoped).decision).toBe('require_approval');
    expect(evaluate({ ...base, capability: 'git.push', riskClass: 'high', trustProfile: 'trusted-afk' }, scoped).decision).toBe('allow');
  });
});
