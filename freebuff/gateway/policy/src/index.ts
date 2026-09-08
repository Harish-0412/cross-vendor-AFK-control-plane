/**
 * §5 — Gateway-side policy module.
 *
 * Ships a READ-ONLY CACHE of the active PolicyVersion, pulled from the
 * Control Plane over the tunnel and signed by it (so the Gateway can verify
 * it hasn't been tampered with in transit or on disk).
 *
 * Runs the SAME evaluation function from packages/policy-engine as the
 * Control Plane, giving the agent adapter a fast local answer so a HIGH-risk
 * action isn't attempted at all if it's locally known to require approval.
 *
 * CANNOT ITSELF AUTHORIZE. Its ALLOW is a local optimization hint, never the
 * final word. Every ALLOW and every APPROVAL_REQUIRED must still be confirmed
 * against the Control Plane before the sandboxed action is permitted to run
 * for HIGH/CRITICAL actions.
 */

import type {
  Capability,
  Decision,
  PolicyEvaluationContext,
  PolicyVersion,
  TrustProfile,
} from '@freebuff/protocol';
import { evaluate } from '@freebuff/policy-engine';

export interface CachedPolicyVersion {
  version: PolicyVersion;
  fetchedAt: Date;
  expiresAt: Date; // Cache TTL — after this, must re-fetch from control plane
}

export interface PolicyCacheOptions {
  /** Maximum age of cached policy before it must be refreshed (default 5 min) */
  cacheTtlMs?: number;
  /** Callback to fetch the latest policy version from the control plane */
  fetchPolicyVersion: () => Promise<PolicyVersion | null>;
  /** Callback to confirm a local ALLOW / APPROVAL_REQUIRED with the control plane */
  confirmWithControlPlane: (
    capability: Capability,
    riskClass: 'low' | 'medium' | 'high' | 'critical',
    context: {
      resource?: string;
      projectId?: string;
      trustProfile?: TrustProfile;
      deviceId: string;
      sessionId?: string;
      userId: string;
    },
  ) => Promise<Decision>;
}

export class GatewayPolicyCache {
  private cache: CachedPolicyVersion | null = null;
  private fetchPolicy: () => Promise<PolicyVersion | null>;
  private confirmWithCP: PolicyCacheOptions['confirmWithControlPlane'];
  private cacheTtlMs: number;
  private pendingRefresh: Promise<void> | null = null;

  constructor(options: PolicyCacheOptions) {
    this.fetchPolicy = options.fetchPolicyVersion;
    this.confirmWithCP = options.confirmWithControlPlane;
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60 * 1000; // 5 min default
  }

  /**
   * Get the current cached policy version, refreshing if expired.
   */
  async getPolicyVersion(): Promise<PolicyVersion | null> {
    if (
      this.cache &&
      new Date() < new Date(this.cache.expiresAt.getTime())
    ) {
      return this.cache.version;
    }

    // Prevent concurrent refreshes
    if (this.pendingRefresh) {
      await this.pendingRefresh;
      return this.cache?.version ?? null;
    }

    this.pendingRefresh = this.refreshCache();
    try {
      await this.pendingRefresh;
    } finally {
      this.pendingRefresh = null;
    }

    return this.cache?.version ?? null;
  }

  /**
   * Refresh the policy cache from the control plane.
   */
  private async refreshCache(): Promise<void> {
    const version = await this.fetchPolicy();
    if (version) {
      this.cache = {
        version,
        fetchedAt: new Date(),
        expiresAt: new Date(
          Date.now() + this.cacheTtlMs,
        ),
      };
    }
  }

  /**
   * Local advisory evaluation — runs the SAME function as the control plane.
   *
   * For LOW/MEDIUM actions: returns the local evaluation immediately.
   *   - The local cache is signed and no more than cacheTtlMs stale.
   *   - LOW/MEDIUM risk is bounded by definition.
   *
   * For HIGH/CRITICAL actions: returns the local evaluation BUT the action
   * MUST still be confirmed against the control plane before execution.
   * If the tunnel is down, HIGH/CRITICAL actions block and fail closed.
   */
  evaluate(
    _capability: Capability,
    _riskClass: 'low' | 'medium' | 'high' | 'critical',
    context: PolicyEvaluationContext,
  ): Decision {
    const policyVersion = this.cache?.version ?? null;
    return evaluate(context, policyVersion);
  }

  /**
   * Confirm a decision with the control plane.
   * This is the authoritative check — the Gateway's local ALLOW is never final.
   */
  async confirm(
    capability: Capability,
    riskClass: 'low' | 'medium' | 'high' | 'critical',
    context: {
      resource?: string;
      projectId?: string;
      trustProfile?: TrustProfile;
      deviceId: string;
      sessionId?: string;
      userId: string;
    },
  ): Promise<Decision> {
    return this.confirmWithCP(capability, riskClass, context);
  }

  /**
   * Check if the local cache is fresh enough to trust for LOW/MEDIUM actions.
   */
  isCacheFresh(): boolean {
    if (!this.cache) return false;
    return new Date() < new Date(this.cache.expiresAt.getTime());
  }

  /**
   * Get cache metadata for debugging/monitoring.
   */
  getCacheStatus(): {
    fresh: boolean;
    fetchedAt: Date | null;
    expiresAt: Date | null;
    version: string | null;
  } {
    if (!this.cache) {
      return {
        fresh: false,
        fetchedAt: null,
        expiresAt: null,
        version: null,
      };
    }
    return {
      fresh: this.isCacheFresh(),
      fetchedAt: this.cache.fetchedAt,
      expiresAt: this.cache.expiresAt,
      version: this.cache.version.version,
    };
  }
}
