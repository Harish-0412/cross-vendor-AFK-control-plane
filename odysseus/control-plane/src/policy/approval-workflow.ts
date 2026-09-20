import type { IDatabase } from '../db/types';
import type { TunnelServer } from '../tunnel/tunnel-server';
import type { ApprovalRecord, SessionRecord } from '../types';

/**
 * §7.3 — Approval workflow state machine.
 *
 * Manages the lifecycle of approval requests:
 * - pending → granted | denied | timeout | superseded
 *
 * Required invariants:
 * - First valid decision wins (CAS — compare-and-swap on status = 'pending')
 * - Expired approvals transition to 'timeout'
 * - Revoked device approvals transition to 'superseded'
 * - Denial with feedback dispatches feedback as session.message (§7.3, §7.4)
 */

export class ApprovalWorkflow {
  private onApprovalCreated?: (approval: ApprovalRecord) => void | Promise<void>;
  constructor(
    private db: IDatabase,
    private tunnelServer: TunnelServer, // §7.4 — required for feedback dispatch
  ) {}

  setOnApprovalCreated(listener: (approval: ApprovalRecord) => void | Promise<void>): void {
    this.onApprovalCreated = listener;
  }

  /**
   * Submit a decision on a pending approval.
   *
   * Uses CAS (compare-and-swap): only succeeds if the approval is still
   * in 'pending' status. Returns the updated record, or null if the
   * approval was already decided (first valid decision wins).
   *
   * @param feedback - Optional corrective instruction when denying.
   *                   When present and approved === false, the feedback text
   *                   is dispatched to the session as a session.message command
   *                   via the TunnelServer (§7.3, §7.4).
   */
  async submitDecision(
    approvalId: string,
    decidedBy: string,
    approved: boolean,
    reason?: string,
    feedback?: string, // §7.3 — new optional field for voice feedback (Hackathon Feature B)
  ): Promise<{ success: boolean; record: ApprovalRecord | null; conflict?: boolean }> {
    // Fetch the current record
    const record = await this.db.approvals.findById(approvalId);
    if (!record) {
      return { success: false, record: null };
    }

    // Check if already decided (CAS — only act on pending)
    if (record.status !== 'pending') {
      // Check for timeout
      if (record.status === 'timeout') {
        return { success: false, record, conflict: false };
      }
      // Check for superseded
      if (record.status === 'superseded') {
        return { success: false, record, conflict: false };
      }
      // Already decided (granted/denied) — first decision wins, return conflict
      return { success: false, record, conflict: true };
    }

    // Check if expired (lazy check — transition to timeout if expired)
    if (record.expiresAt && new Date() > record.expiresAt) {
      await this.db.approvals.update(approvalId, {
        status: 'timeout',
        reason: 'Approval request expired before a decision was made',
      });
      return {
        success: false,
        record: await this.db.approvals.findById(approvalId),
        conflict: false,
      };
    }

    // CAS: update only if still pending
    const decision = approved ? 'granted' : 'denied';
    const updated = await this.db.approvals.update(approvalId, {
      status: decision,
      decidedAt: new Date(),
      decidedBy,
      reason: reason || (approved ? 'Approved by user' : 'Denied by user'),
    });

    if (!updated) {
      // Concurrent modification — someone else decided first
      return {
        success: false,
        record: await this.db.approvals.findById(approvalId),
        conflict: true,
      };
    }

    // §7.3 — Denial with feedback: dispatch feedback as session.message
    // This is NOT a new decision status — it is 'denied' with a side effect.
    // The feedback is sent via the same path POST /sessions/:id/prompt uses.
    if (!approved && feedback && feedback.trim().length > 0) {
      try {
        await this.tunnelServer.sendCommandToDevice(
          record.deviceId,
          'session.message',
          {
            sessionId: record.sessionId,
            message: feedback,
          },
          10_000,
          false, // fire-and-forget — don't block the decision response
        );
      } catch (err) {
        // Log but don't fail the decision — the denial is already recorded
        console.error('[approval-workflow] Failed to dispatch feedback as session.message:', err);
      }
    }

    return { success: true, record: updated };
  }

