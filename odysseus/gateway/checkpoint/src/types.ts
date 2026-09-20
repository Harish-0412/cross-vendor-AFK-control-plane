/**
 * Checkpoint Store Types
 *
 * Stores session recovery state for crash resilience:
 * - last received sequence per session
 * - last sent sequence per session
 * - session state snapshots
 * - event offsets for replay
 * - reconnect state machine position
 */

export type ReconnectState =
  'idle' | 'connected' | 'disconnected' | 'reconnecting' | 'reconciling' | 'degraded';

export interface SessionCheckpoint {
  /** Session identifier */
  sessionId: string;

  /** Gateway this session belongs to */
  gatewayId: string;

  /** Adapter used for this session */
  adapterId: string;

  /** Project this session belongs to */
  projectId: string;

  /** Current session state */
  sessionState: string;

  /** Last event sequence number received from the adapter */
  lastReceivedSequence: number;

  /** Last event sequence number sent to the control plane (or local consumer) */
  lastSentSequence: number;

  /** Event count since session start */
  eventCount: number;

  /** Map of event type to last seen sequence for that type */
  eventTypeOffsets: Record<string, number>;

  /** When the session was created */
  createdAt: Date;

  /** When this checkpoint was last persisted */
  lastPersistedAt: Date;

  /** When the session ended (if terminal) */
  endedAt?: Date;

  /** Reconnect state machine position */
  reconnectState: ReconnectState;

  /** Number of successful reconnects */
  reconnectCount: number;

  /** Number of failed reconnect attempts */
  failedReconnectAttempts: number;

  /** Whether the session needs reconciliation after reconnect */
  needsReconciliation: boolean;

  /** Events that were received but not yet acknowledged */
  pendingAckEvents: number[];

  /** Session error if any */
  error?: {
    code: string;
    message: string;
    fatal: boolean;
  };

  /** Arbitrary metadata for future extensions */
  metadata: Record<string, unknown>;
}

export interface CheckpointStoreStats {
  totalCheckpoints: number;
  activeCheckpoints: number;
  terminalCheckpoints: number;
  lastPersistedAt?: Date | undefined;
  storageSizeBytes: number;
}

export interface CheckpointStoreOptions {
  /** Directory to persist checkpoint files to. If undefined, in-memory only. */
  persistDir?: string;

  /** Maximum number of checkpoints to keep in memory */
  maxCheckpoints?: number;

  /** Auto-persist interval in ms. 0 = manual only. */
  autoPersistIntervalMs?: number;

  /** Maximum age of terminal checkpoints before cleanup (ms) */
  terminalCheckpointMaxAgeMs?: number;
}

export const DEFAULT_CHECKPOINT_OPTIONS: Required<CheckpointStoreOptions> = {
  persistDir: '',
  maxCheckpoints: 1000,
  autoPersistIntervalMs: 30000,
  terminalCheckpointMaxAgeMs: 24 * 60 * 60 * 1000, // 24 hours
};
