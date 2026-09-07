import type { RiskClass, TrustProfile } from '@freebuff/protocol';

/**
 * §4.1 Step 4 — Risk-class defaults per trust profile.
 *
 * When no user-authored PolicyRule matches an action, the default behavior
 * for the capability's risk class is applied, tuned by the active trust profile.
 *
 * These defaults are the "safe by default" floor: even a project with zero
 * custom policy is still safe, because HIGH/CRITICAL actions require approval
 * out of the box.
 */

export interface RiskClassDefaults {
  riskClass: RiskClass;
  defaultEffect: 'allow' | 'deny' | 'require_approval';
  requiredRole?: 'owner' | 'admin';
}

/**
 * Compute the default effect for a risk class given a trust profile.
 *
 * Trust profile tuning:
 * - 'supervised': MEDIUM promoted to require_approval (everything MEDIUM+ needs approval)
 * - 'trusted-afk': only HIGH+ requires approval (AFK Mode per Phase 7)
 * - 'read-only': any WRITE-class capability is denied outright
 * - 'default': standard defaults (LOW/MEDIUM allow, HIGH/CRITICAL require approval)
 */
export function riskClassDefaults(
  riskClass: RiskClass,
  trustProfile: TrustProfile,
): RiskClassDefaults {
  // read-only profile: deny any write-class capability
  if (trustProfile === 'read-only') {
    if (
      riskClass === 'low' ||
      riskClass === 'medium' ||
      riskClass === 'high' ||
      riskClass === 'critical'
    ) {
      // All capabilities are at least LOW; in read-only mode, anything
      // that isn't purely read is denied. We judge by risk class as a
      // proxy: LOW is typically read, everything else may write.
      // For simplicity and safety, treat MEDIUM+ as write-class.
      if (riskClass === 'low') {
        return { riskClass: 'low', defaultEffect: 'allow' };
      }
      return { riskClass, defaultEffect: 'deny', requiredRole: undefined };
    }
  }

  switch (riskClass) {
    case 'low':
      return { riskClass: 'low', defaultEffect: 'allow' };

    case 'medium':
      if (trustProfile === 'supervised') {
        return { riskClass: 'medium', defaultEffect: 'require_approval', requiredRole: 'admin' };
      }
      return { riskClass: 'medium', defaultEffect: 'allow' };

    case 'high':
      return {
        riskClass: 'high',
        defaultEffect: 'require_approval',
        requiredRole: 'admin',
      };

    case 'critical':
      return {
        riskClass: 'critical',
        defaultEffect: 'require_approval',
        requiredRole: 'owner',
      };
  }
}
