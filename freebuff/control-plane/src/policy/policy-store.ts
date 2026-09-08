import { randomUUID } from 'node:crypto';
import type { PolicyRule, PolicyVersion, TrustProfile } from '@freebuff/protocol';
import type { IDatabase } from '../db/types';

/**
 * §7.1 — Policy store.
 *
 * CRUD for PolicyRule/PolicyVersion. Uses the existing IDatabase pattern
 * (in-memory in dev, Postgres in prod) rather than inventing a new repository.
 *
 * Policy versions are immutable — a "change" is authoring a new version that
 * supersedes the old one. Only one version is active at a time.
 */

export class PolicyStore {
  constructor(private db: IDatabase) {}

  /**
   * Create a new policy version (does not mutate existing versions).
   * The new version is NOT automatically activated — call activateVersion()
   * to make it current.
   */
  async createVersion(
    createdBy: string,
    description: string,
    rules: PolicyRule[],
  ): Promise<PolicyVersion> {
    const now = new Date();
    const id = `p_${randomUUID().replace(/-/g, '')}`;
    const versionNumber = await this.getNextVersionNumber();

    const version: PolicyVersion = {
      id,
      version: `p_${versionNumber}`,
      description,
      rules,
      createdAt: now,
      createdBy,
      isActive: false,
    };

    // Store as a JSON blob in the users table for now (dev/memory store).
    // In production, this would be a dedicated policy_versions table.
    // For the dev store, we serialize to a special user entry.
    await this.db.users.create({
      email: `__policy_${id}__`,
      passwordHash: '',
      name: `Policy Version ${versionNumber}`,
      role: 'admin',
      metadata: {
        _policyVersion: version,
        _policyRules: rules,
      },
    });

    return version;
  }

  /**
   * Get the currently active policy version.
   */
  async getActiveVersion(): Promise<PolicyVersion | null> {
    const all = await this.listVersions();
    return all.find((v) => v.isActive) ?? null;
  }

  /**
   * List all policy versions (most recent first).
   */
  async listVersions(): Promise<PolicyVersion[]> {
    const all = await this.db.users.list();
    const policyVersions: PolicyVersion[] = [];

    for (const user of all) {
      if (user.metadata?._policyVersion) {
        policyVersions.push(user.metadata._policyVersion as PolicyVersion);
      }
    }

    return policyVersions.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  /**
   * Get a specific policy version by ID.
   */
  async getVersionById(id: string): Promise<PolicyVersion | null> {
    const all = await this.listVersions();
    return all.find((v) => v.id === id) ?? null;
  }

  /**
   * Activate a policy version (atomic swap — only one active at a time).
   */
  async activateVersion(versionId: string, activatedBy: string): Promise<PolicyVersion | null> {
    void activatedBy;
    const versions = await this.listVersions();
    const target = versions.find((v) => v.id === versionId);
    if (!target) return null;

    // Deactivate all, then activate the target
    for (const v of versions) {
      const user = await this.db.users.findByEmail(`__policy_${v.id}__`);
      if (user) {
        await this.db.users.update(user.id, {
          metadata: {
            ...user.metadata,
            _policyVersion: {
              ...v,
              isActive: v.id === versionId,
            },
          },
        });
      }
    }

    return this.getVersionById(versionId);
  }

  /**
   * Get the next version number for a new policy version.
   */
  private async getNextVersionNumber(): Promise<number> {
    const versions = await this.listVersions();
    if (versions.length === 0) return 1;

    const maxVersion = Math.max(
      ...versions.map((v) => {
        const num = parseInt(v.version.replace(/^p_/, ''), 10);
        return Number.isNaN(num) ? 0 : num;
      }),
    );

    return maxVersion + 1;
  }

  /**
   * Evaluate an action against the current policy version.
   * Returns the decision and the policy version used.
   */
  async evaluate(
    context: {
      capability: string;
      riskClass: string;
      resource?: string;
      projectId?: string;
      trustProfile: TrustProfile;
      deviceStatus: 'trusted' | 'revoked' | 'suspended';
      userId: string;
    },
    policyVersion: PolicyVersion | null,
  ): Promise<{
    decision: 'allow' | 'deny' | 'require_approval';
    policyVersion: string;
    reason?: string;
    requiredRole?: 'owner' | 'admin';
    expiresAt?: Date;
    matchedRules?: string[];
  }> {
    const { evaluate } = require('@freebuff/policy-engine');
    const pv = policyVersion ?? await this.getActiveVersion();

    const result = evaluate(
      {
        capability: context.capability as never,
        riskClass: context.riskClass as never,
        resource: context.resource,
        projectId: context.projectId,
        trustProfile: context.trustProfile,
        deviceStatus: context.deviceStatus,
        userId: context.userId,
      },
      pv,
    );

    return {
      decision: result.decision,
      policyVersion: result.policyVersion,
      reason: 'reason' in result ? result.reason : undefined,
      requiredRole: 'requiredRole' in result ? result.requiredRole : undefined,
      expiresAt: 'expiresAt' in result ? result.expiresAt : undefined,
      matchedRules: 'matchedRules' in result ? result.matchedRules : undefined,
    };
  }

  /**
   * Check if a user is authorized to manage policy (owner or admin).
   */
  async canManagePolicy(userId: string): Promise<boolean> {
    const user = await this.db.users.findById(userId);
    if (!user) return false;
    return user.role === 'admin' || user.role === 'owner';
  }

  /**
   * Check if a user is authorized to approve actions (owner or admin).
   */
  async canApprove(userId: string): Promise<boolean> {
    const user = await this.db.users.findById(userId);
    if (!user) return false;
    return user.role === 'admin' || user.role === 'owner';
  }
}
