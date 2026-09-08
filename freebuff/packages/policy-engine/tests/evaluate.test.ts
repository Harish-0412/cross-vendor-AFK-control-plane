import { describe, it, expect } from 'vitest';
import { evaluate } from '../src/evaluate';
import { DENY_OVERRIDE_FLOOR } from '../src/deny-floor';
import { riskClassDefaults } from '../src/risk-defaults';
import type { PolicyVersion, PolicyEvaluationContext, Capability } from '@freebuff/protocol';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeContext(overrides: Partial<PolicyEvaluationContext> = {}): PolicyEvaluationContext {
  return {
    capability: 'filesystem.read',
    riskClass: 'low',
    trustProfile: 'default',
    deviceStatus: 'trusted',
    userId: 'usr_test',
    ...overrides,
  };
}

function makePolicyVersion(overrides: Partial<PolicyVersion> = {}): PolicyVersion {
  return {
    id: 'p_test',
    version: 'p_1',
    description: 'Test policy version',
    rules: [],
    createdAt: new Date('2026-09-01T00:00:00Z'),
    createdBy: 'usr_admin',
    isActive: true,
    ...overrides,
  };
}

// ── §9 Test Case 1: Allowed action ───────────────────────────────────────

describe('Policy Engine §9.1 — Allowed action', () => {
  it('allows LOW-risk capability with no matching rule', () => {
    const ctx = makeContext({
      capability: 'filesystem.read',
      riskClass: 'low',
    });
    const result = evaluate(ctx, makePolicyVersion());
    expect(result.decision).toBe('allow');
    expect(result.policyVersion).toBe('p_1');
  });

  it('allows MEDIUM-risk under default profile with no matching rule', () => {
    const ctx = makeContext({
      capability: 'network.access',
      riskClass: 'medium',
    });
    const result = evaluate(ctx, makePolicyVersion());
    expect(result.decision).toBe('allow');
  });

  it('allows LOW-risk under read-only profile', () => {
    const ctx = makeContext({
      capability: 'filesystem.read',
      riskClass: 'low',
      trustProfile: 'read-only',
    });
    const result = evaluate(ctx, makePolicyVersion());
    expect(result.decision).toBe('allow');
  });
});

describe('Phase 7 trust-profile behavior', () => {
  it('allows a HIGH-risk action only for the explicitly scoped trusted-afk rule', () => {
    const policy = makePolicyVersion({
      rules: [{
        id: 'trusted-afk-push',
        description: 'Allow pushes while deliberately AFK',
        match: { capability: 'git.push', riskClass: 'high', trustProfile: 'trusted-afk' },
        effect: 'allow',
        priority: 100,
      }],
    });

    expect(evaluate(makeContext({ capability: 'git.push', riskClass: 'high' }), policy).decision)
      .toBe('require_approval');
    expect(evaluate(makeContext({
      capability: 'git.push',
      riskClass: 'high',
      trustProfile: 'trusted-afk',
    }), policy).decision).toBe('allow');
  });

  it('denies LOW-risk filesystem reads only under locked', () => {
    const decisions = (['default', 'supervised', 'trusted-afk', 'read-only'] as const).map(
      (trustProfile) => evaluate(makeContext({ trustProfile }), makePolicyVersion()).decision,
    );
    expect(decisions).toEqual(['allow', 'allow', 'allow', 'allow']);
    expect(evaluate(makeContext({ trustProfile: 'locked' }), makePolicyVersion()).decision)
      .toBe('deny');
  });
});

// ── §9 Test Case 2: Denied action (deny floor) ───────────────────────────

