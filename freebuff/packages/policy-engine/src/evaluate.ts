import type {
  Decision,
  PolicyEvaluationContext,
  PolicyRule,
  PolicyVersion,
} from '@freebuff/protocol';

import { denyFloorMatches } from './deny-floor';
import { riskClassDefaults } from './risk-defaults';
import { sortRulesForEvaluation } from './specificity';

/**
 * §4.1 — The policy evaluation pipeline.
 *
 * Pure and synchronous given (context, policyVersion) as input — no I/O
 * inside the decision logic itself. This makes it trivially unit-testable
 * and means the same function runs identically in both the Gateway (local
 * cache advisory check) and the Control Plane (authoritative decision).
 *
 * Evaluation order (fixed, not configurable — this order IS the security guarantee):
 * 1. DENY-OVERRIDE FLOOR — terminal, no rule can override
 * 2. DEVICE STATUS CHECK — revoked/suspended device gets nothing
 * 3. USER-AUTHORED POLICY RULES — highest priority/specificity wins
 * 4. RISK-CLASS DEFAULT — fallthrough when no rule matched
 */

export function evaluate(
  context: PolicyEvaluationContext,
  policyVersion: PolicyVersion | null,
): Decision {
  // Step 1: Deny-override floor (§3.5) — evaluated first, terminal
  const floorResult = denyFloorMatches(context.capability, context.resource, context.force);
  if (floorResult.matched) {
    return {
      decision: 'deny',
      policyVersion: policyVersion?.version ?? 'none',
      reason: `Denied by deny-override floor: ${context.capability}`,
    };
  }

  // Step 2: Device status check — revoked/suspended devices get nothing
  if (context.deviceStatus === 'revoked' || context.deviceStatus === 'suspended') {
    return {
      decision: 'deny',
      policyVersion: policyVersion?.version ?? 'none',
      reason: `Device is ${context.deviceStatus} and cannot perform actions`,
    };
  }

  // Step 3: User-authored policy rules (current PolicyVersion)
  if (policyVersion && policyVersion.rules.length > 0) {
    const sortedRules = sortRulesForEvaluation(policyVersion.rules);
    for (const rule of sortedRules) {
      if (ruleMatches(context, rule)) {
        if (rule.effect === 'deny') {
          return {
            decision: 'deny',
            policyVersion: policyVersion.version,
            reason: rule.description,
            matchedRules: [rule.id],
          };
        }
        if (rule.effect === 'require_approval') {
          const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
          return {
            decision: 'require_approval',
            policyVersion: policyVersion.version,
            ...(rule.requiredRole ? { requiredRole: rule.requiredRole } : {}),
            expiresAt,
            matchedRules: [rule.id],
            reason: rule.description,
          };
        }
        if (rule.effect === 'allow') {
          return {
            decision: 'allow',
            policyVersion: policyVersion.version,
          };
        }
      }
    }
  }

  // Step 4: Risk-class default (no explicit rule matched)
  const defaults = riskClassDefaults(context.riskClass, context.trustProfile);
  if (defaults.defaultEffect === 'allow') {
    return {
      decision: 'allow',
      policyVersion: policyVersion?.version ?? 'none',
    };
  }
  if (defaults.defaultEffect === 'deny') {
    return {
      decision: 'deny',
      policyVersion: policyVersion?.version ?? 'none',
      reason: `Action denied by ${context.trustProfile} trust profile (risk class: ${context.riskClass})`,
    };
  }
  // require_approval
  return {
    decision: 'require_approval',
    policyVersion: policyVersion?.version ?? 'none',
    ...(defaults.requiredRole ? { requiredRole: defaults.requiredRole } : {}),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    matchedRules: [],
    reason: `Risk class ${context.riskClass} requires approval under ${context.trustProfile} profile`,
  };
}

/**
 * Check whether a policy rule matches the evaluation context.
 */
function ruleMatches(context: PolicyEvaluationContext, rule: PolicyRule): boolean {
  // capability match
  if (rule.match.capability !== undefined) {
    if (rule.match.capability !== context.capability) return false;
  }

  // risk class match (rule-level override)
  if (rule.match.riskClass !== undefined) {
    if (rule.match.riskClass !== context.riskClass) return false;
  }

  // resource pattern match
  if (rule.match.resourcePattern !== undefined) {
    if (context.resource === undefined) return false;
    if (!globMatches(context.resource, rule.match.resourcePattern)) return false;
  }

  // project ID match
  if (rule.match.projectId !== undefined) {
    if (context.projectId !== rule.match.projectId) return false;
  }

  // trust profile match
  if (rule.match.trustProfile !== undefined) {
    if (rule.match.trustProfile !== context.trustProfile) return false;
  }

  return true;
}

/** Simple glob matching — zero dependencies. Supports * and **. */
function globMatches(resource: string, pattern: string): boolean {
  const parts = pattern.split('/');
  const resParts = resource.split('/');

  let maxLen = 0;
  for (const p of parts) {
    if (p !== '**') maxLen++;
  }
  if (resParts.length < maxLen) return false;

  return matchParts(parts, resParts, 0, 0);
}

function matchParts(pattern: string[], resource: string[], pi: number, ri: number): boolean {
  while (pi < pattern.length) {
    const p = pattern[pi]!;

    if (p === '**') {
      if (pi === pattern.length - 1) return true;
      for (let r = ri; r <= resource.length; r++) {
        if (matchParts(pattern, resource, pi + 1, r)) return true;
      }
      return false;
    }

    if (ri >= resource.length) return false;

    const r = resource[ri]!;

    if (p === '*') {
      pi++;
      ri++;
    } else if (p === r) {
      pi++;
      ri++;
    } else if (p.includes('*') || p.includes('?')) {
      if (!segmentMatches(p, r)) return false;
      pi++;
      ri++;
    } else {
      return false;
    }
  }

  return ri === resource.length;
}

function segmentMatches(pattern: string, value: string): boolean {
  const pParts = pattern.split('*');
  if (pParts.length === 1) return pattern === value;

  let pos = 0;
  for (let i = 0; i < pParts.length; i++) {
    if (i === 0) {
      if (!value.startsWith(pParts[i]!)) return false;
      pos = pParts[i]!.length;
    } else if (i === pParts.length - 1) {
      if (!value.endsWith(pParts[i]!)) return false;
    } else {
      const idx = value.indexOf(pParts[i]!, pos);
      if (idx === -1) return false;
      pos = idx + pParts[i]!.length;
    }
  }
  return true;
}
