/**
 * Drive a full-screen terminal program the way a person would.
 *
 * Freebuff has no headless mode: its CLI accepts no prompt argument and no
 * print flag, and it refuses to run unless stdin and stdout are a TTY. So the
 * only way to use it unattended is to give it a real pseudo-terminal, type
 * into it, and read the screen back.
 *
 * Reading "the screen" means emulating a terminal, not scraping bytes: the
 * program repaints regions with cursor moves and colour codes, so the raw
 * stream is a sequence of edits rather than text. A headless xterm applies
 * those edits and gives back what a person would see.
 */
import { spawn as spawnPty, type IPty } from '@lydell/node-pty';
import xterm from '@xterm/headless';

const { Terminal } = xterm;

export interface TerminalDriverOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
}

/** Bracketed paste: the program receives multi-line text as one paste, not as many Enters. */
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export class TerminalDriver {
  private readonly pty: IPty;
  private readonly screen: InstanceType<typeof Terminal>;
  private lastOutputAt = Date.now();
  private totalOutput = 0;
  private exitInfo: { exitCode: number; signal?: number | undefined } | undefined;
  private readonly exitListeners = new Set<(code: number) => void>();

  constructor(options: TerminalDriverOptions) {
    const cols = options.cols ?? 140;
    const rows = options.rows ?? 48;
    this.screen = new Terminal({ cols, rows, scrollback: 5_000, allowProposedApi: true });
    this.pty = spawnPty(options.command, options.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: options.cwd,
      env: options.env,
    });
    this.pty.onData((data) => {
      this.lastOutputAt = Date.now();
      this.totalOutput += data.length;
      this.screen.write(data);
    });
    this.pty.onExit(({ exitCode, signal }) => {
      this.exitInfo = { exitCode, signal };
      for (const listener of this.exitListeners) listener(exitCode);
    });
  }

  get pid(): number {
    return this.pty.pid;
  }

  get exited(): boolean {
    return this.exitInfo !== undefined;
  }

  get exitCode(): number | undefined {
    return this.exitInfo?.exitCode;
  }

  get bytesSeen(): number {
    return this.totalOutput;
  }

  /** Milliseconds since the program last wrote anything. */
  idleFor(now = Date.now()): number {
    return now - this.lastOutputAt;
  }

  onExit(listener: (code: number) => void): void {
    if (this.exitInfo) listener(this.exitInfo.exitCode);
    else this.exitListeners.add(listener);
  }

  /** Type text as a single paste, then press Enter. */
  submit(text: string): void {
    // Carriage returns inside the paste would read as Enter to some programs;
    // plain newlines inside a bracketed paste are line breaks.
    const body = text.replace(/\r\n?/g, '\n');
    this.pty.write(`${PASTE_START}${body}${PASTE_END}`);
    // Enter goes separately, after the program has taken the paste.
    setTimeout(() => {
      if (!this.exited) this.pty.write('\r');
    }, 150);
  }

  /** Send raw keystrokes (e.g. Ctrl+C is '\x03'). */
  press(keys: string): void {
    if (!this.exited) this.pty.write(keys);
  }

  /**
   * The screen as text: the scrollback plus the visible rows, with trailing
   * blanks removed. Waits for pending writes to be applied first.
   */
  async text(): Promise<string> {
    await new Promise<void>((resolve) => this.screen.write('', resolve));
    const buffer = this.screen.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
    }
    while (lines.length && lines[lines.length - 1]!.trim() === '') lines.pop();
    return lines.join('\n');
  }

  /** Resolves once the program has exited, killing it if it takes longer than `graceMs`. */
  stop(graceMs = 1_000): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.kill();
        // A killed child is reported through onExit too; don't wait forever for it.
        setTimeout(resolve, 500).unref?.();
      }, graceMs);
      timer.unref?.();
      this.onExit(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  kill(): void {
    if (this.exited) return;
    try {
      this.pty.kill();
    } catch {
      /* already gone */
    }
  }

  dispose(): void {
    this.kill();
    this.screen.dispose();
  }
}