describe('Policy Engine §9.2 — Denied action (deny floor)', () => {
  it('denies deployment.execute on production/** via deny floor', () => {
    const ctx = makeContext({
      capability: 'deployment.execute',
      riskClass: 'critical',
      resource: 'production/api-service',
    });
    const result = evaluate(ctx, makePolicyVersion());
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('deny-override floor');
  });

  it('denies filesystem.delete on **/.git/** via deny floor', () => {
    const ctx = makeContext({
      capability: 'filesystem.delete',
      riskClass: 'high',
      resource: 'src/.git/objects/pack',
    });
    const result = evaluate(ctx, makePolicyVersion());
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('deny-override floor');
  });

  it('denies secret.read on **/.env* via deny floor', () => {
    const ctx = makeContext({
      capability: 'secret.read',
      riskClass: 'critical',
      resource: '.env.production',
    });
    const result = evaluate(ctx, makePolicyVersion());
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('deny-override floor');
  });

  it('deny floor wins over a permissive rule with higher priority', () => {
    const ctx = makeContext({
      capability: 'deployment.execute',
      riskClass: 'critical',
      resource: 'production/api-service',
    });
    const pv = makePolicyVersion({
      rules: [
        {
          id: 'allow-all-deployments',
          description: 'Allow all deployments',
          match: { capability: 'deployment.execute' },
          effect: 'allow',
          priority: 9999, // higher than floor would be if floor were a rule
        },
      ],
    });
    const result = evaluate(ctx, pv);
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('deny-override floor');
  });
});

// ── §9 Test Case 3: Approval-required action ─────────────────────────────

describe('Policy Engine §9.3 — Approval-required action', () => {
  it('requires approval for HIGH-risk capability with no explicit rule', () => {
    const ctx = makeContext({
      capability: 'git.push',
      riskClass: 'high',
    });
    const result = evaluate(ctx, makePolicyVersion());
    expect(result.decision).toBe('require_approval');
    expect(result.requiredRole).toBe('admin');
    expect(result.matchedRules).toEqual([]);
  });

  it('requires approval for CRITICAL-risk with owner role', () => {
    const ctx = makeContext({
      capability: 'deployment.execute',
      riskClass: 'critical',
      resource: 'staging/api-service',
    });
    const result = evaluate(ctx, makePolicyVersion());
    expect(result.decision).toBe('require_approval');
    expect(result.requiredRole).toBe('owner');
  });

  it('approval decision includes policy version', () => {
    const ctx = makeContext({
      capability: 'process.exec',
      riskClass: 'high',
    });
    const result = evaluate(ctx, makePolicyVersion());
    expect(result.decision).toBe('require_approval');
    expect(result.policyVersion).toBe('p_1');
  });
});

// ── §9 Test Case 4: Expired approval (risk defaults simulation) ──────────

describe('Policy Engine §9.4 — Expired approval', () => {
  it('generates require_approval with expiresAt in the future by default', () => {
    const ctx = makeContext({
      capability: 'git.push',
      riskClass: 'high',
    });
    const result = evaluate(ctx, makePolicyVersion());
    expect(result.decision).toBe('require_approval');
    expect(result.expiresAt).toBeInstanceOf(Date);
    // expiresAt should be roughly 30 minutes from now
    const now = new Date();
    const diffMs = result.expiresAt.getTime() - now.getTime();
    expect(diffMs).toBeGreaterThan(25 * 60 * 1000);      expect(diffMs).toBeLessThan(35 * 60 * 1000);
  });
});

// ── §9 Test Case 5 & 6: First valid decision wins (CAS simulation) ──────

// Note: The CAS invariant is enforced at the approval-workflow level in the
// control plane, not in the pure evaluate() function. The evaluate function
// is pure and produces the same result every time for the same inputs.
// Tests 5 and 6 are covered in the control-plane approval-workflow tests.

// ── §9 Test Case 7: Revoked device approval ──────────────────────────────

