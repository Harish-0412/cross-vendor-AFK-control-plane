import type {
  EventEnvelope,
  SessionReconciliationState,
  ReconciliationRequest,
  ReconciliationResponse,
} from '@freebuff/protocol';
import type {
  ReconciliationStep,
  UnrecoverableGap,
  ReplayOptions,
  ReconciliationResult,
  SessionStateProvider,
  SessionUpdateApplier,
  EventStore,
  ReconciliationEventListener,
  ReconciliationEvent,
} from './types';
import { DEFAULT_REPLAY_OPTIONS } from './types';
import { GapDetector, createGapDetector } from './gap-detector';

export interface ReconciliationEngineOptions {
  maxRetryOnReplayError?: number;
  collectMetrics?: boolean;
}

const DEFAULT_ENGINE_OPTIONS: Required<ReconciliationEngineOptions> = {
  maxRetryOnReplayError: 2,
  collectMetrics: true,
};

export class ReconciliationEngine {
  private readonly options: Required<ReconciliationEngineOptions>;
  private readonly gapDetector: GapDetector;
  private readonly stateProvider: SessionStateProvider;
  private readonly updateApplier: SessionUpdateApplier;
  private readonly eventStore: EventStore;
  private _step: ReconciliationStep = 'idle';
  private listeners: Set<ReconciliationEventListener> = new Set();
  private runCount = 0;
  private lastResult: ReconciliationResult | null = null;
  private inFlight = false;
  private gapHistory: UnrecoverableGap[] = [];

  constructor(
    stateProvider: SessionStateProvider,
    updateApplier: SessionUpdateApplier,
    eventStore: EventStore,
    options: ReconciliationEngineOptions = {},
  ) {
    this.options = { ...DEFAULT_ENGINE_OPTIONS, ...options };
    this.stateProvider = stateProvider;
    this.updateApplier = updateApplier;
    this.eventStore = eventStore;
    this.gapDetector = createGapDetector();
  }

  getStep(): ReconciliationStep {
    return this._step;
  }

  getLastResult(): ReconciliationResult | null {
    return this.lastResult;
  }

  getRunCount(): number {
    return this.runCount;
  }

  getGapHistory(): UnrecoverableGap[] {
    return [...this.gapHistory];
  }

