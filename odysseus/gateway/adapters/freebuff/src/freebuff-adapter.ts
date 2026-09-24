import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  AgentAdapter,
  AgentInstallationResult,
  AgentValidationResult,
  ApprovalAction,
  EventEnvelope,
  EventStream,
  EventSubscriber,
  EventType,
  Session,
  SessionConfig,
  SessionState,
} from '@odysseus/protocol';
import { EVENT_VERSION, generateEventId, generateSessionId } from '@odysseus/protocol';

import { freebuffMetadata } from './capabilities';
import { AdapterEventStream } from './event-stream';
import { resolveCommand, type ResolvedCommand } from './resolve-command';
import { safeGitDiff } from './safe-git';
import { TerminalDriver } from './terminal-driver';

const execFileAsync = promisify(execFile);

export interface FreebuffAdapterOptions {
  /** Defaults to FREEBUFF_BINARY, then `freebuff` on PATH. */
  binaryPath?: string;
  /** Replaces command resolution entirely; used by tests to run a stand-in program. */
  command?: ResolvedCommand;
  /** Quiet time after launch before the prompt is typed. */
  readyQuietMs?: number;
  /** Longest wait for the interface to come up; the first run indexes the repository. */
  readyTimeoutMs?: number;
  /** A screen unchanged for this long, after work began, ends the turn. */
  doneQuietMs?: number;
  /** Default ceiling for one session when SessionConfig.timeout is unset. */
  sessionTimeoutMs?: number;
  /** How often the screen is checked. */
  pollMs?: number;
}

const DEFAULTS = {
  readyQuietMs: 2_500,
  readyTimeoutMs: 180_000,
  doneQuietMs: Number(process.env['FREEBUFF_DONE_QUIET_MS']) || 20_000,
  sessionTimeoutMs: 30 * 60_000,
  pollMs: 500,
};

/** Text on the start screen that means Freebuff wants a sign-in first. */
const NEEDS_LOGIN = /\bfreebuff login\b|\b(log|sign) ?in\b[^\n]{0,80}\b(browser|link|url|code)\b/i;
/** Most of a turn's answer; the full screen is still available through the session output. */
const MAX_ANSWER_CHARS = 20_000;

interface FreebuffSession {
  session: Session;
  stream: AdapterEventStream;
  driver: TerminalDriver;
  projectRoot: string;
  state: SessionState;
  sequence: number;
  deviceId?: string | undefined;
  /** Set when a prompt is typed; the turn ends once the screen settles after it. */
  turn?: { submittedAt: number; baseline: string; prompt: string } | undefined;
  closing?: Promise<void> | undefined;
}

/**
 * Freebuff, driven through a pseudo-terminal.
 *
 * Freebuff's CLI offers only `--cwd`, `--continue` and `--trust-agents`: no
 * prompt argument, no print mode, and it requires a TTY. Codebuff has an open
 * request for a headless mode; until one ships, this adapter is what a person
 * at the keyboard would do — start it in the project, paste the prompt, press
 * Enter, and read the answer once the screen stops changing.
 *
 * The end of a turn is inferred, not reported. A screen that has not changed
 * for `doneQuietMs` after work began counts as done. That is reliable for a
 * program that animates while it works, and it is why a Freebuff step takes at
 * least that long to finish.
 */
export class FreebuffAdapter implements AgentAdapter {
  private readonly sessions = new Map<string, FreebuffSession>();
  private readonly options: Required<Omit<FreebuffAdapterOptions, 'binaryPath' | 'command'>>;
  private readonly resolved: ResolvedCommand;
  private detectedVersion = 'unknown';

