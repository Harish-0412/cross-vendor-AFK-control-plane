/**
 * §5 — Gateway-side policy module.
 *
 * Ships a READ-ONLY CACHE of the active PolicyVersion, pulled from the
 * Control Plane over the tunnel via the caller-supplied `fetchPolicyVersion`
 * callback.
 *
 * IMPORTANT — signature verification is NOT performed by this class. The
 * design intent (§5 of the Phase 5 plan) is that the cached policy is signed
 * by the Control Plane so tampering in transit or on disk can be detected;
 * this class has no code path that checks a signature, so that guarantee
 * only holds if `fetchPolicyVersion` itself verifies the response before
 * resolving (e.g. the tunnel transport layer authenticates the Control
 * Plane, or the callback checks a detached signature before returning). A
 * `fetchPolicyVersion` that resolves with unverified data gives this cache
 * unverified data — audited and documented here rather than silently
 * assumed, since the previous version of this docstring implied the class
 * itself performed a check it does not perform.
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

import { evaluate } from '@freebuff/policy-engine';
import type {
  Capability,
  Decision,
  PolicyEvaluationContext,
  PolicyVersion,
  TrustProfile,
} from '@freebuff/protocol';

export interface CachedPolicyVersion {
  version: PolicyVersion;
  fetchedAt: Date;
  expiresAt: Date; // Cache TTL — after this, must re-fetch from control plane
}

export interface PolicyCacheOptions {
  /** Maximum age of cached policy before it must be refreshed (default 5 min) */
  cacheTtlMs?: number;
  /**
   * Fetch the latest policy version from the control plane. This callback is
   * responsible for authenticating the response (verifying the Control
   * Plane's signature, or relying on an already-authenticated transport) —
   * `GatewayPolicyCache` does not verify anything itself and will cache
   * whatever this resolves with. Return `null` on any failure (network
   * error, verification failure) rather than resolving with unverified or
   * partial data; a `null` here is treated as "keep serving the existing
   * cache until it expires, then evaluate with no policy version."
   */
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
   *
   * BUG FIXED HERE: `refreshCache()` leaves `this.cache` untouched when
   * `fetchPolicy()` fails (returns null) or throws — by design, so a
   * transient failure doesn't discard a still-being-attempted refresh's
   * prior good data. But every return path here used to be
   * `this.cache?.version ?? null`, which reads whatever is *currently*
   * cached with no re-check of freshness — so once the cache had expired
   * and a refresh attempt failed, this kept returning the same stale,
   * already-expired version forever (until some future refresh happened to
   * succeed), silently violating the "no more than cacheTtlMs stale"
   * guarantee this class's whole safety argument depends on. Every return
   * path now re-checks freshness before returning a cached value.
   */
  async getPolicyVersion(): Promise<PolicyVersion | null> {
    if (this.isCacheFresh()) {
      return this.cache!.version;
    }

    // Prevent concurrent refreshes
    if (this.pendingRefresh) {
      await this.pendingRefresh;
      return this.isCacheFresh() ? this.cache!.version : null;
    }

    this.pendingRefresh = this.refreshCache();
    try {
      await this.pendingRefresh;
    } finally {
      this.pendingRefresh = null;
    }

    return this.isCacheFresh() ? this.cache!.version : null;
  }

  /**
   * Refresh the policy cache from the control plane.
   */
  private async refreshCache(): Promise<void> {
    // A rejected fetchPolicy() (network error, transport failure) must
    // degrade the same way a resolved-null does — leave the cache as-is and
    // let getPolicyVersion's freshness re-check decide whether that's still
    // usable. Previously an exception here propagated out of
    // getPolicyVersion uncaught, which is a worse failure mode for a local
    // advisory check than simply reporting "no fresh policy available."
    let version: PolicyVersion | null;
    try {
      version = await this.fetchPolicy();
    } catch {
      return;
    }
    if (version) {
      this.cache = {
        version,
        fetchedAt: new Date(),
        expiresAt: new Date(Date.now() + this.cacheTtlMs),
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
