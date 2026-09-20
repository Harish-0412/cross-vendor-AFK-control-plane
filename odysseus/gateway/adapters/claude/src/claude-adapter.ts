/**
 * Claude Code adapter.
 *
 * Drives the real `claude` CLI in headless mode: each turn is a `claude -p`
 * run emitting `--output-format stream-json`, and follow-up turns continue the
 * same conversation with `--resume <session-id>`. There is no simulation path
 * — if the CLI is not installed, `installOrDetect` reports that and sessions
 * cannot start.
 */
import type {
  AgentAdapter,
  AgentInstallationResult,
  AgentValidationResult,
  ApprovalAction,
  EventStream,
  EventSubscriber,
  Session,
  SessionConfig,
  SessionState,
} from '@odysseus/protocol';
import { generateSessionId } from '@odysseus/protocol';

import { claudeCodeMetadata } from './capabilities';
import { AdapterEventStream } from './event-stream';
import {
  ClaudeProcessManager,
  type ClaudeProcessController,
} from './process-manager';
import { safeGitDiff } from './safe-git';
import { ClaudeStreamParser } from './stream-parser';
import type { ClaudeProcessOptions } from './types';

interface ClaudeSession {
  id: string;
  projectRoot: string;
  config: SessionConfig;
  stream: AdapterEventStream;
  parser: ClaudeStreamParser;
  state: SessionState;
  session: Session;
  /** Claude Code's own session id, learned from the init event. */
  claudeSessionId?: string;
  /** The process for the turn currently running, if any. */
  current?: ReturnType<ClaudeProcessManager['run']> | undefined;
  /** Resolves when the in-flight turn finishes. */
  turn?: Promise<void> | undefined;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly processManager: ClaudeProcessController;
  private detectedVersion = 'unknown';

  constructor(processManager?: ClaudeProcessController, options?: ClaudeProcessOptions) {
    this.processManager = processManager ?? new ClaudeProcessManager(options);
  }

  metadata() {
    return claudeCodeMetadata(this.detectedVersion);
  }

  async installOrDetect(): Promise<AgentInstallationResult> {
    const detected = await this.processManager.detect();
    if (!detected) {
      return {
        success: false,
        error: {
          code: 'CLAUDE_CODE_NOT_FOUND',
          message:
            'Claude Code CLI was not found on PATH. Install it from ' +
            'https://code.claude.com and make sure `claude` is runnable.',
          retryable: true,
        },
      };
    }
    this.detectedVersion = detected.version;
    return { success: true, installedVersion: detected.version, path: detected.path };
  }

  async validateEnvironment(): Promise<AgentValidationResult> {
    const result = await this.processManager.validate();
    if (result.version) this.detectedVersion = result.version;
    return {
      valid: result.valid,
      errors: result.errors,
      warnings: result.warnings,
      checks: {
        binary_present: result.valid,
        credentials_present: result.warnings.length === 0,
      },
    };
  }

  // ------------------------------------------------------------- sessions

  async startSession(config: SessionConfig): Promise<string> {
    const detected = await this.processManager.detect();
    if (!detected) {
      throw new Error(
        'Claude Code CLI is not installed; cannot start a session. ' +
          'Install it and ensure `claude` is on PATH.',
      );
    }
    this.detectedVersion = detected.version;

    const sessionId = generateSessionId();
    const now = new Date();
    const stream = new AdapterEventStream();

    const record: ClaudeSession = {
      id: sessionId,
      projectRoot: config.projectRoot,
      config,
      stream,
      parser: new ClaudeStreamParser(sessionId),
      state: 'initializing',
      session: {
        id: sessionId,
        projectId: config.projectRoot,
        adapterId: 'claude-code',
        state: 'initializing',
        startTime: now,
        sequenceNumber: 0,
        metadata: { projectRoot: config.projectRoot, model: config.model },
      },
    };
    this.sessions.set(sessionId, record);

    // A session with no prompt is a valid idle session: the first sendMessage
    // starts the conversation. Otherwise the prompt runs immediately.
    if (config.prompt) {
      record.turn = this.runTurn(record, config.prompt);
    } else {
      record.state = 'running';
      record.session.state = 'running';
    }

    return sessionId;
  }

