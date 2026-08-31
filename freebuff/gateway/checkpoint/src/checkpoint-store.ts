import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  SessionCheckpoint,
  CheckpointStoreStats,
  CheckpointStoreOptions,
  ReconnectState,
} from './types';
import { DEFAULT_CHECKPOINT_OPTIONS } from './types';

/**
 * CheckpointStore - Persists session state for crash recovery and reconnect.
 *
 * Stores:
 * - last received sequence (from adapter)
 * - last sent sequence (to consumer/control plane)
 * - session state snapshot
 * - event type offsets for replay
 * - reconnect state machine position
 *
 * Supports both in-memory-only and file-persisted modes.
 * File format is JSON (upgradeable to SQLite in Phase 11).
 */
export class CheckpointStore {
  private checkpoints: Map<string, SessionCheckpoint> = new Map();
  private options: Required<CheckpointStoreOptions>;
  private persistTimer?: NodeJS.Timeout;
  private shuttingDown = false;

  constructor(options: CheckpointStoreOptions = {}) {
    this.options = {
      ...DEFAULT_CHECKPOINT_OPTIONS,
      ...options,
    };
  }

  /**
   * Initialize the store, loading any persisted checkpoints from disk.
   */
  async initialize(): Promise<void> {
    if (!this.options.persistDir) return;

    try {
      await fs.mkdir(this.options.persistDir, { recursive: true });
    } catch {
      // directory may already exist
    }

    try {
      const files = await fs.readdir(this.options.persistDir);
      for (const file of files) {
        if (!file.endsWith('.checkpoint.json')) continue;
        try {
          const content = await fs.readFile(
            path.join(this.options.persistDir, file),
            'utf-8',
          );
          const data = JSON.parse(content) as SessionCheckpoint;
          // Revive dates
          data.createdAt = new Date(data.createdAt);
          data.lastPersistedAt = new Date(data.lastPersistedAt);
          if (data.endedAt) data.endedAt = new Date(data.endedAt);
          this.checkpoints.set(data.sessionId, data);
        } catch {
          // skip corrupted files
        }
      }
    } catch {
      // no persisted state yet
    }

    if (this.options.autoPersistIntervalMs > 0) {
      this.persistTimer = setInterval(() => {
        void this.persistAll().catch(() => {});
      }, this.options.autoPersistIntervalMs);
      this.persistTimer.unref?.();
    }
  }

  /**
   * Create a new checkpoint for a session.
   */
  create(params: {
    sessionId: string;
    gatewayId: string;
    adapterId: string;
    projectId: string;
  }): SessionCheckpoint {
    const now = new Date();
    const checkpoint: SessionCheckpoint = {
      sessionId: params.sessionId,
      gatewayId: params.gatewayId,
      adapterId: params.adapterId,
      projectId: params.projectId,
      sessionState: 'initializing',
      lastReceivedSequence: -1,
      lastSentSequence: -1,
      eventCount: 0,
      eventTypeOffsets: {},
      createdAt: now,
      lastPersistedAt: now,
      reconnectState: 'idle',
      reconnectCount: 0,
      failedReconnectAttempts: 0,
      needsReconciliation: false,
      pendingAckEvents: [],
      metadata: {},
    };

    this.checkpoints.set(params.sessionId, checkpoint);
    this.enforceMaxCheckpoints();
    return checkpoint;
  }

  /**
   * Get a checkpoint by session ID.
   */
  get(sessionId: string): SessionCheckpoint | undefined {
    return this.checkpoints.get(sessionId);
  }

  /**
   * Get a checkpoint or throw if not found.
   */
  getOrThrow(sessionId: string): SessionCheckpoint {
    const cp = this.checkpoints.get(sessionId);
    if (!cp) throw new Error(`Checkpoint not found: ${sessionId}`);
    return cp;
  }

  /**
   * Update the last received sequence for a session.
   */
  updateReceivedSequence(sessionId: string, sequence: number): SessionCheckpoint {
    const cp = this.getOrThrow(sessionId);
    cp.lastReceivedSequence = Math.max(cp.lastReceivedSequence, sequence);
    cp.eventCount++;
    cp.lastPersistedAt = new Date();
    return cp;
  }

  /**
   * Update the last sent sequence for a session (events forwarded to consumer).
   */
  updateSentSequence(sessionId: string, sequence: number): SessionCheckpoint {
    const cp = this.getOrThrow(sessionId);
    cp.lastSentSequence = Math.max(cp.lastSentSequence, sequence);
    cp.lastPersistedAt = new Date();
    return cp;
  }

