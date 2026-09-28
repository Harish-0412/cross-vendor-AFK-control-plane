/**
 * Recognising "this agent has hit its plan or rate limit" in what a session
 * left behind, and when that limit resets.
 *
 * Two tiers, because agents write code about rate limits all the time:
 *
 *  - Provider phrases ("Claude AI usage limit reached", "You've hit your usage
 *    limit") are what the CLIs themselves print. They count wherever they
 *    appear near the end of the session.
 *  - Generic words ("429", "rate limit", "quota") count only in the error of
 *    a session that did not complete. A finished session that merely talks
 *    about rate limiting is not limited.
 */

export interface LimitSignal {
  message: string;
  resetsAt: Date;
  resetKnown: boolean;
}

export interface LimitInput {
  agentId: string;
  state: string;
  error?: string | null | undefined;
  /** The last part of what the agent printed. */
  tail: string;
  now?: Date;
}

const PROVIDER_PHRASES: RegExp[] = [
  /Claude AI usage limit reached[^\n]*/i,
  /(?:5-hour|five-hour|weekly|session|opus|daily) limit reached[^\n]*/i,
  /You(?:'|’)ve (?:hit|reached) your (?:usage )?limit[^\n]*/i,
  /usage_limit_reached[^\n]*/i,
  /You have (?:exceeded|reached) your (?:usage|rate|plan) limit[^\n]*/i,
  /RESOURCE_EXHAUSTED[^\n]*/i,
  /insufficient_quota[^\n]*/i,
];

const GENERIC_PHRASES: RegExp[] = [
  /\b429\b[^\n]*/,
  /rate[ _-]?limit(?:ed| exceeded| reached)?[^\n]*/i,
  /quota (?:exceeded|exhausted)[^\n]*/i,
  /too many requests[^\n]*/i,
  /exceeded retry limit[^\n]*/i,
];

/** The reset window assumed when the provider does not say, per agent. */
const DEFAULT_WINDOW_MINUTES: Record<string, number> = {
  'claude-code': 5 * 60,
  claude: 5 * 60,
  codex: 5 * 60,
  antigravity: 60,
  opencode: 60,
};

export function detectLimit(input: LimitInput): LimitSignal | null {
  const now = input.now ?? new Date();
  const error = (input.error ?? '').slice(-4_000);
  const tail = input.tail.slice(-3_000);

  let message: string | undefined;
  for (const phrase of PROVIDER_PHRASES) {
    const found = phrase.exec(error) ?? phrase.exec(tail);
    if (found) {
      message = found[0];
      break;
    }
  }
  if (!message && input.state !== 'completed') {
    for (const phrase of GENERIC_PHRASES) {
      const found = phrase.exec(error);
      if (found) {
        message = found[0];
        break;
      }
    }
  }
  if (!message) return null;

  const source = `${message}\n${error}\n${tail}`;
  const reset = parseReset(source, now);
  if (reset) return { message: clean(message), resetsAt: reset, resetKnown: true };
  const minutes = DEFAULT_WINDOW_MINUTES[input.agentId] ?? 60;
  return {
    message: clean(message),
    resetsAt: new Date(now.getTime() + minutes * 60_000),
    resetKnown: false,
  };
}

function clean(message: string): string {
  return message
    .replace(/\|\d{10}\b/, '')
    .trim()
    .slice(0, 240);
}

/** When the text says the limit resets, or null when it does not say. */
export function parseReset(text: string, now: Date): Date | null {
  // Claude Code: "Claude AI usage limit reached|1727467200" (unix seconds).
  const unix = /limit reached\|(\d{10})\b/i.exec(text);
  if (unix) return new Date(Number(unix[1]) * 1000);

  // "try again in 2 days 3 hours 4 minutes", "in 2h 13m", "in 45 minutes".
  const relative = /(?:try again|resets?|available again)\s+in\s+([^.\n]+)/i.exec(text);
  if (relative) {
    const minutes = durationMinutes(relative[1]!);
    if (minutes > 0) return new Date(now.getTime() + minutes * 60_000);
  }

  // "resets 3pm (Asia/Calcutta)", "try again at 3:45 PM", "resets Mon 10am".
  const clock =
    /(?:resets?|try again|available again)(?:\s+at)?\s+(?:(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([A-Za-z_]+\/[A-Za-z_/]+|UTC)\))?/i.exec(
      text,
    );
  if (clock && (clock[4] || clock[3])) {
    let hour = Number(clock[2]) % 12;
    if (!clock[4]) hour = Number(clock[2]);
    else if (clock[4].toLowerCase() === 'pm') hour += 12;
    const minute = Number(clock[3] ?? 0);
    if (hour < 24 && minute < 60) {
      return nextClockTime(now, hour, minute, clock[5], clock[1]);
    }
  }
  return null;
}

function durationMinutes(text: string): number {
  let minutes = 0;
  const unit = (pattern: RegExp, factor: number) => {
    const match = pattern.exec(text);
    if (match) minutes += Number(match[1]) * factor;
  };
  unit(/(\d+)\s*(?:d|days?)\b/i, 24 * 60);
  unit(/(\d+)\s*(?:h|hrs?|hours?)\b/i, 60);
  unit(/(\d+)\s*(?:m|mins?|minutes?)\b/i, 1);
  unit(/(\d+)\s*(?:s|secs?|seconds?)\b/i, 1 / 60);
  return Math.ceil(minutes);
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * The next moment the wall clock in `timeZone` reads hour:minute (on
 * `weekday`, when given). Without a zone the message was printed in the
 * user's own zone, which the server does not know; UTC is the honest guess
 * and the result is marked as known anyway because the time itself is.
 */
function nextClockTime(
  now: Date,
  hour: number,
  minute: number,
  timeZone: string | undefined,
  weekday: string | undefined,
): Date {
  let parts: { hour: number; minute: number; weekday: number };
  try {
    const format = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone ?? 'UTC',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
      hourCycle: 'h23',
    });
    const read = Object.fromEntries(format.formatToParts(now).map((p) => [p.type, p.value]));
    parts = {
      hour: Number(read['hour']),
      minute: Number(read['minute']),
      weekday: WEEKDAYS.indexOf(String(read['weekday']).slice(0, 3).toLowerCase()),
    };
  } catch {
    parts = { hour: now.getUTCHours(), minute: now.getUTCMinutes(), weekday: now.getUTCDay() };
  }
  const nowMinutes = parts.hour * 60 + parts.minute;
  let delta = hour * 60 + minute - nowMinutes;
  if (weekday) {
    const target = WEEKDAYS.indexOf(weekday.slice(0, 3).toLowerCase());
    let days = (target - parts.weekday + 7) % 7;
    if (days === 0 && delta <= 0) days = 7;
    delta += days * 24 * 60;
  } else if (delta <= 0) {
    delta += 24 * 60;
  }
  return new Date(now.getTime() + delta * 60_000 - now.getSeconds() * 1000);
}
