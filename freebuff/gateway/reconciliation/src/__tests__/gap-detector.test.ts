import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  GapDetector,
  createGapDetector,
} from '../gap-detector';
import type { EventEnvelope } from '@freebuff/protocol';

describe('GapDetector', () => {
  let detector: GapDetector;

  beforeEach(() => {
    detector = createGapDetector();
  });

  it('should classify durable event types correctly', () => {
    expect(detector.isDurable('session.created')).toBe(true);
    expect(detector.isDurable('session.started')).toBe(true);
    expect(detector.isDurable('session.completed')).toBe(true);
    expect(detector.isDurable('session.failed')).toBe(true);
    expect(detector.isDurable('session.approval_granted')).toBe(true);
    expect(detector.isDurable('policy.violation')).toBe(true);
  });

  it('should classify ephemeral event types correctly', () => {
    expect(detector.isDurable('session.output')).toBe(false);
    expect(detector.isDurable('session.thinking')).toBe(false);
    expect(detector.isDurable('session.tool_call')).toBe(false);
    expect(detector.isDurable('session.file_changed')).toBe(false);
  });

  it('should return correct durability classification', () => {
    expect(detector.classifyDurability('session.created')).toBe('durable');
    expect(detector.classifyDurability('session.output')).toBe('ephemeral');
    expect(detector.classifyDurability('unknown.event')).toBe('ephemeral');
  });

  it('should detect no gaps when all sequences present', () => {
    const analysis = detector.analyzeSequences(1, 5, [1, 2, 3, 4, 5]);
    expect(analysis.gaps).toHaveLength(0);
    expect(analysis.missingSequences).toHaveLength(0);
    expect(analysis.replayableRange).toEqual({ from: 1, to: 5 });
  });

  it('should detect single missing sequence', () => {
    const analysis = detector.analyzeSequences(1, 5, [1, 2, 4, 5]);
    expect(analysis.missingSequences).toEqual([3]);
    expect(analysis.gaps).toHaveLength(1);
    expect(analysis.gaps[0].fromSequence).toBe(3);
    expect(analysis.gaps[0].toSequence).toBe(3);
    expect(analysis.gaps[0].reason).toContain('1');
  });

  it('should detect consecutive missing sequences as single gap', () => {
    const analysis = detector.analyzeSequences(1, 10, [1, 2, 8, 9, 10]);
    expect(analysis.missingSequences).toEqual([3, 4, 5, 6, 7]);
    expect(analysis.gaps).toHaveLength(1);
    expect(analysis.gaps[0].fromSequence).toBe(3);
    expect(analysis.gaps[0].toSequence).toBe(7);
  });

  it('should detect multiple non-consecutive gaps', () => {
    const analysis = detector.analyzeSequences(1, 10, [1, 4, 7, 10]);
    expect(analysis.gaps.length).toBeGreaterThanOrEqual(2);
    expect(analysis.globalSequenceGap).toBeDefined();
    expect(analysis.globalSequenceGap!.from).toBe(2);
    expect(analysis.globalSequenceGap!.to).toBe(9);
  });

  it('should handle empty range (from > to)', () => {
    const analysis = detector.analyzeSequences(5, 3, []);
    expect(analysis.gaps).toHaveLength(0);
    expect(analysis.missingSequences).toHaveLength(0);
  });

  it('should analyze per session', () => {
    const ranges = new Map([
      ['session-a', { expectedFrom: 1, expectedTo: 5, actual: [1, 2, 3, 4, 5] }],
      ['session-b', { expectedFrom: 1, expectedTo: 5, actual: [1, 5] }],
    ]);
    const perSession = detector.analyzeBySession(ranges);

    expect(perSession.get('session-a')!.gaps).toHaveLength(0);
    expect(perSession.get('session-b')!.gaps).toHaveLength(1);
    expect(perSession.get('session-b')!.gaps[0].sessionId).toBe('session-b');
  });

  it('should find replayable window when no gaps', () => {
    const globalAnalysis = detector.analyzeSequences(1, 5, [1, 2, 3, 4, 5]);
    const perSession = new Map([
      ['s1', detector.analyzeSequences(1, 5, [1, 2, 3, 4, 5])],
    ]);
    const window = detector.findReplayableWindow(perSession, globalAnalysis);
    expect(window.canReplayGlobally).toBe(true);
    expect(window.firstGapAt).toBeNull();
  });

  it('should find replayable window with gaps', () => {
    const globalAnalysis = detector.analyzeSequences(1, 10, [1, 2, 7, 8, 9, 10]);
    const perSession = new Map<string, ReturnType<typeof detector.analyzeSequences>>();
    const window = detector.findReplayableWindow(perSession, globalAnalysis);
    expect(window.canReplayGlobally).toBe(false);
    expect(window.firstGapAt).toBe(3);
    expect(window.replayableUpTo).toBe(2);
  });

  it('should merge gaps from global and per-session', () => {
    const globalGaps = [{
      sessionId: null, fromSequence: 1, toSequence: 2,
      reason: 'test', reportedAt: new Date(),
    }];
    const perSessionGaps = new Map([
      ['s1', [{
        sessionId: 's1', fromSequence: 5, toSequence: 7,
        reason: 'test', reportedAt: new Date(),
      }]],
    ]);
    const merged = detector.mergeGaps(globalGaps, perSessionGaps);
    expect(merged).toHaveLength(2);
    expect(merged[0].fromSequence).toBe(1);
    expect(merged[1].fromSequence).toBe(5);
  });
});