  /**
   * Record that a specific event type was seen at a given sequence.
   */
  updateEventTypeOffset(
    sessionId: string,
    eventType: string,
    sequence: number,
  ): SessionCheckpoint {
    const cp = this.getOrThrow(sessionId);
    cp.eventTypeOffsets[eventType] = Math.max(
      cp.eventTypeOffsets[eventType] ?? -1,
      sequence,
    );
    cp.lastPersistedAt = new Date();
    return cp;
  }

  /**
   * Update the session state in the checkpoint.
   */
  updateSessionState(sessionId: string, state: string): SessionCheckpoint {
    const cp = this.getOrThrow(sessionId);
    cp.sessionState = state;
    cp.lastPersistedAt = new Date();
    return cp;
  }

  /**
   * Update the reconnect state machine position.
   */
  updateReconnectState(sessionId: string, state: ReconnectState): SessionCheckpoint {
    const cp = this.getOrThrow(sessionId);
    cp.reconnectState = state;

    if (state === 'reconnecting') {
      cp.reconnectCount++;
    } else if (state === 'degraded') {
      cp.failedReconnectAttempts++;
    } else if (state === 'connected') {
      cp.failedReconnectAttempts = 0;
      cp.needsReconciliation = false;
    }

    cp.lastPersistedAt = new Date();
    return cp;
  }

  /**
   * Mark that this session needs reconciliation after reconnect.
   */
  markNeedsReconciliation(sessionId: string): SessionCheckpoint {
    const cp = this.getOrThrow(sessionId);
    cp.needsReconciliation = true;
    cp.lastPersistedAt = new Date();
    return cp;
  }

  /**
   * Add an event to the pending-ack list.
   */
  addPendingAck(sessionId: string, sequence: number): SessionCheckpoint {
    const cp = this.getOrThrow(sessionId);
    if (!cp.pendingAckEvents.includes(sequence)) {
      cp.pendingAckEvents.push(sequence);
      cp.pendingAckEvents.sort((a, b) => a - b);
    }
    cp.lastPersistedAt = new Date();
    return cp;
  }

  /**
   * Acknowledge receipt of events up to and including the given sequence.
   */
  ackEvents(sessionId: string, upToSequence: number): SessionCheckpoint {
    const cp = this.getOrThrow(sessionId);
    cp.pendingAckEvents = cp.pendingAckEvents.filter((s) => s > upToSequence);
    cp.lastPersistedAt = new Date();
    return cp;
  }

  /**
   * Get the gap between received and sent sequences (for replay).
   */
  getEventGap(sessionId: string): {
    lastReceived: number;
    lastSent: number;
    gap: number;
    pendingAcks: number[];
  } {
    const cp = this.getOrThrow(sessionId);
    return {
      lastReceived: cp.lastReceivedSequence,
      lastSent: cp.lastSentSequence,
      gap: cp.lastReceivedSequence - cp.lastSentSequence,
      pendingAcks: [...cp.pendingAckEvents],
    };
  }

  /**
   * Mark a session as terminal (completed, failed, cancelled, crashed).
   */
  markTerminal(sessionId: string, state: string): SessionCheckpoint {
    const cp = this.getOrThrow(sessionId);
    cp.sessionState = state;
    cp.endedAt = new Date();
    cp.reconnectState = 'idle';
    cp.lastPersistedAt = new Date();
    return cp;
  }

  /**
   * Record an error on a session.
   */
  setError(
    sessionId: string,
    error: { code: string; message: string; fatal: boolean },
  ): SessionCheckpoint {
    const cp = this.getOrThrow(sessionId);
    cp.error = error;
    cp.lastPersistedAt = new Date();
    return cp;
  }

  /**
   * Store arbitrary metadata on a checkpoint.
   */
  setMetadata(sessionId: string, key: string, value: unknown): SessionCheckpoint {
    const cp = this.getOrThrow(sessionId);
    cp.metadata[key] = value;
    cp.lastPersistedAt = new Date();
    return cp;
  }

  /**
   * Delete a checkpoint.
   */
  delete(sessionId: string): boolean {
    return this.checkpoints.delete(sessionId);
  }

  /**
   * List all checkpoints.
   */
  list(): SessionCheckpoint[] {
    return Array.from(this.checkpoints.values());
  }

  /**
   * List checkpoints that need reconciliation.
   */
  listNeedingReconciliation(): SessionCheckpoint[] {
    return this.list().filter((cp) => cp.needsReconciliation);
  }

