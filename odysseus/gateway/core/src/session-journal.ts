/**
 * A record, on disk, of the sessions this gateway is running.
 *
 * A session leaves the journal when it ends and when the gateway shuts down
 * cleanly, so whatever is still in it at startup was interrupted: the
 * machine restarted, slept too long, or the gateway was killed. The Control
 * Plane asks for those when the gateway reconnects, marks them interrupted
 * and — through policy, like any other start — continues the work, resuming
 * the same agent conversation where the agent supports it.
 */
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

export interface JournalEntry {
  /** The Control Plane's session id. */
  sessionId: string;
  adapter: string;
  projectRoot: string;
  /** The task the session was started with, to brief a continuation. */
  prompt?: string;
  /** The agent's own conversation id (Claude Code session, Codex thread), once known. */
  nativeSessionId?: string;
  startedAt: string;
}

const MAX_PROMPT_CHARS = 8_000;

export class SessionJournal {
  private entries = new Map<string, JournalEntry>();
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();
  /**
   * Operations run one at a time, in the order they were asked for: a short
   * session can end before the write that recorded it has finished, and its
   * removal must not overtake that write.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  /** Sessions recorded by a previous run of the gateway, oldest first. */
  list(): Promise<JournalEntry[]> {
    return this.enqueue(async () => this.sorted());
  }

  record(entry: JournalEntry): Promise<void> {
    return this.enqueue(async () => {
      this.entries.set(entry.sessionId, {
        ...entry,
        ...(entry.prompt ? { prompt: entry.prompt.slice(0, MAX_PROMPT_CHARS) } : {}),
      });
      await this.save();
    });
  }

  setNativeSessionId(sessionId: string, nativeSessionId: string): Promise<void> {
    return this.enqueue(async () => {
      const entry = this.entries.get(sessionId);
      if (!entry || entry.nativeSessionId === nativeSessionId) return;
      this.entries.set(sessionId, { ...entry, nativeSessionId });
      await this.save();
    });
  }

  remove(sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.entries.delete(sessionId)) await this.save();
    });
  }

  /** Hand over what a previous run left behind, and forget it. */
  takeInterrupted(except: ReadonlySet<string>): Promise<JournalEntry[]> {
    return this.enqueue(async () => {
      const entries = this.sorted().filter((entry) => !except.has(entry.sessionId));
      if (entries.length === 0) return [];
      for (const entry of entries) this.entries.delete(entry.sessionId);
      await this.save();
      return entries;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      await this.load();
      return operation();
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  private sorted(): JournalEntry[] {
    return [...this.entries.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as { sessions?: unknown };
      for (const item of Array.isArray(parsed.sessions) ? parsed.sessions : []) {
        const entry = item as Partial<JournalEntry>;
        if (
          typeof entry.sessionId === 'string' &&
          typeof entry.adapter === 'string' &&
          typeof entry.projectRoot === 'string' &&
          typeof entry.startedAt === 'string'
        )
          this.entries.set(entry.sessionId, entry as JournalEntry);
      }
    } catch {
      // No journal yet, or an unreadable one: nothing to recover.
    }
  }

  /** Writes are serialised, and each replaces the file atomically. */
  private save(): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, sessions: [...this.entries.values()] }, null, 2);
    // A failed write must not jam every write after it.
    this.writing = this.writing
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(dirname(this.file), { recursive: true });
        const temporary = `${this.file}.${process.pid}.tmp`;
        await fs.writeFile(temporary, snapshot, 'utf8');
        await fs.rename(temporary, this.file);
      });
    return this.writing;
  }
}
