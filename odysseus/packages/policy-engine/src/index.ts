/**
 * §6 — Shared pure logic package index.
 *
 * Re-exports everything from the policy engine so both Gateway and Control
 * Plane import from a single source of truth.
 */

export {
  DENY_OVERRIDE_FLOOR,
  PROTECTED_CONFIG_DIRECTORIES,
  PROTECTED_CONFIG_FILES,
  denyFloorMatches,
} from './deny-floor';
export { ruleSpecificity, sortRulesForEvaluation } from './specificity';
export { riskClassDefaults, type RiskClassDefaults } from './risk-defaults';
export { evaluate } from './evaluate';
export {
  assessAction,
  assessCommand,
  assessPath,
  commandWriteTargets,
  executingGitConfig,
  isCapability,
  isRiskClass,
  maxRiskClass,
  riskLevel,
  RISK_THRESHOLDS,
} from './action-risk';
