import type { ApprovalRecord } from '../types';
import type { IDatabase } from '../db/types';
import { approvalReminderNotification, type PushNotification } from './notification-templates';

export interface ApprovalPushSender {
  sendToUser(userId: string, notification: PushNotification): Promise<unknown>;
}

export interface EscalationSchedulerOptions {
  /** Optional hook for a future email/Slack escalation at 80% of the approval window. */
  onFallbackDue?: (approval: ApprovalRecord) => Promise<void> | void;
}

/**
 * Persists delivery checkpoints on the approval record, while keeping only the
 * timers in memory. A fresh process can therefore rebuild its timers without
 * sending the same reminder twice.
 */
export class EscalationScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout[]>();

  constructor(
    private readonly db: IDatabase,
    private readonly pushSender: ApprovalPushSender,
    private readonly options: EscalationSchedulerOptions = {},
  ) {}

  async reconcile(): Promise<void> {
    const pending = await this.db.approvals.listAllPending();
    await Promise.all(pending.map((approval) => this.schedule(approval)));
  }

  async schedule(approval: ApprovalRecord): Promise<void> {
    this.cancel(approval.id);
    if (approval.status !== 'pending' || !approval.expiresAt) return;

    const windowMs = approval.expiresAt.getTime() - approval.requestedAt.getTime();
    if (windowMs <= 0) return;

    const now = Date.now();
    const reminderAt = approval.requestedAt.getTime() + windowMs * 0.5;
    const fallbackAt = approval.requestedAt.getTime() + windowMs * 0.8;
    const timers: NodeJS.Timeout[] = [];

    if (!approval.reminderSentAt && now < approval.expiresAt.getTime()) {
      timers.push(this.setTimer(Math.max(0, reminderAt - now), () => this.sendReminder(approval.id)));
    }
    if (this.options.onFallbackDue && !approval.fallbackTriggeredAt && now < approval.expiresAt.getTime()) {
      timers.push(this.setTimer(Math.max(0, fallbackAt - now), () => this.triggerFallback(approval.id)));
    }
    if (timers.length > 0) this.timers.set(approval.id, timers);
  }

  cancel(approvalId: string): void {
    for (const timer of this.timers.get(approvalId) ?? []) clearTimeout(timer);
    this.timers.delete(approvalId);
  }

  close(): void {
    for (const approvalId of this.timers.keys()) this.cancel(approvalId);
  }

  private setTimer(delayMs: number, callback: () => Promise<void>): NodeJS.Timeout {
    const timer = setTimeout(() => {
      void callback().catch(() => undefined);
    }, delayMs);
    timer.unref?.();
    return timer;
  }

  private async sendReminder(approvalId: string): Promise<void> {
    const approval = await this.db.approvals.findById(approvalId);
    if (!approval || approval.status !== 'pending' || approval.reminderSentAt) return;
    if (!approval.expiresAt || Date.now() >= approval.expiresAt.getTime()) return;

    const marked = await this.db.approvals.update(approval.id, { reminderSentAt: new Date() });
    if (!marked) return;
    await this.pushSender.sendToUser(marked.userId, approvalReminderNotification(marked));
  }

  private async triggerFallback(approvalId: string): Promise<void> {
    const approval = await this.db.approvals.findById(approvalId);
    if (!approval || approval.status !== 'pending' || approval.fallbackTriggeredAt) return;
    if (!approval.expiresAt || Date.now() >= approval.expiresAt.getTime()) return;
    const marked = await this.db.approvals.update(approval.id, { fallbackTriggeredAt: new Date() });
    if (marked) await this.options.onFallbackDue?.(marked);
  }
}