  /**
   * Transition all pending approvals for a revoked/suspended device to 'superseded'.
   * Called when a device is revoked (§7.3 — revoked device approval handling).
   */
  async revokeDeviceApprovals(deviceId: string, reason: string): Promise<number> {
    // List all approvals by scanning through sessions
    const allSessions = await this.listAllSessions();
    const deviceApprovals: ApprovalRecord[] = [];
    for (const sessionId of allSessions) {
      const sessionApprovals = await this.db.approvals.listBySession(sessionId);
      for (const approval of sessionApprovals) {
        if (approval.deviceId === deviceId && approval.status === 'pending') {
          deviceApprovals.push(approval);
        }
      }
    }

    let count = 0;
    for (const approval of deviceApprovals) {
      await this.db.approvals.update(approval.id, {
        status: 'superseded',
        reason: `Device revoked: ${reason}`,
      });
      count++;
    }

    return count;
  }

  /**
   * Check and transition expired approvals to 'timeout' (lazy evaluation).
   * Called on-read or by a background sweep.
   */
  async expireStaleApprovals(): Promise<number> {
    const allPending = await this.db.approvals.listPending('');
    let count = 0;

    for (const approval of allPending) {
      if (approval.expiresAt && new Date() > approval.expiresAt) {
        await this.db.approvals.update(approval.id, {
          status: 'timeout',
          reason: 'Approval request expired',
        });
        count++;
      }
    }

    return count;
  }

  /**
   * Handle policy change after request (§9.8).
   *
   * When policy changes, re-evaluate the action against the current policy.
   * If the current policy would deny where the request version said require_approval,
   * auto-deny the approval with reason 'policy_superseded'.
   *
   * If the current policy now says allow, leave the pending approval as-is
   * (a human already has it queued; auto-resolving would be worse UX).
   */
  async handlePolicyChange(
    approvalId: string,
    currentPolicyDecision: 'allow' | 'deny' | 'require_approval',
  ): Promise<{ actionTaken: 'none' | 'auto_denied'; record: ApprovalRecord | null }> {
    const record = await this.db.approvals.findById(approvalId);
    if (!record || record.status !== 'pending') {
      return { actionTaken: 'none', record };
    }

    // If current policy says deny, auto-deny the approval
    if (currentPolicyDecision === 'deny') {
      await this.db.approvals.update(approvalId, {
        status: 'denied',
        decidedAt: new Date(),
        decidedBy: 'system',
        reason: 'policy_superseded: current policy denies this action',
      });
      return { actionTaken: 'auto_denied', record: await this.db.approvals.findById(approvalId) };
    }

    // If current policy says allow, leave as-is (human reviewer has it open)
    // If still require_approval, also leave as-is
    return { actionTaken: 'none', record };
  }

  /**
   * Create a new approval request.
   */
  async createApproval(data: {
    sessionId: string;
    deviceId: string;
    userId: string;
    actionType: string;
    description: string;
    details?: Record<string, unknown>;
    policyVersion?: string;
    matchedRules?: string[];
    requiredRole?: 'owner' | 'admin';
    expiresAt?: Date;
  }): Promise<ApprovalRecord> {
    const now = new Date();
    const approval = await this.db.approvals.create({
      sessionId: data.sessionId,
      deviceId: data.deviceId,
      userId: data.userId,
      actionType: data.actionType,
      description: data.description,
      details: data.details,
      status: 'pending',
      policyVersion: data.policyVersion,
      matchedRules: data.matchedRules,
      requiredRole: data.requiredRole,
      expiresAt: data.expiresAt || new Date(now.getTime() + 30 * 60 * 1000), // 30 min default
    });
    await this.onApprovalCreated?.(approval);
    return approval;
  }

  /**
   * Get an approval by ID.
   */
  async getApproval(approvalId: string): Promise<ApprovalRecord | null> {
    return this.db.approvals.findById(approvalId);
  }

  /**
   * List all session IDs (for scanning approvals across all sessions).
   */
  private async listAllSessions(): Promise<string[]> {
    // Access the underlying session store to get all session IDs
    const repo = this.db.sessions as unknown as {
      sessions?: Map<string, SessionRecord>;
    };
    if (repo.sessions) {
      return Array.from(repo.sessions.keys());
    }
    return [];
  }

  /**
   * List pending approvals for a user.
   */
  async getPendingApprovals(userId: string): Promise<ApprovalRecord[]> {
    return this.db.approvals.listPending(userId);
  }

  /**
   * Check if a user can approve (owner or admin role).
   */
  async canUserApprove(userId: string): Promise<boolean> {
    const user = await this.db.users.findById(userId);
    if (!user) return false;
    return user.role === 'admin' || user.role === 'owner';
  }
}
