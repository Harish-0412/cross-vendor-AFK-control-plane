import type {
  Capability,
  Decision,
  PolicyEvaluationContext,
  PolicyRule,
  PolicyVersion,
  RiskClass,
  TrustProfile,
} from '@freebuff/protocol';
import { evaluate } from '@freebuff/policy-engine';
import type { IDatabase } from '../db/types';
import type { ControlPlaneConfig } from '../types';
import { AuditLog } from './audit-log';

/**
 * §7 — Policy Engine Service.
 *
 * Wraps packages/policy-engine's evaluate() with I/O:
 * - Loads the current PolicyVersion from the policy store
 * - Checks device status from the device repository
 * - Resolves the decision
 * - Records the evaluation in the audit log
 *
 * This is the ONLY caller of evaluate() on the control-plane side.
 * The Gateway imports evaluate() directly from @freebuff/policy-engine
 * for its local advisory cache (§5).
 */

export class PolicyEngineService {
  constructor(
    private db: IDatabase,
    _config: ControlPlaneConfig,
    private auditLog: AuditLog,
  ) {}

  /**
   * Evaluate a proposed action against the current policy.
   *
   * This is the authoritative evaluation — the result is recorded in the
   * audit log and actually gates whether a HIGH/CRITICAL command is
   * forwarded down the tunnel to the Gateway or blocked at the API layer.
   */
  async evaluate(
    capability: Capability,
    riskClass: 'low' | 'medium' | 'high' | 'critical',
    context: {
      resource?: string;
      projectId?: string;
      deviceId: string;
      sessionId?: string;
      userId: string;
    },
  ): Promise<Decision> {
    // Load the current policy version
    const policyVersion = await this.loadCurrentPolicyVersion();

    // Check device status
    const device = await this.db.devices.findById(context.deviceId);
    const session = context.sessionId
      ? await this.db.sessions.findById(context.sessionId)
      : null;
    const deviceStatus: 'trusted' | 'revoked' | 'suspended' =
      device?.status === 'trusted' || device?.status === 'pairing'
        ? 'trusted'
        : device?.status === 'revoked'
          ? 'revoked'
          : device?.status === 'suspended'
            ? 'suspended'
            : 'trusted'; // default to trusted if device not found

    // Build the evaluation context
    const evalContext: PolicyEvaluationContext = {
      capability,
      riskClass,
      ...(context.resource ? { resource: context.resource } : {}),
      ...(context.projectId ? { projectId: context.projectId } : {}),
      trustProfile: session?.trustProfile ?? device?.defaultTrustProfile ?? 'default',
      deviceStatus,
      userId: context.userId,
    };

    // Run the pure evaluation function
    const decision = evaluate(evalContext, policyVersion);

    // Record in audit log
    await this.auditLog.record({
      actor: { type: 'device', id: context.deviceId },
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      deviceId: context.deviceId,
      action: capability,
      decision: decision.decision === 'allow' ? 'allow' : decision.decision === 'deny' ? 'deny' : 'require_approval',
      policyVersion: decision.policyVersion,
      ...('matchedRules' in decision && decision.matchedRules
        ? { matchedRules: decision.matchedRules }
        : {}),
    });

    return decision;
  }

  /**
   * Evaluate with explicit policy version (for testing and for the
   * "policy change after request" scenario).
   */
  evaluateWithVersion(
    capability: Capability,
    riskClass: 'low' | 'medium' | 'high' | 'critical',
    policyVersion: PolicyVersion | null,
    context: {
      resource?: string;
      projectId?: string;
      trustProfile: TrustProfile;
      deviceStatus: 'trusted' | 'revoked' | 'suspended';
      userId: string;
    },
  ): Decision {
    const evalContext: PolicyEvaluationContext = {
      capability,
      riskClass,
      ...(context.resource ? { resource: context.resource } : {}),
      ...(context.projectId ? { projectId: context.projectId } : {}),
      trustProfile: context.trustProfile,
      deviceStatus: context.deviceStatus,
      userId: context.userId,
    };

    return evaluate(evalContext, policyVersion);
  }

