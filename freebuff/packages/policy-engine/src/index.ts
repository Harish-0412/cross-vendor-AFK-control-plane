/**
 * §6 — Shared pure logic package index.
 *
 * Re-exports everything from the policy engine so both Gateway and Control
 * Plane import from a single source of truth.
 */

export { DENY_OVERRIDE_FLOOR, denyFloorMatches } from './deny-floor';
export {
  ruleSpecificity,
  sortRulesForEvaluation,
} from './specificity';
export { riskClassDefaults, type RiskClassDefaults } from './risk-defaults';
export { evaluate } from './evaluate';
