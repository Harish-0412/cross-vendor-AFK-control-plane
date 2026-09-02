import {
  type RevocationStatus,
  type RevocationReason,
  DEFAULT_REVOCATION_CACHE_TTL_MS,
} from '@freebuff/protocol';

export interface RevocationEntry {
  deviceId: string;
  revokedAt: Date;
  reason: RevocationReason;
  revokedBy: string;
  revocationNote?: string | undefined;
  affectedCertificates: string[];
  effectiveImmediately: boolean;
}

export interface RevocationStoreConfig {
  cacheTtlMs?: number;
  maxEntries?: number;
  persistPath?: string;
}

/**
 * Revocation listeners may be async — invalidating a revoked device's live
 * sessions is I/O. Use `addAndNotify` to await them.
 */
export type RevocationListener = (entry: RevocationEntry) => void | Promise<void>;

/** Outcome of notifying listeners about a revocation. */
export interface RevocationNotifyResult {
  /** True when every listener completed without throwing. */
  delivered: boolean;
  /** Errors thrown or rejected by listeners, in completion order. */
  failures: Error[];
}

const DEFAULT_MAX_ENTRIES = 10000;

export class RevocationStore {
  private readonly config: Required<Omit<RevocationStoreConfig, 'persistPath'>> &
    Pick<RevocationStoreConfig, 'persistPath'>;
  private entries: Map<string, RevocationEntry> = new Map();
  private lastRefreshAt: Date | null = null;
  private listeners: Set<RevocationListener> = new Set();

  constructor(config: RevocationStoreConfig = {}) {
    this.config = {
      cacheTtlMs: DEFAULT_REVOCATION_CACHE_TTL_MS,
      maxEntries: DEFAULT_MAX_ENTRIES,
      ...config,
    };
  }

  /**
   * Record a revocation and notify listeners without waiting for them.
   *
   * Prefer `addAndNotify` anywhere the caller reports the device as revoked
   * afterwards: an async listener (session invalidation) has only been
   * *started* when this returns, so a device can still be serving traffic on a
   * live session at that point.
   */
  add(entry: RevocationEntry): void {
    this.record(entry);
    for (const listener of this.listeners) {
      try {
        const result = listener(entry);
        // An async listener rejects after `add` has already returned, so the
        // try/catch above never sees it. Attach a handler so it cannot become
        // an unhandled rejection.
        if (result instanceof Promise) {
          result.catch(() => undefined);
        }
      } catch {
        // Listener failures must not prevent the revocation being recorded.
      }
    }
  }

  /**
   * Record a revocation and wait for every listener to finish, returning what
   * failed. Revocation is a security boundary: the caller should not report a
   * device as revoked until its sessions have actually been torn down, and a
   * failure to tear them down has to be visible rather than swallowed.
   */
  async addAndNotify(entry: RevocationEntry): Promise<RevocationNotifyResult> {
    this.record(entry);

    const failures: Error[] = [];
    const settled = await Promise.allSettled(
      [...this.listeners].map(async (listener) => listener(entry)),
    );
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        const reason: unknown = outcome.reason;
        failures.push(reason instanceof Error ? reason : new Error(String(reason)));
      }
    }

    return { delivered: failures.length === 0, failures };
  }

  /** Insert the entry, evicting the oldest if the store is full. */
  private record(entry: RevocationEntry): void {
    if (this.entries.size >= this.config.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey) {
        this.entries.delete(oldestKey);
      }
    }
    this.entries.set(entry.deviceId, entry);
  }

  remove(deviceId: string): boolean {
    return this.entries.delete(deviceId);
  }

  get(deviceId: string): RevocationEntry | undefined {
    return this.entries.get(deviceId);
  }

  isRevoked(deviceId: string, certificateThumbprint?: string): RevocationStatus {
    const entry = this.entries.get(deviceId);
    if (!entry) {
      return {
        deviceId,
        revoked: false,
        affectedCertificates: [],
      };
    }

    const certAffected =
      !certificateThumbprint ||
      entry.affectedCertificates.includes(certificateThumbprint) ||
      entry.affectedCertificates.length === 0;

    if (!certAffected) {
      return {
        deviceId,
        revoked: false,
        affectedCertificates: entry.affectedCertificates,
      };
    }

    return {
      deviceId,
      revoked: true,
      revokedAt: entry.revokedAt,
      reason: entry.reason,
      revokedBy: entry.revokedBy,
      revocationNote: entry.revocationNote,
      affectedCertificates: entry.affectedCertificates,
    };
  }

  getRevocationList(): RevocationEntry[] {
    return Array.from(this.entries.values()).sort(
      (a, b) => b.revokedAt.getTime() - a.revokedAt.getTime(),
    );
  }

  needsRefresh(): boolean {
    if (!this.lastRefreshAt) return true;
    return Date.now() - this.lastRefreshAt.getTime() >= this.config.cacheTtlMs;
  }

  markRefreshed(): void {
    this.lastRefreshAt = new Date();
  }

  getLastRefreshAt(): Date | null {
    return this.lastRefreshAt;
  }

  onRevocation(listener: RevocationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.lastRefreshAt = null;
  }

  importBatch(entries: RevocationEntry[]): number {
    let added = 0;
    for (const entry of entries) {
      if (!this.entries.has(entry.deviceId)) {
        added++;
      }
      this.add(entry);
    }
    return added;
  }
}

