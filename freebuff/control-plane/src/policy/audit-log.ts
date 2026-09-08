import type { IDatabase } from '../db/types';
import type { AuditEvent } from '../types';

/**
 * §8 — Audit Subsystem.
 *
 * Hash-chained, tamper-evident audit log.
 * Single writer, append-only.
 *
 * Every policy evaluation, approval decision, and device pairing/revocation
 * is recorded here. The hash chain makes tampering provable after the fact.
 */

export class AuditLog {
  constructor(private db: IDatabase) {}

  /**
   * Append an audit event to the log.
   * This is the ONLY write path — every module that needs to record something
   * audit-worthy calls this one function.
   */
  async record(entry: {
    actor: { type: 'user' | 'device' | 'system'; id: string };
    sessionId?: string;
    deviceId?: string;
    action: string;
    decision: 'allow' | 'deny' | 'require_approval' | 'granted' | 'denied' | 'timeout';
    policyVersion?: string;
    matchedRules?: string[];
  }): Promise<AuditEvent> {
    // Delegate to the repository — it handles hash computation and chain integrity
    const eventData: Omit<AuditEvent, 'id' | 'sequence' | 'hash' | 'previousHash'> = {
      timestamp: new Date(),
      actor: entry.actor,
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      ...(entry.deviceId ? { deviceId: entry.deviceId } : {}),
      action: entry.action,
      decision: entry.decision,
      ...(entry.policyVersion ? { policyVersion: entry.policyVersion } : {}),
      ...(entry.matchedRules ? { matchedRules: entry.matchedRules } : {}),
    };

    // Store in the audit repository (hash computed by repository)
    const stored = await this.db.audit.append(eventData);
    return stored;
  }

  /**
   * List audit events with optional filtering.
   */
  async list(options?: {
    sessionId?: string;
    deviceId?: string;
    actorType?: string;
    actorId?: string;
    decision?: string;
    fromSequence?: number;
    limit?: number;
  }): Promise<AuditEvent[]> {
    return this.db.audit.list(options);
  }

  /**
   * Verify the hash chain integrity.
   * Delegates to the repository's verifyChain which uses the same
   * canonicalization that was used when appending.
   */
  async verifyChain(): Promise<{ valid: boolean; firstBrokenIndex?: number }> {
    return this.db.audit.verifyChain();
  }
}
