/**
 * The exact files each integration may open, as patterns on the path relative
 * to a granted root (always with forward slashes).
 *
 * This is an allowlist on purpose. A denylist ("everything except auth.json")
 * fails open: the next credential file a tool adds would be readable until
 * someone noticed. Here, a file nobody listed is simply never opened.
 */
import type { IntegrationId, IntegrationScope } from '@odysseus/protocol';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const PATTERNS: Partial<Record<IntegrationId, Partial<Record<IntegrationScope, RegExp[]>>>> = {
  codex: {
    // Codex writes sessions as sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl.
    // Usage (token counts, rate limits) is recorded inside the same files.
    'history.read': [/^\d{4}\/\d{2}\/\d{2}\/rollout-[A-Za-z0-9T:._-]+\.jsonl$/],
    'usage.read': [/^\d{4}\/\d{2}\/\d{2}\/rollout-[A-Za-z0-9T:._-]+\.jsonl$/],
  },
  antigravity: {
    'history.read': [
      new RegExp(`^${UUID}/\\.system_generated/logs/transcript(_full)?\\.jsonl$`, 'i'),
    ],
  },
};

export function allowedPatterns(integration: IntegrationId, scope: IntegrationScope): RegExp[] {
  return PATTERNS[integration]?.[scope] ?? [];
}

export function isAllowedFile(
  integration: IntegrationId,
  scope: IntegrationScope,
  relativePath: string,
): boolean {
  const normalised = relativePath.replace(/\\/g, '/');
  return allowedPatterns(integration, scope).some((pattern) => pattern.test(normalised));
}
