import { randomUUID } from 'node:crypto';
import crypto from 'node:crypto';
import type { AuditEvent } from '../types';
import type { IDatabase } from '../db/types';

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
    const previousHash = this.getPreviousHash();
    const timestamp = new Date();

    const event: Omit<AuditEvent, 'id' | 'sequence' | 'hash'> = {
      timestamp,
      actor: entry.actor,
      sessionId: entry.sessionId,
      deviceId: entry.deviceId,
      action: entry.action,
      decision: entry.decision,
      policyVersion: entry.policyVersion,
      matchedRules: entry.matchedRules,
      previousHash,
    };

    // Canonicalize: sorted keys, no whitespace variance
    const canonical = this.canonicalize(event);

    // Compute hash: sha256(canonical + previousHash)
    const hash = this.computeHash(canonical);

    const fullEvent: AuditEvent = {
      id: `aud_${randomUUID().replace(/-/g, '')}`,
      sequence: this.getNextSequence(),
      timestamp,
      actor: entry.actor,
      sessionId: entry.sessionId,
      deviceId: entry.deviceId,
      action: entry.action,
      decision: entry.decision,
      policyVersion: entry.policyVersion,
      matchedRules: entry.matchedRules,
      previousHash,
      hash,
    };

    // Store in the audit repository
    await this.db.audit.append(fullEvent);

    return fullEvent;
  }

  /**
   * Get the previous hash (from the last event in the chain).
   */
  private getPreviousHash(): string {
    // This would query the last event's hash in production.
    // For the in-memory store, we need to get the highest sequence.
    const all = this.db.audit.list();
    if (all.length === 0) return '0'.repeat(64);

    const last = all[all.length - 1];
    return last.hash;
  }

  /**
   * Get the next sequence number.
   */
  private async getNextSequence(): Promise<number> {
    const all = await this.db.audit.list();
    if (all.length === 0) return 1;

    const last = all[all.length - 1];
    return last.sequence + 1;
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
    return this.db.audit.list({
      sessionId: options?.sessionId,
      deviceId: options?.deviceId,
      actorType: options?.actorType,
      actorId: options?.actorId,
      decision: options?.decision,
      fromSequence: options?.fromSequence,
      limit: options?.limit,
    });
  }

  /**
   * Verify the hash chain integrity.
   * Returns { valid: boolean, firstBrokenIndex?: number }
   */
  async verifyChain(): Promise<{ valid: boolean; firstBrokenIndex?: number }> {
    const events = await this.db.audit.list({ limit: 10000 });

    for (let i = 0; i < events.length; i++) {
      const evt = events[i]!;
      const expectedPrevHash = i === 0 ? '0'.repeat(64) : events[i - 1]!.hash;

      if (evt.previousHash !== expectedPrevHash) {
        return { valid: false, firstBrokenIndex: i };
      }

      // Recompute hash from canonical form
      const { hash, ...rest } = evt;
      const canonical = this.canonicalize(rest);
      const recomputed = this.computeHash(canonical);

      if (recomputed !== evt.hash) {
        return { valid: false, firstBrokenIndex: i };
      }
    }

    return { valid: true };
  }

  /**
   * Canonicalize an audit event for hashing.
   * Sorts keys, serializes Dates to ISO strings.
   */
  private canonicalize(event: Omit<AuditEvent, 'hash'>): string {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(event).sort();

    for (const key of keys) {
      const value = event[key as keyof typeof event];
      if (value instanceof Date) {
        sorted[key] = value.toISOString();
      } else {
        sorted[key] = value;
      }
    }

    return JSON.stringify(sorted);
  }

  /**
   * Compute SHA256 hash of a canonical string.
   */
  private computeHash(canonical: string): string {
    const data = Buffer.from(canonical, 'utf8');
    const hashBuf = crypto.createHash('sha256').update(data).digest();
    return hashBuf.toString('hex');
  }
}
