import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AntigravityStreamParser } from '../src/stream-parser';

describe('AntigravityStreamParser', () => {
  it('normalizes stream-json init, tool steps, response and idle result records', () => {
    const parser = new AntigravityStreamParser('sess_agy');
    const events = [
      '{"event":"init","init":{"cwd":"/project"}}',
      '{"event":"step_update","step_update":{"step_id":"step_1","step_type":"tool","state":"ACTIVE","tool_name":"write","tool_info":{"path":"a.ts"}}}',
      '{"event":"step_update","step_update":{"step_id":"step_1","step_type":"tool","state":"DONE","tool_name":"write","tool_info":{"result":"ok"}}}',
      '{"event":"result","result":{"status":"SUCCESS","response":"Done","usage":{"total_tokens":42}}}',
    ].flatMap((line) => parser.parseLine(line).envelopes);
    expect(events.map((event) => event.eventType)).toEqual([
      'session.started',
      'session.tool_call',
      'session.tool_result',
      'session.message',
      'session.status_changed',
    ]);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(events.at(-1)?.payload).toMatchObject({
      state: 'running',
      phase: 'idle',
      usage: { total_tokens: 42 },
    });
  });

  it('replays the captured authenticated Antigravity 1.1.27 stream', async () => {
    const fixture = await readFile(
      fileURLToPath(new URL('./fixtures/live-v1.1.27.ndjson', import.meta.url)),
      'utf8',
    );
    const parser = new AntigravityStreamParser('sess_live');
    const events = fixture
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => parser.parseLine(line).envelopes);
    expect(events.map((event) => event.eventType)).toEqual([
      'session.started',
      'session.status_changed',
      'session.output',
      'session.message',
      'session.status_changed',
    ]);
    expect(events.at(-1)?.payload).toMatchObject({
      state: 'running',
      phase: 'idle',
    });
  });
});
