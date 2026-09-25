/**
 * The interactive screen for `pnpm gateway`.
 *
 * The gateway's structured log is the single source of truth: this module is a
 * logger sink that reads each record and projects it into plain language — a
 * live status line at the bottom, and short explanations above it. The raw
 * records are still kept, one JSON object per line, in the log file, so
 * nothing a bug report needs is lost to the prettier screen.
 *
 * Only used on an interactive terminal. Piped or redirected output keeps the
 * JSON log unchanged.
 */
import { appendFileSync, mkdirSync, renameSync, statSync, writeSync } from 'node:fs';
import { arch, homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';

import {
  bold,
  card,
  dim,
  hideCursor,
  intro,
  mix,
  paint,
  palette,
  showCursor,
  visibleWidth,
  write,
  type RGB,
} from './pair-ui';

type Phase = 'starting' | 'connecting' | 'online' | 'reconnecting' | 'local' | 'stopping' | 'stopped';

interface Problem {
  title: string;
  hint: string;
}

interface AgentRecord {
  adapter: string;
  installed: boolean;
  version?: string;
  health: string;
}

interface Note {
  check: string;
  detail: string;
  remedy?: string;
}

type LogRecord = Record<string, unknown> & { level?: string; event?: string };

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const WAKE_HINT_AFTER_MS = 8_000;

const AGENT_NAMES: Record<string, string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
  freebuff: 'Freebuff',
};

const PLATFORM_NAMES: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
};

// The installed CLI is `odysseus`; a repository checkout runs the pnpm scripts.
const CLI = process.env['ODYSSEUS_CLI_COMMAND'] ?? 'pnpm';
const withCli = (text: string) => text.replace(/\bpnpm (pair|gateway|grants)\b/g, `${CLI} $1`);

const amber = palette.amber;
const green = palette.green;
const red = palette.red;
const violet = palette.violet;
const slate = palette.slate;

// ------------------------------------------------------------ plain language

const PROBLEMS: Array<[RegExp, Problem]> = [
  [
    /DEVICE_NOT_TRUSTED|does not know this device/i,
    {
      title: 'This PC is not paired with your account on this server',
      hint: 'Run `pnpm pair`, approve it in the dashboard, then start `pnpm gateway` again. Still retrying in case a pairing is being approved right now.',
    },
  ],
  [
    /revoked|DEVICE_REVOKED/i,
    {
      title: 'This PC was removed from your account',
      hint: 'Pair it again with `pnpm pair`, then run `pnpm gateway`.',
    },
  ],
  [
    /timed out|ETIMEDOUT/i,
    {
      title: 'The Odysseus server did not answer in time',
      hint: 'If nobody has used it for a while, it is waking up — that can take up to a minute. Retrying automatically.',
    },
  ],
  [
    /ENOTFOUND|EAI_AGAIN|getaddrinfo/i,
    {
      title: 'Cannot reach the internet',
      hint: 'This PC could not look up the Odysseus server. Check Wi-Fi, a VPN, or a firewall. Retrying automatically.',
    },
  ],
  [
    /ECONNREFUSED/i,
    {
      title: 'The server refused the connection',
      hint: 'It is probably restarting after an update. Retrying automatically.',
    },
  ],
  [
    /\b50[234]\b|Unexpected server response/i,
    {
      title: 'The server is starting up or busy',
      hint: 'Retrying automatically.',
    },
  ],
  [
    /certificate|CERT_|self[- ]signed/i,
    {
      title: 'The secure connection could not be verified',
      hint: 'Something between this PC and the server — a proxy or antivirus — is intercepting HTTPS. Try another network.',
    },
  ],
  [
    /\b40[13]\b|Unauthorized|Forbidden/i,
    {
      title: 'The server did not accept this PC',
      hint: 'Its pairing may be for a different account or server. Run `pnpm pair` again if this keeps happening.',
    },
  ],
  [
    /ECONNRESET|socket hang up|\b1006\b|closed/i,
    {
      title: 'The connection dropped',
      hint: 'Usually a network blip or a server restart. Retrying automatically.',
    },
  ],
  [
    /heartbeat/i,
    {
      title: 'The server stopped responding',
      hint: 'The link went quiet, so the gateway is opening a fresh one.',
    },
  ],
];