describe('Policy Engine §9.7 — Revoked device', () => {
  it('denies actions from revoked devices regardless of policy', () => {
    const ctx = makeContext({
      capability: 'filesystem.read',
      riskClass: 'low',
      deviceStatus: 'revoked',
    });
    const result = evaluate(ctx, makePolicyVersion());
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('revoked');
  });

  it('denies actions from suspended devices regardless of policy', () => {
    const ctx = makeContext({
      capability: 'filesystem.read',
      riskClass: 'low',
      deviceStatus: 'suspended',
    });
    const result = evaluate(ctx, makePolicyVersion());
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('suspended');
  });

  it('device check happens before policy rules (revoked device cannot be allowed by rules)', () => {
    const ctx = makeContext({
      capability: 'filesystem.read',
      riskClass: 'low',
      deviceStatus: 'revoked',
    });
    const pv = makePolicyVersion({
      rules: [
        {
          id: 'allow-everything',
          description: 'Allow everything',
          match: {},
          effect: 'allow',
          priority: 1000,
        },
      ],
    });
    const result = evaluate(ctx, pv);
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('revoked');
  });
});

// ── §9 Test Case 8: Policy change after request ──────────────────────────

describe('Policy Engine §9.8 — Policy change after request', () => {
  it('evaluates against the given policy version (snapshot semantics)', () => {
    // An approval requested under version A (which requires approval)
    const ctx = makeContext({
      capability: 'git.push',
      riskClass: 'high',
    });
    const versionA = makePolicyVersion({
      version: 'p_1',
      rules: [],
    });
    const resultA = evaluate(ctx, versionA);
    expect(resultA.decision).toBe('require_approval');
    expect(resultA.policyVersion).toBe('p_1');

    // Before decision, version B activates and would deny the same action
    const versionB = makePolicyVersion({
      version: 'p_2',
      rules: [
        {
          id: 'deny-all-pushes',
          description: 'Deny all git pushes',
          match: { capability: 'git.push' },
          effect: 'deny',
          priority: 10,
        },
      ],
    });
    // Re-evaluate against current version B
    const resultB = evaluate(ctx, versionB);
    expect(resultB.decision).toBe('deny');
    expect(resultB.policyVersion).toBe('p_2');
    expect(resultB.reason).toContain('Deny all git pushes');
  });

  it('policy change from require_approval to allow leaves the decision to the human', () => {
    // This scenario is handled by the approval-workflow state machine:
    // if the current version now says 'allow', the pending approval is
    // left as-is (not auto-resolved). The evaluate function correctly
    // produces 'allow' for the new version:
    const ctx = makeContext({
      capability: 'git.push',
      riskClass: 'high',
    });
    const versionOld = makePolicyVersion({
      version: 'p_1',
      rules: [],
    });
    const versionNew = makePolicyVersion({
      version: 'p_2',
      rules: [
        {
          id: 'allow-pushes',
          description: 'Allow pushes for trusted users',
          match: { capability: 'git.push', trustProfile: 'trusted-afk' },
          effect: 'allow',
          priority: 5,
        },
      ],
    });
    // Under old version (no rules), HIGH requires approval
    const oldResult = evaluate(ctx, versionOld);
    expect(oldResult.decision).toBe('require_approval');

    // Under new version (allow rule for trusted-afk), but the context
    // is 'default' profile so the allow rule doesn't match — still requires approval
    const newResult = evaluate(ctx, versionNew);
    // The allow rule matches trustProfile 'trusted-afk', not 'default',
    // so for 'default' profile, HIGH still requires approval
    expect(newResult.decision).toBe('require_approval');
  });
});

// ── §9 Test Case 9: Deny-override cannot be overridden by rules ──────────