export function createRevocationStore(config?: RevocationStoreConfig): RevocationStore {
  return new RevocationStore(config);
}

export interface RevocationCheckClient {
  checkRevocation(deviceId: string, thumbprint: string): Promise<RevocationStatus>;
  fetchRevocationList(since?: Date): Promise<RevocationEntry[]>;
}

export class RevocationChecker {
  private readonly store: RevocationStore;
  private client: RevocationCheckClient | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(
    store: RevocationStore,
    client?: RevocationCheckClient,
    sessionInvalidator?: (deviceId: string, reason: string) => Promise<void>,
  ) {
    this.store = store;
    this.client = client ?? null;

    if (sessionInvalidator) {
      store.onRevocation(async (entry) => {
        if (!entry.effectiveImmediately) return;
        const reason = `Device revoked: ${entry.reason}${entry.revocationNote ? ` - ${entry.revocationNote}` : ''}`;
        // Deliberately not caught here: `addAndNotify` collects the failure so
        // the caller can see that a revoked device's sessions are still live.
        await sessionInvalidator(entry.deviceId, reason);
      });
    }
  }

  setClient(client: RevocationCheckClient | null): void {
    this.client = client;
  }

  async check(deviceId: string, certificateThumbprint?: string): Promise<RevocationStatus> {
    let status = this.store.isRevoked(deviceId, certificateThumbprint);

    if (!status.revoked && this.client && this.store.needsRefresh()) {
      try {
        const freshStatus = await this.client.checkRevocation(
          deviceId,
          certificateThumbprint ?? '',
        );
        if (freshStatus.revoked) {
          const entry: RevocationEntry = {
            deviceId: freshStatus.deviceId,
            revokedAt: freshStatus.revokedAt ?? new Date(),
            reason: freshStatus.reason ?? 'policy_violation',
            revokedBy: freshStatus.revokedBy ?? 'system',
            revocationNote: freshStatus.revocationNote,
            affectedCertificates: freshStatus.affectedCertificates,
            effectiveImmediately: true,
          };
          // Await notification so we do not report the device as revoked
          // while its sessions are still being torn down.
          await this.store.addAndNotify(entry);
          status = freshStatus;
        }
        this.store.markRefreshed();
      } catch {
        // Ignore refresh errors; fall back to local cache
      }
    }

    return status;
  }

  async refreshFromSource(since?: Date): Promise<number> {
    if (!this.client) return 0;
    try {
      const entries = await this.client.fetchRevocationList(since);
      const added = this.store.importBatch(entries);
      this.store.markRefreshed();
      return added;
    } catch {
      return 0;
    }
  }

  startAutoRefresh(intervalMs: number = DEFAULT_REVOCATION_CACHE_TTL_MS): void {
    this.stopAutoRefresh();
    this.refreshTimer = setInterval(() => {
      void this.refreshFromSource();
    }, intervalMs);
    if (typeof this.refreshTimer.unref === 'function') {
      this.refreshTimer.unref();
    }
  }

  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  shutdown(): void {
    this.stopAutoRefresh();
    this.store.clear();
  }
}

export function createRevocationChecker(
  store: RevocationStore,
  client?: RevocationCheckClient,
  sessionInvalidator?: (deviceId: string, reason: string) => Promise<void>,
): RevocationChecker {
  return new RevocationChecker(store, client, sessionInvalidator);
}