  /**
   * Run one turn and pump its output into the session's event stream.
   *
   * Errors are surfaced as `session.failed` on the stream rather than thrown:
   * by the time a turn is running, the caller has already been handed a
   * session id and is listening to events, so that is where a failure belongs.
   */
  private async runTurn(record: ClaudeSession, prompt: string): Promise<void> {
    const run = this.processManager.run({
      prompt,
      projectRoot: record.projectRoot,
      config: record.config,
      resumeSessionId: record.claudeSessionId,
    });
    record.current = run;

    const manager = this.processManager as ClaudeProcessManager;
    let sawTerminal = false;
    let failure: string | undefined;
    const stderrLines: string[] = [];

    const stdoutDone = new Promise<void>((resolve) => {
      manager.watchStdout(
        run.child,
        (line) => {
          const parsed = record.parser.parseLine(line);

          if (parsed.claudeSessionId && !record.claudeSessionId) {
            record.claudeSessionId = parsed.claudeSessionId;
          }
          for (const envelope of parsed.envelopes) {
            record.stream.publish(envelope);
          }
          if (parsed.terminal) {
            sawTerminal = true;
            failure = parsed.error;
            record.state = parsed.error ? 'failed' : 'completed';
            record.session.state = record.state;
          }
          // The first real event means the process is alive and working.
          if (record.state === 'initializing') {
            record.state = 'running';
            record.session.state = 'running';
          }
        },
        () => resolve(),
      );
    });

    manager.watchStderr(run.child, (line) => {
      // Keep a bounded tail; stderr is diagnostic, not the event stream.
      if (stderrLines.length < 50) stderrLines.push(line);
    });

    const [exitCode] = await Promise.all([run.exited, stdoutDone]);
    record.current = undefined;

    if (!sawTerminal) {
      // The process ended without a result message. That is a real failure and
      // must not leave the session looking like it is still working.
      const detail =
        stderrLines.length > 0
          ? stderrLines.join('\n')
          : `claude exited with code ${String(exitCode)} before producing a result`;
      record.state = 'failed';
      record.session.state = 'failed';
      record.stream.publish({
        eventId: `evt_${Date.now().toString(36)}`,
        eventType: 'session.failed',
        eventVersion: 1,
        sessionId: record.id,
        sequence: Number.MAX_SAFE_INTEGER,
        occurredAt: new Date(),
        payload: { error: detail, exitCode },
      } as never);
      failure = detail;
    }

    record.session.endTime = new Date();
    if (failure) {
      record.session.error = {
        code: 'CLAUDE_CODE_TURN_FAILED',
        message: failure,
        fatal: true,
        // A failed turn does not invalidate the conversation: --resume can
        // continue it, so a retry is meaningful.
        retryable: true,
      };
    }
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    const record = this.requireSession(sessionId);

    // Turns are sequential: Claude Code resumes a conversation by id, and two
    // concurrent runs against the same id would interleave unpredictably.
    if (record.turn) await record.turn.catch(() => undefined);

    if (record.state === 'cancelled' || record.state === 'failed') {
      throw new Error(`Session ${sessionId} is ${record.state}; cannot send a message`);
    }

    record.state = 'running';
    record.session.state = 'running';
    record.turn = this.runTurn(record, message);
    // Deliberately not awaited: delivery is the contract, not completion.
  }

  async sendInput(sessionId: string, data: string): Promise<void> {
    // Headless runs take their input as a prompt, not as terminal input, so
    // raw input is delivered the same way a message is.
    return this.sendMessage(sessionId, data);
  }

  streamEvents(sessionId: string, subscriber?: Partial<EventSubscriber>): EventStream {
    const record = this.requireSession(sessionId);
    if (subscriber) record.stream.subscribe(subscriber);
    return record.stream;
  }

  async requestApproval(
    _sessionId: string,
    action: ApprovalAction,
  ): Promise<{ approved: boolean; reason?: string }> {
    // Honest refusal. Interactive approval needs a --permission-prompt-tool
    // MCP host, which this adapter does not run; the capability is declared
    // `unsupported` so the gateway rejects such sessions before they start.
    // Reaching here means something bypassed that check.
    return {
      approved: false,
      reason:
        `Claude Code adapter cannot intercept "${action.type}" for approval. ` +
        'Policy is enforced through permission modes instead; run the session ' +
        "with approvalMode 'never' or 'auto'.",
    };
  }

  async submitApprovalDecision(
    _sessionId: string,
    approvalId: string,
    _approved: boolean,
    _reason?: string,
  ): Promise<void> {
    throw new Error(
      `Claude Code adapter has no pending approval "${approvalId}" to decide: ` +
        'it does not support approval interception.',
    );
  }

  async abortSession(sessionId: string, reason: string, force = false): Promise<void> {
    const record = this.requireSession(sessionId);

    if (record.current) {
      const manager = this.processManager as ClaudeProcessController;
      await manager.stop(record.current.child, force);
    }

    record.state = 'cancelled';
    record.session.state = 'cancelled';
    record.session.endTime = new Date();
    record.session.error = {
      code: 'CLAUDE_CODE_SESSION_ABORTED',
      message: reason,
      fatal: false,
      retryable: true,
    };

    record.stream.publish({
      eventId: `evt_${Date.now().toString(36)}_cancel`,
      eventType: 'session.cancelled',
      eventVersion: 1,
      sessionId,
      sequence: Number.MAX_SAFE_INTEGER - 1,
      occurredAt: new Date(),
      payload: { reason, force },
    } as never);
  }

  async collectDiff(sessionId: string): Promise<string> {
    const record = this.requireSession(sessionId);
    return safeGitDiff(record.projectRoot);
  }

  async getState(sessionId: string): Promise<SessionState> {
    return this.requireSession(sessionId).state;
  }

  async getSession(sessionId: string): Promise<Session | undefined> {
    return this.sessions.get(sessionId)?.session;
  }

  async cleanupSession(sessionId: string): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (!record) return;

    if (record.current) {
      await this.processManager.stop(record.current.child, true).catch(() => undefined);
    }
    record.stream.close();
    this.sessions.delete(sessionId);
  }

  // ------------------------------------------------------------- optional

  async resumeSession(sessionId: string): Promise<void> {
    const record = this.requireSession(sessionId);
    if (!record.claudeSessionId) {
      throw new Error(
        `Session ${sessionId} has no Claude Code session id yet; it never started a turn.`,
      );
    }
    record.state = 'running';
    record.session.state = 'running';
  }

  /** The Claude Code session id is the checkpoint: --resume restores from it. */
  async checkpointSession(sessionId: string): Promise<string> {
    const record = this.requireSession(sessionId);
    if (!record.claudeSessionId) {
      throw new Error(`Session ${sessionId} has not produced a Claude Code session id yet`);
    }
    return record.claudeSessionId;
  }

  async shutdown(): Promise<void> {
    await Promise.all(Array.from(this.sessions.keys()).map((id) => this.cleanupSession(id)));
  }

  private requireSession(sessionId: string): ClaudeSession {
    const record = this.sessions.get(sessionId);
    if (!record) throw new Error(`Unknown Claude Code session: ${sessionId}`);
    return record;
  }
}

export function createClaudeCodeAdapter(options?: ClaudeProcessOptions): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter(undefined, options);
}