  constructor(options: FreebuffAdapterOptions = {}) {
    this.options = {
      readyQuietMs: options.readyQuietMs ?? DEFAULTS.readyQuietMs,
      readyTimeoutMs: options.readyTimeoutMs ?? DEFAULTS.readyTimeoutMs,
      doneQuietMs: options.doneQuietMs ?? DEFAULTS.doneQuietMs,
      sessionTimeoutMs: options.sessionTimeoutMs ?? DEFAULTS.sessionTimeoutMs,
      pollMs: options.pollMs ?? DEFAULTS.pollMs,
    };
    this.resolved =
      options.command ??
      resolveCommand(options.binaryPath ?? process.env['FREEBUFF_BINARY'] ?? 'freebuff');
  }

  metadata() {
    return freebuffMetadata(this.detectedVersion);
  }

  async installOrDetect(): Promise<AgentInstallationResult> {
    const version = await this.version();
    if (!version)
      return {
        success: false,
        error: {
          code: 'FREEBUFF_NOT_FOUND',
          message: 'Freebuff was not found on PATH. Install it with `npm install -g freebuff`.',
          retryable: true,
        },
      };
    this.detectedVersion = version;
    return { success: true, installedVersion: version, path: this.resolved.command };
  }

  async validateEnvironment(): Promise<AgentValidationResult> {
    const version = await this.version();
    if (version) this.detectedVersion = version;
    return {
      valid: Boolean(version),
      errors: version ? [] : ['Freebuff is not installed (npm install -g freebuff)'],
      warnings: version
        ? []
        : ['Run `freebuff` once in a terminal and sign in before starting a session.'],
      checks: { binary_present: Boolean(version) },
    };
  }

  async startSession(config: SessionConfig): Promise<string> {
    if (!config.prompt) throw new Error('Freebuff needs a prompt to start a session');
    const id = generateSessionId();
    const driver = new TerminalDriver({
      command: this.resolved.command,
      args: [...this.resolved.prefixArgs, '--cwd', config.projectRoot],
      cwd: config.projectRoot,
      env: { ...stringEnv(process.env), ...(config.env ?? {}), TERM: 'xterm-256color' },
    });
    const session: Session = {
      id,
      projectId: String(config.metadata?.['projectId'] ?? 'proj_freebuff'),
      adapterId: 'freebuff',
      state: 'running',
      processId: driver.pid,
      startTime: new Date(),
      sequenceNumber: 0,
      metadata: { ...(config.metadata ?? {}) },
    };
    const internal: FreebuffSession = {
      session,
      stream: new AdapterEventStream(),
      driver,
      projectRoot: config.projectRoot,
      state: 'running',
      sequence: 0,
      deviceId:
        typeof config.metadata?.['deviceId'] === 'string' ? config.metadata['deviceId'] : undefined,
    };
    this.sessions.set(id, internal);
    this.publish(internal, 'session.started', { adapter: 'freebuff', pid: driver.pid });

    const timeoutMs =
      config.timeout && config.timeout > 0 ? config.timeout : this.options.sessionTimeoutMs;
    void this.run(internal, config.prompt, timeoutMs).catch((error: unknown) =>
      this.fail(internal, error instanceof Error ? error.message : String(error)),
    );
    return id;
  }