  onEvent(listener: ReconciliationEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  collectSessionStates(): SessionReconciliationState[] {
    return this.stateProvider.listAllSessions().map((s) => ({
      sessionId: s.sessionId,
      lastAckedSequence: s.lastAckedSequence,
      lastEventAt: s.lastEventAt,
      state: s.state,
      lastEventType: s.lastEventType,
    }));
  }

  buildReconciliationRequest(
    deviceId: string,
    gatewayId: string,
    certificateThumbprint: string,
    signFn?: (payload: string) => string,
  ): { request: ReconciliationRequest; signatureBase: string } {
    this.setStep('collecting_state');
    const sessionStates = this.collectSessionStates();
    const lastAcked = this.stateProvider.getLastAckedGlobalSequence();
    const signedAt = new Date();

    const signatureBase = JSON.stringify({
      deviceId,
      gatewayId,
      lastAckedGlobalSequence: lastAcked,
      sessionStatesCount: sessionStates.length,
      certificateThumbprint,
      signedAt: signedAt.toISOString(),
    });

    const signature = signFn ? signFn(signatureBase) : '';

    const request: ReconciliationRequest = {
      deviceId,
      gatewayId,
      lastAckedGlobalSequence: lastAcked,
      sessionStates,
      certificateThumbprint,
      signedAt,
      signature,
    };

    this.setStep('sending_request');
    return { request, signatureBase };
  }

  async processReconciliationResponse(
    response: ReconciliationResponse,
    replayOptions: ReplayOptions = {},
  ): Promise<ReconciliationResult> {
    const startedAt = new Date();
    this.inFlight = true;
    this.runCount++;

    const opts: Required<ReplayOptions> = { ...DEFAULT_REPLAY_OPTIONS, ...replayOptions };
    const warnings: string[] = [];
    const allGaps: UnrecoverableGap[] = [...response.sessionUpdates
      .map((u) => (u.unrecoverableGaps ?? []).map((g) => ({
        sessionId: u.sessionId,
        fromSequence: g.from,
        toSequence: g.to,
        reason: g.reason,
        reportedAt: new Date(),
      })))
      .flat()];
    if (response.globalGapInfo) {
      allGaps.push({
        sessionId: null,
        fromSequence: response.globalGapInfo.from,
        toSequence: response.globalGapInfo.to,
        reason: response.globalGapInfo.reason,
        reportedAt: new Date(),
      });
    }

    for (const gap of allGaps) {
      this.eventStore.recordUnrecoverableGap(gap);
      this.gapHistory.push(gap);
      this.emitEvent({
        type: 'unrecoverable_gap_recorded',
        timestamp: new Date(),
        payload: gap,
        message: `Gap recorded ${gap.sessionId ?? 'global'}: ${gap.fromSequence}-${gap.toSequence}`,
      });
    }

    let eventsReplayed = 0;
    try {
      this.setStep('replaying_events');
      eventsReplayed = await this.replayEvents(response, opts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`Event replay had errors: ${message}`);
      this.emitEvent({
        type: 'warnings_raised',
        timestamp: new Date(),
        payload: { warning: message },
      });
    }

    let updatesApplied = 0;
    try {
      this.setStep('applying_updates');
      updatesApplied = await this.applySessionUpdates(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`Session updates had errors: ${message}`);
    }

    this.setStep('finalizing');

    const result: ReconciliationResult = {
      success: warnings.length === 0 || !opts.haltOnError,
      sessionStatesCollected: response.sessionUpdates.length,
      eventsReplayed,
      sessionUpdatesApplied: updatesApplied,
      unrecoverableGaps: allGaps,
      newAckBaseline: response.newAckBaseline ?? this.stateProvider.getLastAckedGlobalSequence(),
      startedAt,
      completedAt: new Date(),
      error: warnings.length > 0 && opts.haltOnError ? warnings.join('; ') : undefined,
      warnings,
    };

    this.lastResult = result;
    this.inFlight = false;
    this.setStep('complete');
    this.emitEvent({
      type: result.success ? 'run_completed' : 'run_failed',
      timestamp: new Date(),
      payload: result,
      message: result.success
        ? `Reconciliation complete: ${eventsReplayed} replayed, ${updatesApplied} updates`
        : `Reconciliation failed: ${result.error ?? 'unknown'}`,
    });
    this.setStep('idle');
    return result;
  }

  private async replayEvents(
    response: ReconciliationResponse,
    opts: Required<ReplayOptions>,
  ): Promise<number> {
    if (!response.replayEvents || response.replayEvents.length === 0) {
      return 0;
    }

    let sorted = [...response.replayEvents];
    switch (opts.orderingKey) {
      case 'sequence':
        sorted.sort((a, b) => a.sequence - b.sequence);
        break;
      case 'occurredAt':
        sorted.sort((a, b) => {
          const aTime = (a.event as EventEnvelope)?.occurredAt;
          const bTime = (b.event as EventEnvelope)?.occurredAt;
          const aMs = aTime ? new Date(aTime).getTime() : 0;
          const bMs = bTime ? new Date(bTime).getTime() : 0;
          return aMs - bMs;
        });
        break;
      case 'sessionThenSequence':
      default:
        sorted.sort((a, b) => {
          const aEnv = a.event as EventEnvelope | undefined;
          const bEnv = b.event as EventEnvelope | undefined;
          const aSid = aEnv?.sessionId ?? '';
          const bSid = bEnv?.sessionId ?? '';
          if (aSid !== bSid) return aSid.localeCompare(bSid);
          return a.sequence - b.sequence;
        });
        break;
    }

    let replayed = 0;
    for (let i = 0; i < sorted.length; i += opts.maxBatchSize) {
      const batch = sorted.slice(i, i + opts.maxBatchSize);
      for (const item of batch) {
        const env = item.event as EventEnvelope | undefined;
        if (!env) {
          if (opts.haltOnError) {
            throw new Error(`Replay item at sequence ${item.sequence} is not a valid EventEnvelope`);
          }
          continue;
        }
        if (opts.onlyDurable && !this.gapDetector.isDurable(env.eventType)) {
          continue;
        }
        let attempt = 0;
        while (attempt <= this.options.maxRetryOnReplayError) {
          try {
            const applied = await this.eventStore.replayEvent(env.sessionId, env);
            if (applied) {
              replayed++;
              this.emitEvent({
                type: 'event_replayed',
                timestamp: new Date(),
                payload: {
                  sequence: item.sequence,
                  eventId: env.eventId,
                  eventType: env.eventType,
                  sessionId: env.sessionId,
                },
              });
            }
            break;
          } catch (err) {
            attempt++;
            if (attempt > this.options.maxRetryOnReplayError) {
              const msg = err instanceof Error ? err.message : String(err);
              this.eventStore.recordUnrecoverableGap({
                sessionId: env.sessionId,
                fromSequence: item.sequence,
                toSequence: item.sequence,
                reason: `Replay failed after ${attempt} attempts: ${msg}`,
                reportedAt: new Date(),
                eventTypesAffected: [env.eventType],
              });
              if (opts.haltOnError) throw err;
            }
          }
        }
      }
    }

    return replayed;
  }

  private async applySessionUpdates(
    response: ReconciliationResponse,
  ): Promise<number> {
    let applied = 0;
    if (!response.sessionUpdates || response.sessionUpdates.length === 0) {
      return 0;
    }

    for (const update of response.sessionUpdates) {
      if (update.newState) {
        try {
          const ok = await this.updateApplier.updateSessionState(update.sessionId, update.newState);
          if (ok) applied++;
        } catch {
          // continue with rest of updates
        }
      }
      if (update.missingApprovalDecisions && update.missingApprovalDecisions.length > 0) {
        for (const decision of update.missingApprovalDecisions) {
          try {
            const ok = await this.updateApplier.applyMissingApprovalDecision(
              update.sessionId,
              decision,
            );
            if (ok) applied++;
          } catch {
            // continue
          }
        }
      }
      this.emitEvent({
        type: 'update_applied',
        timestamp: new Date(),
        payload: {
          sessionId: update.sessionId,
          hasState: !!update.newState,
          approvalDecisions: update.missingApprovalDecisions?.length ?? 0,
          gaps: update.unrecoverableGaps?.length ?? 0,
        },
      });
    }
    return applied;
  }

  private setStep(step: ReconciliationStep): void {
    const previous = this._step;
    if (previous === step) return;
    this._step = step;
    this.emitEvent({
      type: 'step_changed',
      timestamp: new Date(),
      step,
      previousStep: previous,
      message: `Reconciliation step: ${previous} → ${step}`,
    });
  }

  private emitEvent(event: ReconciliationEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // swallow listener errors
      }
    }
  }

  isInFlight(): boolean {
    return this.inFlight;
  }

  getGapDetector(): GapDetector {
    return this.gapDetector;
  }
}

export function createReconciliationEngine(
  stateProvider: SessionStateProvider,
  updateApplier: SessionUpdateApplier,
  eventStore: EventStore,
  options?: ReconciliationEngineOptions,
): ReconciliationEngine {
  return new ReconciliationEngine(stateProvider, updateApplier, eventStore, options);
}
