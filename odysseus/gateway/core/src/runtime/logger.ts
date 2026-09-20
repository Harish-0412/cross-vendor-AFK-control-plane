/**
 * Structured logging for the gateway runtime.
 *
 * Emits one JSON object per line to stdout so logs are greppable and
 * machine-parseable, and a compact human-readable form when stdout is a TTY.
 * Every line carries the bindings of the logger it came from, so a
 * session-scoped child logger stamps `sessionId` on everything without the
 * call site having to remember.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  error: 50,
  warn: 40,
  info: 30,
  debug: 20,
  trace: 10,
};

export interface LogRecord {
  ts: string;
  level: LogLevel;
  event: string;
  [field: string]: unknown;
}

export interface Logger {
  error(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  debug(event: string, fields?: Record<string, unknown>): void;
  trace(event: string, fields?: Record<string, unknown>): void;
  /** A logger that stamps additional fields onto every record. */
  child(bindings: Record<string, unknown>): Logger;
  readonly level: LogLevel;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Human-readable output. Defaults to true when stdout is a TTY. */
  pretty?: boolean;
  /** Fields stamped onto every record. */
  bindings?: Record<string, unknown>;
  /** Where records go. Defaults to stdout. Injectable for tests. */
  sink?: (line: string) => void;
}

const GREY = '\x1b[90m';
const RESET = '\x1b[0m';
const LEVEL_COLOR: Record<LogLevel, string> = {
  error: '\x1b[31m',
  warn: '\x1b[33m',
  info: '\x1b[36m',
  debug: '\x1b[90m',
  trace: '\x1b[90m',
};

/**
 * Errors do not survive JSON.stringify (message and stack are non-enumerable),
 * so they are unwrapped into plain fields before serialisation. A log line that
 * silently drops the error is worse than no log line at all.
 */
function normalizeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value instanceof Error) {
      out[key] = value.message;
      out[`${key}Stack`] = value.stack;
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function formatPretty(record: LogRecord): string {
  const { ts, level, event, ...rest } = record;
  const time = typeof ts === 'string' ? ts.slice(11, 23) : '';
  const color = LEVEL_COLOR[level] ?? '';
  const fields = Object.entries(rest)
    .filter(([key]) => !key.endsWith('Stack'))
    .map(([key, value]) => `${GREY}${key}=${RESET}${formatValue(value)}`)
    .join(' ');
  return `${GREY}${time}${RESET} ${color}${level.toUpperCase().padEnd(5)}${RESET} ${event}${
    fields ? ` ${fields}` : ''
  }`;
}

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value.includes(' ') ? JSON.stringify(value) : value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

class StructuredLogger implements Logger {
  readonly level: LogLevel;
  private readonly pretty: boolean;
  private readonly bindings: Record<string, unknown>;
  private readonly sink: (line: string) => void;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? 'info';
    this.pretty = options.pretty ?? Boolean(process.stdout.isTTY);
    this.bindings = options.bindings ?? {};
    this.sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  }

  private emit(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) return;

    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      event,
      ...normalizeFields(this.bindings),
      ...normalizeFields(fields ?? {}),
    };

    try {
      this.sink(this.pretty ? formatPretty(record) : JSON.stringify(record));
    } catch {
      // Logging must never take the process down.
    }
  }

  error(event: string, fields?: Record<string, unknown>): void {
    this.emit('error', event, fields);
  }
  warn(event: string, fields?: Record<string, unknown>): void {
    this.emit('warn', event, fields);
  }
  info(event: string, fields?: Record<string, unknown>): void {
    this.emit('info', event, fields);
  }
  debug(event: string, fields?: Record<string, unknown>): void {
    this.emit('debug', event, fields);
  }
  trace(event: string, fields?: Record<string, unknown>): void {
    this.emit('trace', event, fields);
  }

  child(bindings: Record<string, unknown>): Logger {
    return new StructuredLogger({
      level: this.level,
      pretty: this.pretty,
      bindings: { ...this.bindings, ...bindings },
      sink: this.sink,
    });
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new StructuredLogger(options);
}

/** A logger that discards everything. For tests and library defaults. */
export function createNullLogger(): Logger {
  return createLogger({ level: 'error', sink: () => undefined });
}
