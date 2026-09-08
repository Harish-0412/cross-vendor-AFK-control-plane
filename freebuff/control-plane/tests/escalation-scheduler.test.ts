import { afterEach, describe, expect, it, vi } from 'vitest';

import { EscalationScheduler } from '../src/afk/escalation-scheduler';
import { MemoryDatabase } from '../src/db/memory-store';

describe('Subphase 7.4 approval escalation scheduler', () => {
  afterEach(() => vi.useRealTimers());

  it('delivers exactly one reminder at the midpoint and rebuilds it after restart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T00:00:00Z'));
    const db = new MemoryDatabase();
    const approval = await db.approvals.create({
      sessionId: 'sess_1', deviceId: 'dev_1', userId: 'usr_1', actionType: 'git.push',
      description: 'git push to production', status: 'pending',
      expiresAt: new Date(Date.now() + 1_000),
    });
    const sender = { sendToUser: vi.fn().mockResolvedValue([]) };
    const firstProcess = new EscalationScheduler(db, sender);
    await firstProcess.schedule(approval);
    firstProcess.close();

    const restarted = new EscalationScheduler(db, sender);
    await restarted.reconcile();
    await vi.advanceTimersByTimeAsync(500);
    expect(sender.sendToUser).toHaveBeenCalledTimes(1);
    expect(sender.sendToUser).toHaveBeenCalledWith('usr_1', expect.objectContaining({
      title: 'Approval still waiting: git push to production',
    }));
    expect((await db.approvals.findById(approval.id))?.reminderSentAt).toBeInstanceOf(Date);

    await vi.advanceTimersByTimeAsync(500);
    expect(sender.sendToUser).toHaveBeenCalledTimes(1);
    restarted.close();
  });

  it('does not notify when the approval has already reached a terminal state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T00:00:00Z'));
    const db = new MemoryDatabase();
    const approval = await db.approvals.create({
      sessionId: 'sess_2', deviceId: 'dev_2', userId: 'usr_2', actionType: 'process.exec',
      description: 'deploy', status: 'pending', expiresAt: new Date(Date.now() + 1_000),
    });
    const sender = { sendToUser: vi.fn().mockResolvedValue([]) };
    const scheduler = new EscalationScheduler(db, sender);
    await scheduler.schedule(approval);
    await db.approvals.update(approval.id, { status: 'granted', decidedAt: new Date() });
    await vi.advanceTimersByTimeAsync(500);
    expect(sender.sendToUser).not.toHaveBeenCalled();
    scheduler.close();
  });
});