  /**
   * List active (non-terminal) checkpoints.
   */
  listActive(): SessionCheckpoint[] {
    const terminalStates = ['completed', 'failed', 'cancelled', 'crashed'];
    return this.list().filter((cp) => !terminalStates.includes(cp.sessionState));
  }

  /**
   * Get store statistics.
   */
  getStats(): CheckpointStoreStats {
    const all = this.list();
    const terminalStates = ['completed', 'failed', 'cancelled', 'crashed'];
    const active = all.filter((cp) => !terminalStates.includes(cp.sessionState));
    const terminal = all.filter((cp) => terminalStates.includes(cp.sessionState));

    const lastPersisted = all.reduce<Date | undefined>((latest, cp) => {
      if (!latest || cp.lastPersistedAt > latest) return cp.lastPersistedAt;
      return latest;
    }, undefined);

    return {
      totalCheckpoints: all.length,
      activeCheckpoints: active.length,
      terminalCheckpoints: terminal.length,
      lastPersistedAt: lastPersisted,
      storageSizeBytes: 0, // computed during persist
    };
  }

  /**
   * Persist a specific checkpoint to disk.
   */
  async persistOne(sessionId: string): Promise<void> {
    if (!this.options.persistDir) return;

    const cp = this.checkpoints.get(sessionId);
    if (!cp) return;

    const filename = `${sessionId}.checkpoint.json`;
    const filepath = path.join(this.options.persistDir, filename);

    cp.lastPersistedAt = new Date();
    await fs.writeFile(filepath, JSON.stringify(cp, null, 2), 'utf-8');
  }

  /**
   * Persist all checkpoints to disk.
   */
  async persistAll(): Promise<number> {
    if (!this.options.persistDir) return 0;

    let count = 0;
    for (const cp of this.checkpoints.values()) {
      try {
        await this.persistOne(cp.sessionId);
        count++;
      } catch {
        // skip write errors silently
      }
    }

    // Clean up checkpoint files for sessions that no longer exist
    try {
      const files = await fs.readdir(this.options.persistDir);
      for (const file of files) {
        if (!file.endsWith('.checkpoint.json')) continue;
        const sessionId = file.replace('.checkpoint.json', '');
        if (!this.checkpoints.has(sessionId)) {
          try {
            await fs.unlink(path.join(this.options.persistDir, file));
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }

    return count;
  }

  /**
   * Clean up old terminal checkpoints (both in-memory and on disk).
   */
  async cleanup(maxAgeMs?: number): Promise<number> {
    const maxAge = maxAgeMs ?? this.options.terminalCheckpointMaxAgeMs;
    const now = Date.now();
    const terminalStates = ['completed', 'failed', 'cancelled', 'crashed'];
    let cleaned = 0;

    for (const [id, cp] of this.checkpoints) {
      if (!terminalStates.includes(cp.sessionState)) continue;
      if (!cp.endedAt) continue;
      if (now - cp.endedAt.getTime() > maxAge) {
        this.checkpoints.delete(id);
        if (this.options.persistDir) {
          try {
            await fs.unlink(
              path.join(this.options.persistDir, `${id}.checkpoint.json`),
            );
          } catch {
            // ignore
          }
        }
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Clear all checkpoints from memory (does not affect disk unless persistAll is called after).
   */
  clear(): void {
    this.checkpoints.clear();
  }

  /**
   * Shutdown the store, persisting all checkpoints and stopping timers.
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = undefined;
    }

    await this.persistAll();
    this.checkpoints.clear();
  }

  private enforceMaxCheckpoints(): void {
    if (this.checkpoints.size <= this.options.maxCheckpoints) return;

    // Evict oldest terminal checkpoints first
    const terminalStates = ['completed', 'failed', 'cancelled', 'crashed'];
    const terminal = this.list()
      .filter((cp) => terminalStates.includes(cp.sessionState))
      .sort((a, b) => {
        const aEnd = a.endedAt?.getTime() ?? 0;
        const bEnd = b.endedAt?.getTime() ?? 0;
        return aEnd - bEnd;
      });

    while (this.checkpoints.size > this.options.maxCheckpoints && terminal.length > 0) {
      const oldest = terminal.shift()!;
      this.checkpoints.delete(oldest.sessionId);
    }
  }
}

export function createCheckpointStore(options?: CheckpointStoreOptions): CheckpointStore {
  return new CheckpointStore(options);
}
