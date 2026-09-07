import type { Capability } from '@freebuff/protocol';
import type { PolicyRule } from '@freebuff/protocol';

/**
 * §3.5 — Hardcoded, versioned-in-source deny-override floor.
 *
 * Evaluated BEFORE any user-authored PolicyRule. No policy version, however
 * constructed, can produce 'allow' for something the floor denies.
 *
 * Changing this list requires a PR + code review — it is NOT editable via
 * any API or database write.
 */
export const DENY_OVERRIDE_FLOOR: ReadonlyArray<{
  capability: Capability;
  resourcePattern?: string;
}> = [
  { capability: 'deployment.execute', resourcePattern: 'production/**' },
  { capability: 'filesystem.delete', resourcePattern: '**/.git/**' },
  { capability: 'secret.read', resourcePattern: '**/.env*' },
];

/**
 * Check whether the deny floor matches a proposed action.
 * Returns the denying rule's identity if matched, null otherwise.
 */
export function denyFloorMatches(
  capability: Capability,
  resource?: string,
): { matched: true; ruleId: string } | { matched: false } {
  for (const floorEntry of DENY_OVERRIDE_FLOOR) {
    if (floorEntry.capability !== capability) continue;
    if (floorEntry.resourcePattern && resource) {
      if (globMatches(resource, floorEntry.resourcePattern)) {
        return { matched: true, ruleId: `deny-floor:${floorEntry.capability}` };
      }
    } else {
      // No resource pattern => matches any resource for this capability
      return { matched: true, ruleId: `deny-floor:${floorEntry.capability}` };
    }
  }
  return { matched: false };
}

/**
 * Simple glob matching: supports * (any chars except /) and ** (any chars).
 * Keeps the dependency footprint at zero.
 */
function globMatches(resource: string, pattern: string): boolean {
  const parts = pattern.split('/');
  const resParts = resource.split('/');

  // Quick length check for non-** patterns
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
      // ** matches zero or more path segments
      if (pi === pattern.length - 1) return true; // trailing ** matches everything
      // Try matching the rest of the pattern at every remaining resource position
      for (let r = ri; r <= resource.length; r++) {
        if (matchParts(pattern, resource, pi + 1, r)) return true;
      }
      return false;
    }

    if (ri >= resource.length) return false;

    const r = resource[ri]!;

    if (p === '*') {
      // * matches anything except /
      pi++;
      ri++;
    } else if (p === r) {
      pi++;
      ri++;
    } else if (p.includes('*') || p.includes('?')) {
      // Extended glob per segment
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
