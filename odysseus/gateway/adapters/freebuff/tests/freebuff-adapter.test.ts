/**
 * The Freebuff adapter against a stand-in terminal program run through a real
 * pseudo-terminal. The stand-in behaves like Freebuff where the adapter relies
 * on it (TTY required, bracketed paste, animated work, files edited in --cwd),
 * so these tests exercise the actual PTY, terminal emulation, paste, and the
 * "screen went quiet" end-of-turn rule.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EventEnvelope } from '@odysseus/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { extractAnswer, FreebuffAdapter } from '../src/freebuff-adapter';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-freebuff.mjs');

function adapter(): FreebuffAdapter {
  return new FreebuffAdapter({
    command: { command: process.execPath, prefixArgs: [fixture] },
    readyQuietMs: 300,
    doneQuietMs: 800,
    pollMs: 100,
    readyTimeoutMs: 10_000,
  });
}

async function collect(freebuff: FreebuffAdapter, id: string): Promise<EventEnvelope[]> {
  const events: EventEnvelope[] = [];
  for await (const event of freebuff.streamEvents(id)) events.push(event);
  return events;
}

describe('FreebuffAdapter', () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'odysseus-freebuff-'));
    execFileSync('git', ['init', '-q'], { cwd: project });
  });
  afterEach(() => {
    // The terminal child keeps the folder as its working directory until it exits.
    rmSync(project, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  });

  it('types a multi-line prompt, waits for the screen to settle and reports the answer and files', async () => {
    const freebuff = adapter();
    const id = await freebuff.startSession({
      projectRoot: project,
      adapter: 'freebuff',
      prompt: 'You are a BUILDER.\nWRITE the file.\nThird line.',
    });
    const events = await collect(freebuff, id);
    const types = events.map((event) => event.eventType);

    expect(types[0]).toBe('session.started');
    expect(types.at(-1)).toBe('session.completed');
    // One paste, not three Enters: the program saw all three lines as one prompt.
    const answer = events.find(
      (event) =>
        event.eventType === 'session.message' &&
        (event.payload as { role: string }).role === 'assistant',
    )?.payload as { content: string };
    expect(answer.content).toContain('I read 3 line(s)');
    expect(answer.content).not.toContain('You are a BUILDER.');
    expect(
      events.find((event) => event.eventType === 'session.file_changed')?.payload,
    ).toMatchObject({ path: 'answer.txt', action: 'created' });
    expect(await freebuff.getState(id)).toBe('completed');
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    await freebuff.shutdown();
  }, 30_000);

  it('fails with instructions when Freebuff asks to sign in', async () => {
    const freebuff = adapter();
    const id = await freebuff.startSession({
      projectRoot: project,
      adapter: 'freebuff',
      prompt: 'anything',
      env: { FAKE_LOGIN: '1' },
    });
    const events = await collect(freebuff, id);
    const failed = events.find((event) => event.eventType === 'session.failed');
    expect((failed?.payload as { error: string }).error).toContain('sign in');
    expect(await freebuff.getState(id)).toBe('failed');
    await freebuff.shutdown();
  }, 30_000);

  it('can be cancelled mid-turn', async () => {
    const freebuff = adapter();
    const id = await freebuff.startSession({
      projectRoot: project,
      adapter: 'freebuff',
      prompt: 'x',
    });
    await freebuff.abortSession(id, 'stop');
    const events = await collect(freebuff, id);
    expect(events.map((event) => event.eventType)).toContain('session.cancelled');
    expect(await freebuff.getState(id)).toBe('cancelled');
    await freebuff.shutdown();
  }, 30_000);

  it('reports itself as not installed when the command is missing', async () => {
    const missing = new FreebuffAdapter({ binaryPath: 'definitely-not-freebuff-xyz' });
    expect((await missing.installOrDetect()).success).toBe(false);
    expect(missing.metadata().capabilities.approvalInterception).toBe('unsupported');
  });
});

describe('extractAnswer', () => {
  it('keeps only what appeared after the prompt, without the echoed prompt', () => {
    expect(
      extractAnswer(
        'Freebuff\n> ',
        'Freebuff\n> \nfix the bug\nFixed it in a.ts\n> ',
        'fix the bug',
      ),
    ).toBe('Fixed it in a.ts');
  });
});
