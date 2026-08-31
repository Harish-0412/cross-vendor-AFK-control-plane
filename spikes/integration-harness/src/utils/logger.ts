export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: Date;
  context?: Record<string, any>;
}

class Logger {
  private level: LogLevel;
  private levels: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3
  };

  constructor(level: LogLevel = 'info') {
    this.level = level;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return this.levels[level] >= this.levels[this.level];
  }

  private format(entry: LogEntry): string {
    const ts = entry.timestamp.toISOString();
    const ctx = entry.context ? ` ${JSON.stringify(entry.context)}` : '';
    return `[${ts}] ${entry.level.toUpperCase()}: ${entry.message}${ctx}`;
  }

  debug(message: string, context?: Record<string, any>): void {
    if (this.shouldLog('debug')) {
      console.log(this.format({ level: 'debug', message, timestamp: new Date(), context }));
    }
  }

  info(message: string, context?: Record<string, any>): void {
    if (this.shouldLog('info')) {
      console.log(this.format({ level: 'info', message, timestamp: new Date(), context }));
    }
  }

  warn(message: string, context?: Record<string, any>): void {
    if (this.shouldLog('warn')) {
      console.warn(this.format({ level: 'warn', message, timestamp: new Date(), context }));
    }
  }

  error(message: string, context?: Record<string, any>): void {
    if (this.shouldLog('error')) {
      console.error(this.format({ level: 'error', message, timestamp: new Date(), context }));
    }
  }
}

export const logger = new Logger(process.env.LOG_LEVEL as LogLevel || 'info');

export function createLogger(level: LogLevel): Logger {
  return new Logger(level);
}