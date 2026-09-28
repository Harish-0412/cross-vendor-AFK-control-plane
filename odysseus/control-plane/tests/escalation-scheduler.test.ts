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
  it('hands an unanswered approval to onExpired when its window closes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T00:00:00Z'));
    const db = new MemoryDatabase();
    const approval = await db.approvals.create({
      sessionId: 'sess_3', deviceId: 'dev_3', userId: 'usr_3', actionType: 'git.push',
      description: 'git push', status: 'pending', expiresAt: new Date(Date.now() + 1_000),
    });
    const onExpired = vi.fn();
    const scheduler = new EscalationScheduler(db, { sendToUser: vi.fn().mockResolvedValue([]) }, { onExpired });
    await scheduler.schedule(approval);
    await vi.advanceTimersByTimeAsync(999);
    expect(onExpired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onExpired).toHaveBeenCalledWith(expect.objectContaining({ id: approval.id }));
    scheduler.close();
  });

  it('expires approvals that ran out while the process was down, and skips decided ones', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T00:00:00Z'));
    const db = new MemoryDatabase();
    const stale = await db.approvals.create({
      sessionId: 'sess_4', deviceId: 'dev_4', userId: 'usr_4', actionType: 'git.push',
      description: 'stale', status: 'pending', expiresAt: new Date(Date.now() - 60_000),
    });
    const decided = await db.approvals.create({
      sessionId: 'sess_5', deviceId: 'dev_5', userId: 'usr_5', actionType: 'git.push',
      description: 'decided', status: 'pending', expiresAt: new Date(Date.now() + 1_000),
    });
    const onExpired = vi.fn();
    const scheduler = new EscalationScheduler(db, { sendToUser: vi.fn().mockResolvedValue([]) }, { onExpired });
    await scheduler.reconcile();
    await db.approvals.update(decided.id, { status: 'granted', decidedAt: new Date() });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onExpired.mock.calls.map(([item]) => item.id)).toEqual([stale.id]);
    scheduler.close();
  });
});
