import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OpenCodeOutputParser } from '../src/output-parser';

describe('OpenCodeOutputParser', () => {
  it('replays the captured OpenCode run stream into the normalized event vocabulary', async () => {
    const fixture = await readFile(fileURLToPath(new URL('./fixtures/opencode-run-v1.18.23.ndjson', import.meta.url)), 'utf8');
    const parser = new OpenCodeOutputParser('sess_freebuff', 'dev_1');
    const events = fixture.split(/\r?\n/).filter(Boolean).map((line) => parser.parseLine(line)).filter((event) => event !== null);
    expect(events.map((event) => event.eventType)).toEqual([
      'session.started', 'session.output', 'session.tool_call', 'session.file_changed', 'session.tool_result', 'session.completed',
    ]);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(events[2]?.payload).toMatchObject({ toolName: 'write', arguments: { path: 'src/greeting.ts' } });
    expect(events[3]?.payload).toMatchObject({ path: 'src/greeting.ts', action: 'modified' });
  });

  it('ignores malformed and unsupported records without breaking the stream', () => {
    const parser = new OpenCodeOutputParser('sess_freebuff');
    expect(parser.parseLine('not json')).toBeNull();
    expect(parser.parseLine('{"type":"future.unknown"}')).toBeNull();
  });
});
