import type { Capability } from '@freebuff/protocol';

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
  force?: boolean;
}> = [
  { capability: 'deployment.execute', resourcePattern: 'production/**' },
  { capability: 'filesystem.delete', resourcePattern: '**/.git/**' },
  { capability: 'secret.read', resourcePattern: '**/.env*' },
  { capability: 'git.push', resourcePattern: 'main', force: true },
  { capability: 'git.push', resourcePattern: 'master', force: true },
];

/**
 * Check whether the deny floor matches a proposed action.
 * Returns the denying rule's identity if matched, null otherwise.
 */
export function denyFloorMatches(
  capability: Capability,
  resource?: string,
  force?: boolean,
): { matched: true; ruleId: string } | { matched: false } {
  for (const floorEntry of DENY_OVERRIDE_FLOOR) {
    if (floorEntry.capability !== capability) continue;
    if (floorEntry.force !== undefined && floorEntry.force !== force) continue;

    if (!floorEntry.resourcePattern) {
      // No resource pattern on this floor entry => it denies the capability
      // outright, regardless of resource.
      return { matched: true, ruleId: `deny-floor:${floorEntry.capability}` };
    }

    // This entry is scoped to a resource pattern. Bug fixed here: the
    // previous `if (pattern && resource) {...} else { match-anything }`
    // treated a *missing* resource as equivalent to "no pattern on this
    // entry" and matched unconditionally — so e.g. `git.push` evaluated
    // without a `resource` field was denied by the floor even when it was
    // an ordinary push to a feature branch, nowhere near `force:main`. A
    // resource-scoped floor entry must only match when the resource is
    // actually present AND actually matches; otherwise this entry simply
    // does not apply and evaluation continues to the next floor entry (or
    // falls through to the normal rule/risk-class pipeline).
    if (resource && globMatches(resource, floorEntry.resourcePattern)) {
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
