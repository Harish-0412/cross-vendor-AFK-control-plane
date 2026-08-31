import type { EventEnvelope } from '@freebuff/protocol';
import type {
  UnrecoverableGap,
  GapAnalysis,
  DurableEventClassification,
} from './types';
import { DURABLE_EVENT_TYPES } from './types';

export class GapDetector {
  private readonly durableEventTypes: Set<string>;
  private readonly ephemeralToleranceWindowMs: number;

  constructor(
    durableClassifications: DurableEventClassification[] = DURABLE_EVENT_TYPES,
    ephemeralToleranceWindowMs = 0,
  ) {
    this.durableEventTypes = new Set(
      durableClassifications
        .filter((c) => c.durability === 'durable')
        .map((c) => c.eventType),
    );
    this.ephemeralToleranceWindowMs = ephemeralToleranceWindowMs;
  }

  isDurable(eventType: string): boolean {
    return this.durableEventTypes.has(eventType);
  }

  classifyDurability(eventType: string): 'durable' | 'ephemeral' {
    return this.isDurable(eventType) ? 'durable' : 'ephemeral';
  }

  analyzeSequences(
    expectedFrom: number,
    expectedTo: number,
    actualSequences: number[],
    options: {
      onlyDurable?: boolean;
      events?: EventEnvelope[];
    } = {},
  ): GapAnalysis {
    const analysis: GapAnalysis = {
      gaps: [],
      missingSequences: [],
    };

    if (expectedFrom > expectedTo) {
      return analysis;
    }

    const presentSet = new Set(actualSequences);
    const missing: number[] = [];
    for (let seq = expectedFrom; seq <= expectedTo; seq++) {
      if (!presentSet.has(seq)) {
        missing.push(seq);
      }
    }

    analysis.missingSequences = missing;

    if (missing.length === 0) {
      analysis.replayableRange = { from: expectedFrom, to: expectedTo };
      return analysis;
    }

    const runs: Array<{ from: number; to: number }> = [];
    let current: { from: number; to: number } | null = null;
    for (const seq of missing) {
      if (!current) {
        current = { from: seq, to: seq };
      } else if (seq === current.to + 1) {
        current.to = seq;
      } else {
        runs.push(current);
        current = { from: seq, to: seq };
      }
    }
    if (current) runs.push(current);

    for (const run of runs) {
      const runSize = run.to - run.from + 1;
      const eventsInRun: EventEnvelope[] = [];
      if (options.events) {
        for (const evt of options.events) {
          if (evt.sequence >= run.from && evt.sequence <= run.to) {
            eventsInRun.push(evt);
          }
        }
      }

      const hasDurable =
        eventsInRun.length === 0 || eventsInRun.some((e) => this.isDurable(e.eventType));

      if (options.onlyDurable && !hasDurable) {
        continue;
      }

      const typesAffected = [...new Set(eventsInRun.map((e) => e.eventType))];

      analysis.gaps.push({
        sessionId: null,
        fromSequence: run.from,
        toSequence: run.to,
        reason: `Missing ${runSize} sequences`,
        reportedAt: new Date(),
        eventTypesAffected: typesAffected.length > 0 ? typesAffected : undefined,
      });
    }

    if (analysis.gaps.length === 0) {
      analysis.replayableRange = { from: expectedFrom, to: expectedTo };
    } else {
      const firstGapFrom = analysis.gaps[0].fromSequence;
      const lastGapTo = analysis.gaps[analysis.gaps.length - 1].toSequence;
      analysis.globalSequenceGap = { from: firstGapFrom, to: lastGapTo };
    }

    return analysis;
  }

  analyzeBySession(
    sessionRanges: Map<
      string,
      { expectedFrom: number; expectedTo: number; actual: number[]; events?: EventEnvelope[] }
    >,
    onlyDurable = true,
  ): Map<string, GapAnalysis> {
    const perSession: Map<string, GapAnalysis> = new Map();
    for (const [sessionId, info] of sessionRanges.entries()) {
      const analysis = this.analyzeSequences(
        info.expectedFrom,
        info.expectedTo,
        info.actual,
        { onlyDurable, events: info.events },
      );
      for (const gap of analysis.gaps) {
        gap.sessionId = sessionId;
      }
      perSession.set(sessionId, analysis);
    }
    return perSession;
  }

  findReplayableWindow(
    perSession: Map<string, GapAnalysis>,
    globalAnalysis: GapAnalysis,
  ): {
    canReplayGlobally: boolean;
    firstGapAt: number | null;
    replayableUpTo: number | null;
  } {
    let firstGapAt: number | null = null;
    if (globalAnalysis.globalSequenceGap) {
      firstGapAt = globalAnalysis.globalSequenceGap.from;
    }
    for (const analysis of perSession.values()) {
      if (analysis.gaps.length > 0) {
        const minFrom = Math.min(...analysis.gaps.map((g) => g.fromSequence));
        if (firstGapAt === null || minFrom < firstGapAt) {
          firstGapAt = minFrom;
        }
      }
    }
    return {
      canReplayGlobally: firstGapAt === null,
      firstGapAt,
      replayableUpTo: firstGapAt === null ? null : firstGapAt - 1,
    };
  }

  mergeGaps(
    globalGaps: UnrecoverableGap[],
    perSessionGaps: Map<string, UnrecoverableGap[]>,
  ): UnrecoverableGap[] {
    const merged: UnrecoverableGap[] = [...globalGaps];
    for (const gaps of perSessionGaps.values()) {
      for (const gap of gaps) {
        merged.push(gap);
      }
    }
    return merged.sort(
      (a, b) => a.fromSequence - b.fromSequence,
    );
  }
}

export function createGapDetector(): GapDetector {
  return new GapDetector();
}
