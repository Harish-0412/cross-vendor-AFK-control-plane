import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GatewayOptions } from '@odysseus/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { createGateway, type GatewayImpl } from '../src/gateway';
import { SessionJournal } from '../src/session-journal';

const journalFile = () => join(mkdtempSync(join(tmpdir(), 'odysseus-journal-')), 'sessions.json');
const options: GatewayOptions = {
  sandboxEnabled: false,
  apiServer: { enabled: false },
  logLevel: 'error',
};

type CommandResult = { success: boolean; result?: unknown; error?: string };
const command = (
  gateway: GatewayImpl,
  commandType: string,
  payload: Record<string, unknown> = {},
) =>
  (
    gateway as unknown as { handleTunnelCommand(command: unknown): Promise<CommandResult> }
  ).handleTunnelCommand({ commandType, payload });

async function until(check: () => Promise<boolean> | boolean, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out');
}

describe('session journal', () => {
  it('survives the process: a new journal on the same file sees what the old one wrote', async () => {
    const file = journalFile();
    const first = new SessionJournal(file);
    await first.record({
      sessionId: 's1',
      adapter: 'claude-code',
      projectRoot: '/p',
      prompt: 'task',
      startedAt: '2026-09-28T10:00:00Z',
    });
    await first.setNativeSessionId('s1', 'claude-session-1234');

    const afterRestart = new SessionJournal(file);
    expect(await afterRestart.list()).toEqual([
      expect.objectContaining({
        sessionId: 's1',
        nativeSessionId: 'claude-session-1234',
        prompt: 'task',
      }),
    ]);
  });

  it('hands over interrupted sessions once, keeping ones still running', async () => {
    const journal = new SessionJournal(journalFile());
    for (const id of ['old', 'live'])
      await journal.record({
        sessionId: id,
        adapter: 'codex',
        projectRoot: '/p',
        startedAt: '2026-09-28T10:00:00Z',
      });
    expect(
      (await journal.takeInterrupted(new Set(['live']))).map((entry) => entry.sessionId),
    ).toEqual(['old']);
    expect(await journal.takeInterrupted(new Set(['live']))).toEqual([]);
    expect((await journal.list()).map((entry) => entry.sessionId)).toEqual(['live']);
  });
});

describe('gateway with a session journal', () => {
  let gateway: GatewayImpl | undefined;
  afterEach(async () => {
    await gateway?.shutdown(false, 2000).catch(() => undefined);
    gateway = undefined;
  });

  it('forgets a session that ends while the gateway keeps running', async () => {
    const journal = new SessionJournal(journalFile());
    gateway = createGateway(options);
    gateway.setSessionJournal(journal);
    await gateway.createSession({
      projectRoot: process.cwd(),
      adapter: 'mock',
      prompt: 'a task',
      metadata: { sessionId: 'sess_done', scenario: 'simple', delayMs: 5_000 },
    });
    await until(async () => (await journal.list()).length === 1);
    // Stopped by the person, not by the gateway going down: nothing to continue.
    await gateway.stopSession('sess_done', 'Stopped from the web app');
    await until(async () => (await journal.list()).length === 0);
  });

  it('keeps a session the gateway was cut off from, and reports it after a restart', async () => {
    const file = journalFile();
    gateway = createGateway(options);
    gateway.setSessionJournal(new SessionJournal(file));
    await gateway.createSession({
      projectRoot: process.cwd(),
      adapter: 'mock',
      prompt: 'long task',
      metadata: { sessionId: 'sess_cut', scenario: 'simple', delayMs: 5_000 },
    });
    await until(async () => (await new SessionJournal(file).list()).length === 1);
    await gateway.shutdown(true, 2000);
    gateway = undefined;

    // The next run of the gateway, after the restart.
    gateway = createGateway(options);
    gateway.setSessionJournal(new SessionJournal(file));
    const reply = await command(gateway, 'session.interrupted');
    expect(reply).toMatchObject({
      success: true,
      result: {
        interrupted: [
          expect.objectContaining({ sessionId: 'sess_cut', adapter: 'mock', prompt: 'long task' }),
        ],
        active: [],
      },
    });
    // Reported once.
    expect(await command(gateway, 'session.interrupted')).toMatchObject({
      result: { interrupted: [] },
    });
  });

  it('forgets everything when the person cancels on purpose', async () => {
    const file = journalFile();
    gateway = createGateway(options);
    gateway.setSessionJournal(new SessionJournal(file));
    await gateway.createSession({
      projectRoot: process.cwd(),
      adapter: 'mock',
      metadata: { sessionId: 'sess_cancel', scenario: 'simple', delayMs: 5_000 },
    });
    await until(async () => (await new SessionJournal(file).list()).length === 1);
    await gateway.forgetRunningSessions();
    expect(await new SessionJournal(file).list()).toEqual([]);
  });
});
