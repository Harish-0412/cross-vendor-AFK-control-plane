import type { PolicyRule } from '@freebuff/protocol';

/**
 * §4.2 — Specificity tiebreaking.
 *
 * When two rules have equal `priority`, the more specific one wins.
 * Specificity = count of non-omitted `match` fields.
 * A rule matching {capability, resourcePattern, projectId} beats one
 * matching only {capability}.
 *
 * Mirrors CSS specificity — a well-understood pattern for rule-matching
 * systems, chosen deliberately to avoid novelty in the one place novelty
 * is least welcome.
 */

export function ruleSpecificity(rule: PolicyRule): number {
  let count = 0;
  if (rule.match.capability !== undefined) count++;
  if (rule.match.riskClass !== undefined) count++;
  if (rule.match.resourcePattern !== undefined) count++;
  if (rule.match.projectId !== undefined) count++;
  if (rule.match.trustProfile !== undefined) count++;
  return count;
}

/**
 * Sort rules for evaluation: highest priority first, then highest
 * specificity first (both descending). This gives us the "first match wins"
 * ordering needed by the evaluation pipeline.
 */
export function sortRulesForEvaluation(rules: PolicyRule[]): PolicyRule[] {
  return [...rules].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return ruleSpecificity(b) - ruleSpecificity(a);
  });
}