  /** Type a follow-up into a session that is still open. */
  async sendMessage(sessionId: string, message: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.state !== 'running' || session.driver.exited)
      throw new Error('This Freebuff session has finished');
    await this.submit(session, message);
  }

  async sendInput(sessionId: string, data: string): Promise<void> {
    this.requireSession(sessionId).driver.press(data);
  }

  streamEvents(sessionId: string, subscriber?: Partial<EventSubscriber>): EventStream {
    const session = this.requireSession(sessionId);
    if (subscriber) session.stream.subscribe(subscriber);
    return session.stream;
  }

  async requestApproval(
    _sessionId: string,
    _action: ApprovalAction,
  ): Promise<{ approved: boolean; reason?: string }> {
    throw new Error('Freebuff does not expose external approval interception');
  }

  async submitApprovalDecision(): Promise<void> {
    throw new Error('Freebuff does not expose external approval interception');
  }

  async abortSession(sessionId: string, reason: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.state !== 'running') return;
    this.setState(session, 'cancelled');
    this.publish(session, 'session.cancelled', { reason });
    await this.close(session);
  }

  async collectDiff(sessionId: string): Promise<string> {
    return safeGitDiff(this.requireSession(sessionId).projectRoot);
  }

  async getState(sessionId: string): Promise<SessionState> {
    return this.requireSession(sessionId).state;
  }

  async getSession(sessionId: string): Promise<Session | undefined> {
    return this.sessions.get(sessionId)?.session;
  }

  async cleanupSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    await this.close(session);
    this.sessions.delete(sessionId);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.cleanupSession(id)));
  }

  // ------------------------------------------------------------ the turn

  private async run(session: FreebuffSession, prompt: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const before = await changedFiles(session.projectRoot);

    await this.waitUntilReady(session);
    if (session.state !== 'running') return;
    const startScreen = await session.driver.text();
    if (NEEDS_LOGIN.test(startScreen)) {
      this.fail(
        session,
        'Freebuff is asking you to sign in. Run `freebuff` once in a terminal on this machine, ' +
          'sign in, then start the session again.',
      );
      return;
    }

    await this.submit(session, prompt);
    // Compared against the screen as it was just before the prompt was typed,
    // so even a turn that finishes between two checks counts as work done.
    let lastScreen = session.turn?.baseline ?? startScreen;
    let lastChange = Date.now();
    let streamed = lastScreen;
    let sawWork = false;

    while (session.state === 'running') {
      await sleep(this.options.pollMs);
      if (session.state !== 'running') return;
      const screen = await session.driver.text();
      const now = Date.now();
      if (screen !== lastScreen) {
        sawWork = true;
        lastScreen = screen;
        lastChange = now;
        const fresh = newLines(streamed, screen);
        if (fresh) {
          this.publish(session, 'session.output', {
            stream: 'stdout',
            content: fresh,
            timestamp: new Date(),
          });
          streamed = screen;
        }
      }
      if (session.driver.exited) break;
      if (now > deadline) {
        this.fail(
          session,
          `Freebuff did not finish within ${Math.round(timeoutMs / 60_000)} minutes`,
        );
        return;
      }
      if (sawWork && now - lastChange >= this.options.doneQuietMs) break;
    }
    if (session.state !== 'running') return;

    const finalScreen = await session.driver.text();
    // Freebuff stays open between turns, so exiting during one is a failure,
    // not an answer — whatever is on screen is the reason.
    if (session.driver.exited) {
      const tail = finalScreen.split('\n').slice(-12).join('\n').trim();
      this.fail(
        session,
        `Freebuff exited during the turn (exit code ${session.driver.exitCode ?? 'unknown'})` +
          (tail ? `:\n${tail}` : ''),
      );
      return;
    }
    const answer = extractAnswer(
      session.turn?.baseline ?? startScreen,
      finalScreen,
      session.turn?.prompt ?? prompt,
    );
    const after = await changedFiles(session.projectRoot);
    for (const [path, status] of after) {
      if (before.get(path) === status) continue;
      this.publish(session, 'session.file_changed', {
        path,
        action: status.includes('D')
          ? 'deleted'
          : status.includes('?') || status.includes('A')
            ? 'created'
            : 'modified',
        timestamp: new Date(),
      });
    }
    this.publish(session, 'session.message', { role: 'assistant', content: answer });
    this.setState(session, 'completed');
    this.publish(session, 'session.completed', {
      result: answer,
      summary: 'Freebuff turn finished',
    });
    void this.close(session);
  }

  private async waitUntilReady(session: FreebuffSession): Promise<void> {
    const deadline = Date.now() + this.options.readyTimeoutMs;
    for (;;) {
      if (session.state !== 'running') return;
      if (session.driver.exited) {
        this.fail(
          session,
          'Freebuff exited before it was ready. Run `freebuff` in a terminal to see why.',
        );
        return;
      }
      if (session.driver.bytesSeen > 0 && session.driver.idleFor() >= this.options.readyQuietMs)
        return;
      if (Date.now() > deadline) {
        this.fail(session, 'Freebuff did not become ready in time');
        return;
      }
      await sleep(this.options.pollMs);
    }
  }

  private async submit(session: FreebuffSession, text: string): Promise<void> {
    session.turn = { submittedAt: Date.now(), baseline: await session.driver.text(), prompt: text };
    this.publish(session, 'session.message', { role: 'user', content: text });
    session.driver.submit(text);
  }

  private fail(session: FreebuffSession, error: string): void {
    if (session.state !== 'running') return;
    this.setState(session, 'failed');
    this.publish(session, 'session.failed', { error });
    void this.close(session);
  }

  /** Resolves once Freebuff has exited, so its folder and terminal are released. */
  private close(session: FreebuffSession): Promise<void> {
    session.stream.close();
    session.closing ??= (async () => {
      // Ctrl+C first so Freebuff can save its conversation, then make sure.
      session.driver.press('\x03');
      await session.driver.stop(1_000);
      session.driver.dispose();
    })();
    return session.closing;
  }

  private setState(session: FreebuffSession, state: SessionState): void {
    session.state = state;
    session.session.state = state;
    if (state !== 'running') session.session.endTime = new Date();
  }

  private publish(session: FreebuffSession, eventType: EventType, payload: unknown): void {
    session.sequence += 1;
    const event: EventEnvelope = {
      eventId: generateEventId(),
      eventType,
      eventVersion: EVENT_VERSION,
      sessionId: session.session.id,
      ...(session.deviceId ? { deviceId: session.deviceId } : {}),
      sequence: session.sequence,
      occurredAt: new Date(),
      payload,
    };
    session.session.sequenceNumber = session.sequence;
    session.session.lastEventAt = event.occurredAt;
    session.stream.publish(event);
  }

  private async version(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        this.resolved.command,
        [...this.resolved.prefixArgs, '--version'],
        { windowsHide: true, timeout: 5_000 },
      );
      const match = /\d+\.\d+\.\d+/.exec(stdout);
      return match ? match[0] : null;
    } catch {
      return null;
    }
  }

  private requireSession(id: string): FreebuffSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Freebuff session not found: ${id}`);
    return session;
  }
}

// ------------------------------------------------------------ helpers

/**
 * The turn's answer: what appeared on screen after the prompt was typed,
 * without the echoed prompt itself.
 */
export function extractAnswer(baseline: string, final: string, prompt: string): string {
  const seen = new Set(baseline.split('\n').map((line) => line.trim()));
  const promptLines = new Set(
    prompt
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const lines = final
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed && !seen.has(trimmed) && !promptLines.has(trimmed);
    })
    .map((line) => line.trimEnd());
  const text = lines.join('\n').trim();
  return text.length > MAX_ANSWER_CHARS ? text.slice(text.length - MAX_ANSWER_CHARS) : text;
}

/** Lines of `screen` that were not in `previous`, for streaming progress. */
function newLines(previous: string, screen: string): string {
  const seen = new Set(previous.split('\n'));
  return screen
    .split('\n')
    .filter((line) => line.trim() && !seen.has(line))
    .join('\n');
}

/** `git status --porcelain` as path → status, so a turn's own changes can be told apart. */
async function changedFiles(root: string): Promise<Map<string, string>> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain', '--untracked-files=all'],
      {
        cwd: root,
        timeout: 10_000,
        windowsHide: true,
        maxBuffer: 5 * 1024 * 1024,
      },
    );
    const files = new Map<string, string>();
    for (const line of stdout.split('\n')) {
      if (line.length < 4) continue;
      const path = line.slice(3).trim().replace(/^"|"$/g, '');
      files.set(path.includes(' -> ') ? path.split(' -> ')[1]! : path, line.slice(0, 2));
    }
    return files;
  } catch {
    return new Map();
  }
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string') out[key] = value;
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