describe('Policy Engine §9.9 — Deny-override immutability', () => {
  it('no combination of allow rules can override the deny floor', () => {
    const ctx = makeContext({
      capability: 'deployment.execute',
      riskClass: 'critical',
      resource: 'production/api-service',
    });
    const pv = makePolicyVersion({
      rules: [
        {
          id: 'r1',
          description: 'Allow production deployments for admins',
          match: { capability: 'deployment.execute', resourcePattern: 'production/**' },
          effect: 'allow',
          priority: 100,
          requiredRole: 'admin',
        },
        {
          id: 'r2',
          description: 'Allow everything',
          match: {},
          effect: 'allow',
          priority: 10000,
        },
      ],
    });
    const result = evaluate(ctx, pv);
    expect(result.decision).toBe('deny');
    expect(result.policyVersion).toBe('p_1');
  });

  it('all deny-floor entries are covered by the floor list', () => {
    // Verify the floor entries exist and are what we expect. Two force-push
    // entries (Phase 9's protected-branch requirement) were added alongside
    // the original three; this list is intentionally spelled out rather than
    // just length-checked so a future addition is forced to update this test
    // and think about whether the new entry's resourcePattern is correct.
    expect(DENY_OVERRIDE_FLOOR).toHaveLength(5);
    expect(DENY_OVERRIDE_FLOOR.map((e) => e.capability)).toEqual([
      'deployment.execute',
      'filesystem.delete',
      'secret.read',
      'git.push',
      'git.push',
    ]);
  });

  it('does not deny a resource-scoped floor capability when no resource is given', () => {
    // Regression: denyFloorMatches previously treated "this floor entry has a
    // resourcePattern, but no resource was passed in" as equivalent to "this
    // entry has no resourcePattern" and matched unconditionally — so an
    // ordinary git.push evaluated without a `resource` field (a legitimate
    // shape: not every push targets a named ref the caller bothers to pass)
    // was denied by the floor even though it was nowhere near force-pushing
    // main/master. A resource-scoped entry must require an actual matching
    // resource, never match on the entry's mere existence.
    const result = evaluate(
      makeContext({ capability: 'git.push', riskClass: 'high' }),
      null,
    );
    expect(result.decision).toBe('require_approval');
  });
});

// ── Additional: Trust profile behavior ────────────────────────────────────

describe('Policy Engine — Trust profile behavior', () => {
  it('supervised profile promotes MEDIUM to require_approval', () => {
    const ctx = makeContext({
      capability: 'network.access',
      riskClass: 'medium',
      trustProfile: 'supervised',
    });
    const result = evaluate(ctx, makePolicyVersion());
    expect(result.decision).toBe('require_approval');
    expect(result.requiredRole).toBe('admin');
  });

  it('trusted-afk profile allows MEDIUM without approval', () => {
    const ctx = makeContext({
      capability: 'network.access',
      riskClass: 'medium',
      trustProfile: 'trusted-afk',
    });
    const result = evaluate(ctx, makePolicyVersion());
    expect(result.decision).toBe('allow');
  });

  it('read-only profile denies HIGH-risk write actions', () => {
    const ctx = makeContext({
      capability: 'filesystem.write',
      riskClass: 'medium',
      trustProfile: 'read-only',
    });
    const result = evaluate(ctx, makePolicyVersion());
    expect(result.decision).toBe('deny');
  });

  it('read-only profile allows LOW-risk read actions', () => {
    const ctx = makeContext({
      capability: 'filesystem.read',
      riskClass: 'low',
      trustProfile: 'read-only',
    });
    const result = evaluate(ctx, makePolicyVersion());
    expect(result.decision).toBe('allow');
  });
});

// ── Additional: Rule matching ─────────────────────────────────────────────