  /**
   * Load the current active policy version from the policy store.
   */
  private async loadCurrentPolicyVersion(): Promise<PolicyVersion | null> {
    // Try to load from our policy store (uses the users table for storage in dev)
    const allUsers = await this.db.users.list();
    const policyEntries = allUsers.filter((u) => u.metadata?._policyVersion);

    for (const entry of policyEntries) {
      const pv = entry.metadata!._policyVersion as PolicyVersion;
      if (pv.isActive) {
        return pv;
      }
    }

    // If no active version, return a default "empty" policy version
    // that just uses risk-class defaults
    return {
      id: 'p_default',
      version: 'p_default',
      description: 'Default policy (no custom rules — uses risk class defaults)',
      rules: [],
      createdAt: new Date(),
      createdBy: 'system',
      isActive: true,
    };
  }

  /**
   * Create a new policy version.
   */
  async createPolicyVersion(
    createdBy: string,
    description: string,
    rules: Array<{
      id: string;
      description: string;
      match: {
        capability?: Capability;
        riskClass?: RiskClass;
        resourcePattern?: string;
        projectId?: string;
        trustProfile?: TrustProfile;
      };
      effect: 'allow' | 'deny' | 'require_approval';
      requiredRole?: 'owner' | 'admin';
      priority: number;
    }>,
  ): Promise<PolicyVersion> {
    const now = new Date();
    const id = `p_${randomUUID().replace(/-/g, '')}`;
    const allUsers = await this.db.users.list();
    const versionNumber = allUsers.filter((user) => user.metadata?._policyVersion).length + 1;

    const version: PolicyVersion = {
      id,
      version: `p_${versionNumber}`,
      description,
      rules: rules as PolicyRule[],
      createdAt: now,
      createdBy,
      isActive: false,
    };

    // Store in users table (dev/memory store pattern)
    await this.db.users.create({
      email: `__policy_${id}__`,
      passwordHash: '',
      name: `Policy Version ${versionNumber}`,
      role: 'admin',
      metadata: {
        _policyVersion: version,
      },
    });

    // Record in audit log
    await this.auditLog.record({
      actor: { type: 'user', id: createdBy },
      action: 'policy.version_created',
      decision: 'allow',
      policyVersion: version.version,
    });

    return version;
  }

  /**
   * Activate a policy version (makes it the current active version).
   */
  async activatePolicyVersion(versionId: string, activatedBy: string): Promise<PolicyVersion | null> {
    const allUsers = await this.db.users.list();
    const policyEntries = allUsers.filter((u) => u.metadata?._policyVersion);

    // Deactivate all, then activate the target
    for (const entry of policyEntries) {
      const pv = entry.metadata!._policyVersion as PolicyVersion;
      const updated = { ...pv, isActive: pv.id === versionId };

      const user = await this.db.users.findByEmail(`__policy_${pv.id}__`);
      if (user) {
        await this.db.users.update(user.id, {
          metadata: {
            ...user.metadata,
            _policyVersion: updated,
          },
        });
      }
    }

    // Get the activated version
    const targetEntry = policyEntries.find((entry) =>
      (entry.metadata?._policyVersion as PolicyVersion | undefined)?.id === versionId,
    );
    if (!targetEntry) return null;

    const activatedVersion = targetEntry.metadata!._policyVersion as PolicyVersion;

    // Record in audit log
    await this.auditLog.record({
      actor: { type: 'user', id: activatedBy },
      action: 'policy.version_activated',
      decision: 'allow',
      policyVersion: activatedVersion.version,
    });

    return { ...activatedVersion, isActive: true };
  }

  /**
   * Get the active policy version.
   */
  async getActivePolicyVersion(): Promise<PolicyVersion | null> {
    const allUsers = await this.db.users.list();
    const policyEntries = allUsers.filter((u) => u.metadata?._policyVersion);

    for (const entry of policyEntries) {
      const pv = entry.metadata!._policyVersion as PolicyVersion;
      if (pv.isActive) {
        return pv;
      }
    }

    return null;
  }

  /**
   * Get a policy version by ID.
   */
  async getPolicyVersionById(versionId: string): Promise<PolicyVersion | null> {
    const allUsers = await this.db.users.list();
    const policyEntries = allUsers.filter((u) => u.metadata?._policyVersion);

    for (const entry of policyEntries) {
      const pv = entry.metadata!._policyVersion as PolicyVersion;
      if (pv.id === versionId) {
        return pv;
      }
    }

    return null;
  }

  async canManagePolicy(userId: string): Promise<boolean> {
    const user = await this.db.users.findById(userId);
    return user?.role === 'admin' || user?.role === 'owner';
  }
}

import { randomUUID } from 'node:crypto';