export function explain(detail: unknown): Problem {
  const text = typeof detail === 'string' ? detail : detail ? String(detail) : '';
  for (const [pattern, problem] of PROBLEMS) {
    if (pattern.test(text)) return problem;
  }
  return { title: 'Connection problem', hint: text || 'Retrying automatically.' };
}

function friendlyNote(note: Note): string {
  if (note.check === 'sandbox') {
    return 'Windows has no sandbox, so agents run with your own permissions. Keep approval mode on for anything that writes files.';
  }
  if (note.check === 'clock-skew') {
    return 'Could not compare clocks with the server yet — it may still be waking up.';
  }
  return note.detail.replace(new RegExp(`^${note.check}:\\s*`), '');
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Word-wrap plain text to the terminal, indenting every line. */
function wrap(text: string, indent: number): string[] {
  const width = Math.max(30, columns() - indent - 2);
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    if (current && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines.map((line) => ' '.repeat(indent) + line);
}

function rank(agent: AgentRecord): number {
  if (!agent.installed) return 2;
  return agent.health === 'healthy' ? 0 : 1;
}

function columns(): number {
  return process.stdout.columns || 100;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

// ------------------------------------------------------------------ the screen

export interface GatewayUi {
  readonly logFile: string;
  intro(): Promise<void>;
  /** Logger sink: receives one JSON record per call. */
  sink(line: string): void;
  /** Hand the terminal to an interactive prompt. */
  suspend(): void;
  resume(): void;
}

class Screen implements GatewayUi {
  readonly logFile = join(homedir(), '.odysseus', 'logs', 'gateway.log');

  private phase: Phase = 'starting';
  private phaseSince = Date.now();
  private onlineSince = 0;
  private outageSince = 0;
  private attempt = 0;
  private retryAt = 0;
  private webClients = 0;
  private everOnline = false;
  private host = 'the Odysseus server';
  private agents: AgentRecord[] = [];
  private notes: Note[] = [];
  private failures: Note[] = [];
  private announced = new Set<string>();
  private lastProblem: string | undefined;
  private fatalShown = false;
  private frame = 0;
  private timer: NodeJS.Timeout | undefined;
  private statusShown = false;
  private suspended = false;
  private held: string[] = [];

  constructor() {
    try {
      mkdirSync(dirname(this.logFile), { recursive: true });
      if ((statSync(this.logFile, { throwIfNoEntry: false })?.size ?? 0) > MAX_LOG_BYTES) {
        renameSync(this.logFile, `${this.logFile}.1`);
      }
    } catch {
      // A missing log file must never stop the gateway.
    }
    process.on('exit', (code) => this.onExit(code));
  }

  async intro(): Promise<void> {
    await intro('AFK gateway  ·  keeps this PC connected to your dashboard');
  }

  sink(line: string): void {
    try {
      appendFileSync(this.logFile, `${line}\n`);
    } catch {
      // Same as above: logging is best-effort.
    }
    let record: LogRecord;
    try {
      record = JSON.parse(line) as LogRecord;
    } catch {
      return;
    }
    try {
      this.handle(record);
    } catch {
      // The screen is a view; a rendering bug must not take the gateway down.
    }
  }

  suspend(): void {
    this.clearStatus();
    this.suspended = true;
    showCursor();
  }

  resume(): void {
    this.suspended = false;
    const held = this.held;
    this.held = [];
    for (const line of held) write(line);
    if (this.timer) hideCursor();
    this.draw();
  }

  // ---------------------------------------------------------------- events

  private handle(record: LogRecord): void {
    const detail = typeof record['detail'] === 'string' ? record['detail'] : undefined;

    switch (record.event) {
      case 'gateway.identity':
        this.showIdentity(record);
        return;
      case 'gateway.agent':
        this.agents.push({
          adapter: String(record['adapter']),
          installed: record['installed'] === true,
          ...(typeof record['version'] === 'string' ? { version: record['version'] } : {}),
          health: String(record['health'] ?? 'unknown'),
        });
        return;
      case 'runtime.state_change':
        this.onStateChange(String(record['to']), typeof record['reason'] === 'string' ? record['reason'] : '');
        return;
      case 'preflight.warn':
      case 'preflight.fail': {
        const note: Note = {
          check: String(record['check'] ?? ''),
          detail: detail ?? '',
          ...(typeof record['remedy'] === 'string' ? { remedy: record['remedy'] } : {}),
        };
        (record.event === 'preflight.fail' ? this.failures : this.notes).push(note);
        return;
      }
      case 'preflight.warning':
      case 'preflight.failed':
      case 'adapter.registered':
      // The agent list shown next already says which agents are unavailable.
      case 'adapter.unavailable':
      case 'adapter.discovery_warning':
        return;
      case 'tunnel.reconnect': {
        const match = /attempt (\d+) in (\d+)ms/i.exec(detail ?? '');
        if (match) {
          this.attempt = Number(match[1]);
          this.retryAt = Date.now() + Number(match[2]);
        }
        return;
      }
      case 'tunnel.error':
        this.problem(explain(detail));
        return;
      case 'runtime.initial_connect_failed':
        this.problem(explain(record['error']));
        return;
      case 'tunnel.device_not_registered':
        this.problem(explain('DEVICE_NOT_TRUSTED'));
        return;
      case 'runtime.failure':
        if (/heartbeat/i.test(detail ?? '')) this.problem(explain(detail));
        return;
      case 'runtime.fatal':
        this.showFatal(String(record['class'] ?? ''), String(record['reason'] ?? ''));
        return;
      case 'web_clients.connected':
      case 'web_clients.disconnected':
        this.onWebClients(record.event === 'web_clients.connected', Number(record['clients'] ?? 0));
        return;
      case 'integration.request':
        this.print(
          `  ${paint(violet, '◆')} ${bold(`Access request for ${AGENT_NAMES[String(record['integration'])] ?? String(record['integration'])}`)} ${dim('— review it below')}`,
        );
        return;
      case 'integration.access_refused':
        this.print(
          `  ${paint(amber, '!')} ${String(record['integration'])} was not allowed to read ${String(record['scope'])}${detail ? dim(` — ${detail}`) : ''}`,
        );
        return;
      case 'runtime.signal':
        if (String(record['action']).includes('abort')) {
          this.print(`  ${paint(red, '■')} ${bold('Forcing stop')} ${dim('— cancelling running sessions')}`);
        } else if (this.phase !== 'stopping') {
          const active = Number(record['activeSessions'] ?? 0);
          this.print(
            `  ${paint(amber, '■')} ${bold('Stopping')} ${dim(active > 0 ? `— letting ${plural(active, 'session')} finish. Press Ctrl+C again to force.` : '— closing the connection')}`,
          );
        }
        this.setPhase('stopping');
        return;
      case 'runtime.drain_timeout':
        this.print(`  ${paint(amber, '!')} Sessions took too long to finish, so they were cancelled.`);
        return;
      case 'config.warning':
        this.print(`  ${paint(amber, '!')} ${detail ?? 'Configuration warning'}`);
        return;
      default:
        if (record.level === 'warn' || record.level === 'error') {
          const words = String(record.event ?? 'problem').replace(/[._]/g, ' ');
          const color = record.level === 'error' ? red : amber;
          this.print(`  ${paint(color, record.level === 'error' ? '✖' : '!')} ${words}${detail ? dim(` — ${detail}`) : ''}`);
        }
    }
  }

  private onStateChange(to: string, reason: string): void {
    switch (to) {
      case 'preflight':
        this.showAgents();
        return;
      case 'local_ready':
        this.showChecks();
        return;
      case 'connecting':
        this.setPhase('connecting');
        return;
      case 'online':
        this.onOnline();
        return;
      case 'degraded':
        if (/no control plane/i.test(reason)) {
          this.print(`  ${paint(slate, '○')} ${bold('Local only')} ${dim('— no server is configured, so the dashboard cannot see this PC.')}`);
          this.setPhase('local');
        } else {
          this.onLost();
        }
        return;
      case 'draining':
      case 'aborting':
        this.setPhase('stopping');
        return;
      case 'stopped':
        this.setPhase('stopped');
        return;
      default:
        return;
    }
  }

  private onOnline(): void {
    const now = Date.now();
    if (!this.everOnline) {
      this.print(
        `  ${paint(green, '✔')} ${bold('Connected')} ${dim('—')} this PC is now ${paint(green, bold('Online'))} in your dashboard ${dim(`(${formatDuration(now - this.phaseSince)})`)}`,
      );
      this.print();
      this.print(dim('  Leave this window open. Closing it takes this PC offline.'));
      this.print();
    } else {
      this.print(
        `  ${paint(green, '✔')} ${bold('Back online')} ${dim(`after ${formatDuration(now - (this.outageSince || now))} offline`)}`,
      );
    }
    this.everOnline = true;
    this.onlineSince = now;
    this.outageSince = 0;
    this.attempt = 0;
    this.retryAt = 0;
    this.announced.clear();
    this.lastProblem = undefined;
    this.setPhase('online');
  }

  private onLost(): void {
    if (this.phase === 'stopping' || this.phase === 'stopped') return;
    if (!this.everOnline) return; // still the first connection; the status line covers it
    if (this.phase === 'online') {
      this.outageSince = Date.now();
      this.print(
        `  ${paint(amber, '!')} ${bold('Lost connection to Odysseus')} ${dim('— reconnecting automatically. The dashboard shows this PC as offline meanwhile.')}`,
      );
    }
    this.setPhase('reconnecting');
  }

  private onWebClients(connected: boolean, clients: number): void {
    const before = this.webClients;
    this.webClients = connected ? Math.max(clients, 1) : 0;
    if (connected && before === 0) {
      this.print(`  ${paint(violet, '◉')} Dashboard opened ${dim(`— ${plural(this.webClients, 'browser')} watching this PC`)}`);
    } else if (!connected && before > 0) {
      this.print(`  ${paint(slate, '○')} Dashboard closed ${dim('— reading local chats is paused until it is opened again')}`);
    }
  }

  private problem(problem: Problem): void {
    if (this.phase === 'stopping' || this.phase === 'stopped') return;
    this.lastProblem = problem.title;
    if (this.announced.has(problem.title)) return;
    this.announced.add(problem.title);
    this.print(`  ${paint(red, '✖')} ${bold(problem.title)}`);
    for (const line of wrap(problem.hint, 5)) this.print(dim(line));
  }

  // --------------------------------------------------------------- sections

  private showIdentity(record: LogRecord): void {
    const target = String(record['target'] ?? '');
    try {
      this.host = target && target !== '(local-only)' ? new URL(target).host : 'not configured';
    } catch {
      this.host = target;
    }
    const words = String(record['fingerprint'] ?? '').split(' ').filter(Boolean);

    card(
      'THIS PC',
      [
        `${dim('Computer   ')}  ${bold(hostname())}  ${dim(`${PLATFORM_NAMES[process.platform] ?? process.platform} · ${arch()} · Node ${process.version.slice(1)}`)}`,
        `${dim('Server     ')}  ${paint(palette.cream, this.host)}`,
        `${dim('Fingerprint')}  ${words.slice(0, 4).map((word) => paint(palette.amber, word)).join(dim(' · '))}${words.length > 4 ? dim(' …') : ''}`,
      ],
      violet,
    );
    write();
    write(`  ${paint(violet, '◆')} ${bold('Starting up')}`);
    write(`  ${paint(green, '✔')} Device identity loaded`);
    this.setPhase('starting');
    this.startTicker();
  }

  private showAgents(): void {
    const agents = this.agents
      .filter((agent) => agent.adapter !== 'mock')
      .sort((a, b) => rank(a) - rank(b));
    const ready = agents.filter((agent) => agent.installed && agent.health !== 'unhealthy');

    if (ready.length > 0) {
      this.print(`  ${paint(green, '✔')} Found ${plural(ready.length, 'coding agent')} on this PC`);
    } else {
      this.print(
        `  ${paint(amber, '!')} ${bold('No coding agents found')} ${dim('— install Codex, Claude Code or OpenCode to run sessions from your phone')}`,
      );
    }

    const nameWidth = Math.max(...agents.map((agent) => (AGENT_NAMES[agent.adapter] ?? agent.adapter).length), 0);
    for (const agent of agents) {
      const name = (AGENT_NAMES[agent.adapter] ?? agent.adapter).padEnd(nameWidth);
      if (!agent.installed) {
        this.print(`      ${paint(slate, '○')} ${dim(name)}  ${dim('not installed')}`);
      } else if (agent.health === 'healthy') {
        this.print(`      ${paint(green, '●')} ${name}  ${dim(agent.version ?? '')}`);
      } else {
        this.print(`      ${paint(amber, '◐')} ${name}  ${dim(`${agent.version ?? ''}  limited — may need signing in`)}`);
      }
    }
  }

  private showChecks(): void {
    const suffix = this.notes.length > 0 ? dim(`  ${plural(this.notes.length, 'note')}`) : '';
    this.print(`  ${paint(green, '✔')} Safety checks passed${suffix}`);
    for (const note of this.notes) {
      const [first, ...rest] = wrap(friendlyNote(note), 8);
      this.print(`      ${paint(amber, '!')} ${first!.trimStart()}`);
      for (const line of rest) this.print(line);
    }
  }

  private showFatal(failureClass: string, reason: string): void {
    this.fatalShown = true;
    this.setPhase('stopped');
    this.stopTicker();

    let title: string;
    let lines: string[];
    if (failureClass === 'config' && this.failures.length > 0) {
      title = 'Setup problem';
      lines = this.failures.flatMap((failure) => [
        `${paint(red, '✖')} ${friendlyNote(failure)}`,
        ...(failure.remedy ? [dim(`  ${failure.remedy}`)] : []),
      ]);
    } else if (failureClass === 'auth_fatal') {
      title = 'This PC is no longer allowed to connect';
      lines = [
        'Its pairing was revoked, or it was removed from your account.',
        `Pair it again with ${bold('pnpm pair')}, then run ${bold('pnpm gateway')}.`,
      ];
    } else if (failureClass === 'protocol') {
      title = 'This gateway is out of date';
      lines = ['The server speaks a newer protocol.', `Run ${bold('git pull')} and ${bold('pnpm install')}, then start it again.`];
    } else if (/restart intensity/i.test(reason)) {
      title = 'Gave up after too many failures in a minute';
      lines = ['Check your internet connection, then run pnpm gateway again.'];
    } else {
      title = 'The gateway stopped unexpectedly';
      lines = [explain(reason).title, dim(`Details: ${this.logFile}`)];
    }

    write();
    card(`GATEWAY STOPPED · ${title.toUpperCase()}`, lines.map(withCli), red);
  }

  // ------------------------------------------------------------ live status

  private setPhase(phase: Phase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.phaseSince = Date.now();
    if (phase === 'stopped') this.stopTicker();
    this.draw();
  }

  private startTicker(): void {
    if (this.timer) return;
    hideCursor();
    this.timer = setInterval(() => {
      this.frame += 1;
      this.draw();
    }, 90);
    this.timer.unref();
  }

  private stopTicker(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.clearStatus();
    showCursor();
  }

  private print(text = ''): void {
    if (this.suspended) {
      this.held.push(text);
      return;
    }
    this.clearStatus();
    write(withCli(text));
    this.draw();
  }

  private clearStatus(): void {
    if (this.statusShown) process.stdout.write('\r\x1b[2K');
    this.statusShown = false;
  }

  private draw(): void {
    if (!this.timer || this.suspended) return;
    process.stdout.write(`\r\x1b[2K${this.statusLine()}`);
    this.statusShown = true;
  }

  private spinner(color: RGB): string {
    return paint(color, FRAMES[this.frame % FRAMES.length]!);
  }

  private statusLine(): string {
    const now = Date.now();
    let head: string;
    const extras: string[] = [];
    let hint = '';

    switch (this.phase) {
      case 'starting':
        head = `${this.spinner(violet)} ${bold('Starting up')}`;
        break;
      case 'connecting': {
        const waited = now - this.phaseSince;
        head = `${this.spinner(violet)} ${bold('Connecting to Odysseus')}`;
        extras.push(formatDuration(waited));
        if (waited >= WAKE_HINT_AFTER_MS && (!this.lastProblem || this.lastProblem === explain('timed out').title)) {
          extras.push(paint(amber, 'the server may be waking up — this can take a minute'));
        }
        break;
      }
      case 'reconnecting': {
        head = `${this.spinner(amber)} ${paint(amber, bold('Reconnecting'))}`;
        if (this.attempt > 0) extras.push(`attempt ${this.attempt}`);
        extras.push(this.retryAt > now ? `next try in ${Math.ceil((this.retryAt - now) / 1000)}s` : 'trying now');
        if (this.outageSince) extras.push(`offline for ${formatDuration(now - this.outageSince)}`);
        hint = 'Ctrl+C to stop';
        break;
      }
      case 'online': {
        const pulse = (Math.sin(this.frame / 4) + 1) / 2;
        head = `${paint(mix([22, 101, 52], green, 0.35 + 0.65 * pulse), '●')} ${paint(green, bold('Online'))}`;
        extras.push('linked to Odysseus');
        extras.push(this.webClients > 0 ? plural(this.webClients, 'browser') + ' watching' : 'no dashboard open');
        extras.push(`up ${formatDuration(now - this.onlineSince)}`);
        hint = 'Ctrl+C to stop';
        break;
      }
      case 'local':
        head = `${paint(slate, '○')} ${bold('Local only')}`;
        extras.push('not connected to a server');
        hint = 'Ctrl+C to stop';
        break;
      case 'stopping':
        head = `${this.spinner(amber)} ${bold('Stopping safely')}`;
        extras.push('finishing up');
        hint = 'Ctrl+C again to force';
        break;
      default:
        head = `${paint(slate, '○')} ${bold('Stopped')}`;
    }

    // Drop the least important parts first rather than letting the line wrap,
    // which would break the in-place redraw.
    const width = columns() - 1;
    const separator = dim('  ·  ');
    let line = `  ${head}`;
    for (const extra of extras) {
      const next = `${line}${separator}${dim(extra)}`;
      if (visibleWidth(next) > width - (hint ? visibleWidth(hint) + 2 : 0)) break;
      line = next;
    }
    if (hint) {
      const gap = width - visibleWidth(line) - visibleWidth(hint);
      if (gap >= 2) line += ' '.repeat(gap) + dim(hint);
    }
    return line;
  }

  // ------------------------------------------------------------------- exit

  private onExit(code: number): void {
    if (this.timer) clearInterval(this.timer);
    // TTY writes are asynchronous on Windows, and nothing asynchronous runs
    // after 'exit' — so the goodbye must be written synchronously.
    const out = (text = '') => {
      try {
        writeSync(1, `${withCli(text)}\n`);
      } catch {
        /* nothing left to report to */
      }
    };
    try {
      writeSync(1, `\r\x1b[2K\x1b[?25h`);
    } catch {
      /* ignore */
    }

    if (!this.fatalShown) {
      out();
      if (code === 0) {
        out(`  ${paint(slate, '○')} ${bold('Gateway stopped.')} ${dim('This PC now shows as offline in your dashboard.')}`);
      } else if (code === 75) {
        out(`  ${paint(red, '✖')} ${bold('Gateway stopped after repeated connection failures.')}`);
        out(dim('     Check your internet connection, then run pnpm gateway again.'));
      } else if (code === 77) {
        out(`  ${paint(red, '✖')} ${bold('This PC was removed from your account.')}`);
        out(dim('     Pair it again with pnpm pair, then run pnpm gateway.'));
      } else if (code === 78) {
        out(`  ${paint(red, '✖')} ${bold('The gateway could not start because of a setup problem (see above).')}`);
        out(dim('     Run pnpm gateway --print-config to see the settings it used.'));
      } else {
        out(`  ${paint(red, '✖')} ${bold(`The gateway stopped unexpectedly (code ${code}).`)}`);
      }
    }
    out(dim(`     Full log: ${this.logFile}`));
    out();
  }
}

export function createGatewayUi(): GatewayUi {
  return new Screen();
}
