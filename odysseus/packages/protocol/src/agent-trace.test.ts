import { describe, expect, it } from 'vitest';

import { addedRanges, buildAgentTrace, murmur3, traceModelId } from './agent-trace';

const DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,4 +1,6 @@',
  ' import x from "x";',
  '+import y from "y";',
  '+import z from "z";',
  ' ',
  '-const a = 1;',
  '+const a = 2;',
  ' export default a;',
  '@@ -20,2 +22,3 @@ function tail() {',
  ' keep();',
  '+added();',
  ' keep();',
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,2 @@',
  '+export const one = 1;',
  '+export const two = 2;',
  'diff --git a/src/gone.ts b/src/gone.ts',
  'deleted file mode 100644',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1,1 +0,0 @@',
  '-bye();',
  'diff --git a/logo.png b/logo.png',
  'Binary files a/logo.png and b/logo.png differ',
].join('\n');

describe('agent trace', () => {
  it('attributes added lines as ranges in the new version of each file', () => {
    expect(
      addedRanges(DIFF).map((file) => ({
        path: file.path,
        ranges: file.ranges.map((range) => [range.start_line, range.end_line]),
      })),
    ).toEqual([
      {
        path: 'src/app.ts',
        ranges: [
          [2, 3],
          [5, 5],
          [23, 23],
        ],
      },
      { path: 'src/new.ts', ranges: [[1, 2]] },
    ]);
  });

  it('hashes each range so it can be found after it moves', () => {
    const [app] = addedRanges(DIFF);
    expect(app!.ranges[0]!.content_hash).toBe(
      `murmur3:${murmur3('import y from "y";\nimport z from "z";')}`,
    );
  });

  it('matches the published MurmurHash3 x86_32 test vectors', () => {
    expect(murmur3('')).toBe('00000000');
    expect(murmur3('hello')).toBe('248bfa47');
    expect(murmur3('The quick brown fox jumps over the lazy dog')).toBe('2e4ff723');
  });

  it('builds a record that follows the 0.1 schema', () => {
    const record = buildAgentTrace({
      id: '550e8400-e29b-41d4-a716-446655440000',
      timestamp: new Date('2026-09-28T10:00:00Z'),
      diff: DIFF,
      contributor: { type: 'ai', model_id: 'anthropic/claude-opus-4-5' },
      conversationUrl: 'https://app.example/sessions/sess_1',
      vcs: { type: 'git', revision: 'a'.repeat(40) },
      tool: { name: 'odysseus', version: '0.1.4' },
      metadata: { 'dev.odysseus': { sessionId: 'sess_1' } },
    });
    expect(record.version).toMatch(/^[0-9]+\.[0-9]+$/);
    expect(record.timestamp).toBe('2026-09-28T10:00:00.000Z');
    expect(record.files[0]).toMatchObject({
      path: 'src/app.ts',
      conversations: [
        {
          url: 'https://app.example/sessions/sess_1',
          contributor: { type: 'ai', model_id: 'anthropic/claude-opus-4-5' },
        },
      ],
    });
    expect(record.files.map((file) => file.path)).toEqual(['src/app.ts', 'src/new.ts']);
  });

  it('names models the models.dev way when the provider is clear', () => {
    expect(traceModelId('claude-code', 'claude-opus-4-5')).toBe('anthropic/claude-opus-4-5');
    expect(traceModelId('codex', 'gpt-5-codex')).toBe('openai/gpt-5-codex');
    expect(traceModelId('opencode', 'anthropic/claude-sonnet-4')).toBe('anthropic/claude-sonnet-4');
    expect(traceModelId('opencode', 'mystery-model')).toBeUndefined();
    expect(traceModelId('claude-code')).toBeUndefined();
  });
});