describe('Policy Engine — Rule matching', () => {
  it('matches rule by capability only', () => {
    const ctx = makeContext({
      capability: 'git.commit',
      riskClass: 'medium',
    });
    const pv = makePolicyVersion({
      rules: [
        {
          id: 'commit-rule',
          description: 'Require approval for commits',
          match: { capability: 'git.commit' },
          effect: 'require_approval',
          priority: 5,
        },
      ],
    });
    const result = evaluate(ctx, pv);
    expect(result.decision).toBe('require_approval');
    expect(result.matchedRules).toEqual(['commit-rule']);
  });

  it('matches rule by capability + resource pattern', () => {
    const ctx = makeContext({
      capability: 'filesystem.write',
      riskClass: 'medium',
      resource: 'docs/README.md',
    });
    const pv = makePolicyVersion({
      rules: [
        {
          id: 'docs-write',
          description: 'Allow docs writes',
          match: {
            capability: 'filesystem.write',
            resourcePattern: 'docs/**',
          },
          effect: 'allow',
          priority: 5,
        },
      ],
    });
    const result = evaluate(ctx, pv);
    expect(result.decision).toBe('allow');
  });

  it('does not match rule when resource pattern does not match', () => {
    const ctx = makeContext({
      capability: 'filesystem.write',
      riskClass: 'medium',
      resource: 'src/index.ts',
    });
    const pv = makePolicyVersion({
      rules: [
        {
          id: 'docs-write',
          description: 'Allow docs writes',
          match: {
            capability: 'filesystem.write',
            resourcePattern: 'docs/**',
          },
          effect: 'allow',
          priority: 5,
        },
      ],
    });
    const result = evaluate(ctx, pv);
    // Falls through to risk-class default (allow for medium)
    expect(result.decision).toBe('allow');
  });

  it('priority ordering: higher priority rule wins', () => {
    const ctx = makeContext({
      capability: 'git.push',
      riskClass: 'high',
    });
    const pv = makePolicyVersion({
      rules: [
        {
          id: 'deny-push',
          description: 'Deny all pushes',
          match: { capability: 'git.push' },
          effect: 'deny',
          priority: 10,
        },
        {
          id: 'allow-push',
          description: 'Allow pushes',
          match: { capability: 'git.push' },
          effect: 'allow',
          priority: 5,
        },
      ],
    });
    const result = evaluate(ctx, pv);
    expect(result.decision).toBe('deny');
    expect(result.matchedRules).toEqual(['deny-push']); // deny records the matching rule
  });

  it('specificity tiebreaking: more specific rule wins at same priority', () => {
    const ctx = makeContext({
      capability: 'filesystem.write',
      riskClass: 'medium',
      resource: 'src/index.ts',
      projectId: 'proj_alpha',
    });
    const pv = makePolicyVersion({
      rules: [
        {
          id: 'broad-allow',
          description: 'Allow all writes',
          match: { capability: 'filesystem.write' },
          effect: 'allow',
          priority: 5,
        },
        {
          id: 'narrow-deny',
          description: 'Deny writes to src/',
          match: {
            capability: 'filesystem.write',
            resourcePattern: 'src/**',
            projectId: 'proj_alpha',
          },
          effect: 'deny',
          priority: 5, // same priority, but more specific
        },
      ],
    });
    const result = evaluate(ctx, pv);
    // The narrower deny rule (specificity 3) should win over broad allow (specificity 1)
    expect(result.decision).toBe('deny');
  });
});

// ── Additional: Risk defaults verification ────────────────────────────────

describe('Policy Engine — Risk defaults', () => {
  it('LOW always allows by default', () => {
    expect(riskClassDefaults('low', 'default').defaultEffect).toBe('allow');
    expect(riskClassDefaults('low', 'supervised').defaultEffect).toBe('allow');
    expect(riskClassDefaults('low', 'trusted-afk').defaultEffect).toBe('allow');
  });

  it('MEDIUM allows by default except supervised', () => {
    expect(riskClassDefaults('medium', 'default').defaultEffect).toBe('allow');
    expect(riskClassDefaults('medium', 'trusted-afk').defaultEffect).toBe('allow');
    expect(riskClassDefaults('medium', 'supervised').defaultEffect).toBe('require_approval');
    expect(riskClassDefaults('medium', 'supervised').requiredRole).toBe('admin');
  });

  it('HIGH always requires approval by default', () => {
    const highDefault = riskClassDefaults('high', 'default');
    expect(highDefault.defaultEffect).toBe('require_approval');
    expect(highDefault.requiredRole).toBe('admin');
  });

  it('CRITICAL always requires approval by default with owner role', () => {
    const criticalDefault = riskClassDefaults('critical', 'default');
    expect(criticalDefault.defaultEffect).toBe('require_approval');
    expect(criticalDefault.requiredRole).toBe('owner');
  });
});
