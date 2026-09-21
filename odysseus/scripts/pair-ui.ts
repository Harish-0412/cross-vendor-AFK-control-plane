/**
 * Terminal rendering for `pnpm pair`.
 *
 * Everything degrades: when stdout is not a TTY (piped, CI, a log file), when
 * NO_COLOR is set, or when TERM=dumb, output is plain text with no escape codes
 * and no animation. The pairing code must still be readable in a log.
 */
import { ODYSSEUS_PORTRAIT } from './pair-art';

const out = process.stdout;

// FORCE_COLOR follows the common convention (chalk, Node itself): colour even
// when stdout is not a TTY, e.g. when recording the output.
export const rich =
  !process.env['NO_COLOR'] &&
  (Boolean(process.env['FORCE_COLOR']) || (Boolean(out.isTTY) && process.env['TERM'] !== 'dumb'));

export const animate =
  rich && !process.env['ODYSSEUS_NO_ANIMATION'] && !process.argv.includes('--no-animation');

// ------------------------------------------------------------------ colour

type RGB = readonly [number, number, number];

const ESC = '\x1b[';
const reset = rich ? `${ESC}0m` : '';

function fg([r, g, b]: RGB): string {
  return rich ? `${ESC}38;2;${r};${g};${b}m` : '';
}

const style = (code: string) => (text: string) => (rich ? `${ESC}${code}m${text}${reset}` : text);
export const bold = style('1');
export const dim = style('2');

export const palette = {
  ember: [255, 77, 0] as RGB,
  orange: [255, 138, 31] as RGB,
  amber: [255, 195, 107] as RGB,
  cream: [255, 241, 214] as RGB,
  violet: [139, 124, 255] as RGB,
  green: [74, 222, 128] as RGB,
  red: [248, 113, 113] as RGB,
  slate: [148, 163, 184] as RGB,
};

export const paint = (color: RGB, text: string) => (rich ? `${fg(color)}${text}${reset}` : text);

function mix(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** Ember at the top of the portrait, cooling to cream at the bottom. */
function gradientAt(t: number): RGB {
  const stops = [palette.ember, palette.orange, palette.amber, palette.cream];
  const scaled = Math.min(0.9999, Math.max(0, t)) * (stops.length - 1);
  const index = Math.floor(scaled);
  return mix(stops[index]!, stops[index + 1]!, scaled - index);
}

/**
 * How much light a glyph carries. Dense glyphs render brighter than sparse
 * ones, so the ASCII shading reads as a lit portrait rather than flat text.
 */
const DENSITY: Record<string, number> = {
  '@': 1, '%': 0.95, '#': 0.88, '*': 0.74, '+': 0.62, '=': 0.54, '-': 0.42, ':': 0.34, '.': 0.24,
};

function shade(color: RGB, glyph: string): RGB {
  const light = DENSITY[glyph] ?? 0.6;
  return mix([18, 12, 10], color, 0.25 + light * 0.75);
}

// ------------------------------------------------------------------ layout

const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;
export const visibleWidth = (text: string) => [...text.replace(ANSI, '')].length;

const columns = () => (out.isTTY && out.columns ? out.columns : 100);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function write(text = ''): void {
  out.write(`${text}\n`);
}

export function hideCursor(): void {
  if (rich) out.write(`${ESC}?25l`);
}

export function showCursor(): void {
  if (rich) out.write(`${ESC}?25h`);
}

/** A clickable link in terminals that support OSC 8; plain text elsewhere. */
export function link(url: string, text = url): string {
  return rich ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : url;
}

function portraitLines(): string[] {
  const lines = ODYSSEUS_PORTRAIT.split('\n').map((line) => line.replace(/\s+$/, ''));
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  const indent = Math.min(
    ...lines.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length),
  );
  return lines.map((line) => line.slice(indent));
}

// ------------------------------------------------------------------- intro

/**
 * The opening: the portrait is revealed line by line, then the wordmark is
 * typed out. Skipped entirely on a terminal too narrow to hold the portrait,
 * where it would wrap into noise.
 */
export async function intro(): Promise<void> {
  const art = portraitLines();
  const artWidth = Math.max(...art.map((line) => line.length));
  const width = columns();
  const pad = ' '.repeat(Math.max(2, Math.floor((width - artWidth) / 2)));

  write();
  if (width >= artWidth + 4) {
    for (let row = 0; row < art.length; row += 1) {
      const base = gradientAt(row / (art.length - 1));
      const line = [...art[row]!]
        .map((glyph) => (glyph === ' ' ? ' ' : paint(shade(base, glyph), glyph)))
        .join('');
      write(pad + line);
      // Windows timers resolve at ~15ms, so one line per tick is the finest
      // reveal that looks the same on every platform.
      if (animate) await sleep(14);
    }
    write();
  }

  const mark = 'O  D  Y  S  S  E  U  S';
  const markPad = ' '.repeat(Math.max(2, Math.floor((width - mark.length) / 2)));
  out.write(markPad);
  for (let i = 0; i < mark.length; i += 1) {
    out.write(paint(gradientAt(i / (mark.length - 1)), bold(mark[i]!)));
    if (animate && mark[i] !== ' ') await sleep(38);
  }
  write();

  const tagline = 'device pairing  ·  vendor-neutral AFK control plane';
  write(' '.repeat(Math.max(2, Math.floor((width - tagline.length) / 2))) + dim(tagline));
  write();
}

// ------------------------------------------------------------------- steps

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface StepHandle {
  /** Change the label while the step is still running. */
  update(label: string): void;
}

/**
 * Run `task` behind a spinner, then settle the line into ✓ or ✗.
 * The task's result is returned; a thrown error is re-thrown after the ✗.
 */
export async function step<T>(
  label: string,
  task: (handle: StepHandle) => Promise<T>,
  detail?: (result: T) => string,
): Promise<T> {
  let current = label;
  let frame = 0;
  let timer: NodeJS.Timeout | undefined;

  const render = () => {
    const spinner = paint(palette.orange, FRAMES[frame % FRAMES.length]!);
    out.write(`\r${ESC}2K  ${spinner}  ${current}`);
    frame += 1;
  };

  if (rich) {
    render();
    timer = setInterval(render, 80);
  } else {
    write(`  …  ${label}`);
  }

  const handle: StepHandle = {
    update(next) {
      current = next;
      if (!rich) write(`  …  ${next}`);
    },
  };

  try {
    const result = await task(handle);
    if (timer) clearInterval(timer);
    const suffix = detail ? `  ${dim(detail(result))}` : '';
    const line = `  ${paint(palette.green, '✓')}  ${label}${suffix}`;
    if (rich) out.write(`\r${ESC}2K${line}\n`);
    else write(line);
    return result;
  } catch (error) {
    if (timer) clearInterval(timer);
    const line = `  ${paint(palette.red, '✗')}  ${label}`;
    if (rich) out.write(`\r${ESC}2K${line}\n`);
    else write(line);
    throw error;
  }
}

// -------------------------------------------------------------------- card

/** A rounded card. Lines may contain colour; width is measured without it. */
export function card(title: string, lines: string[], accent: RGB = palette.orange): void {
  const inner = Math.max(visibleWidth(title) + 4, ...lines.map(visibleWidth)) + 4;
  const edge = (text: string) => paint(accent, text);
  const heading = ` ${bold(title)} `;

  write(`  ${edge('╭─')}${heading}${edge('─'.repeat(Math.max(0, inner - visibleWidth(heading) - 1)) + '╮')}`);
  write(`  ${edge('│')}${' '.repeat(inner)}${edge('│')}`);
  for (const line of lines) {
    const gap = inner - 2 - visibleWidth(line);
    write(`  ${edge('│')}  ${line}${' '.repeat(Math.max(0, gap))}${edge('│')}`);
  }
  write(`  ${edge('│')}${' '.repeat(inner)}${edge('│')}`);
  write(`  ${edge('╰')}${edge('─'.repeat(inner))}${edge('╯')}`);
}

/** The pairing code, large and spaced, split into its two halves. */
export function bigCode(code: string): string {
  const clean = code.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  const half = Math.ceil(clean.length / 2);
  const spaced = (part: string) =>
    [...part].map((char, i) => paint(gradientAt(i / Math.max(1, part.length - 1)), bold(char))).join(' ');
  return `${spaced(clean.slice(0, half))}  ${paint(palette.slate, '—')}  ${spaced(clean.slice(half))}`;
}

/**
 * The fingerprint as a numbered grid. Numbering matters: the check is done by
 * comparing against the browser, and "word 7 differs" is much easier to spot
 * than a mismatch buried in a sentence.
 */
export function fingerprintGrid(words: string[], perRow = 5): string[] {
  const width = Math.max(...words.map((word) => word.length));
  const rows: string[] = [];
  for (let start = 0; start < words.length; start += perRow) {
    rows.push(
      words
        .slice(start, start + perRow)
        .map((word, i) => `${dim(String(start + i + 1).padStart(2, '0'))} ${paint(palette.cream, word.padEnd(width))}`)
        .join('  '),
    );
  }
  return rows;
}

// ------------------------------------------------------------ live status

export interface LiveLine {
  set(text: string): void;
  done(finalText?: string): void;
}

/** One line that rewrites itself in place, with a spinner in front. */
export function liveLine(initial: string): LiveLine {
  let text = initial;
  let frame = 0;
  let lastPlain = '';

  const render = () => {
    const spinner = paint(palette.violet, FRAMES[frame % FRAMES.length]!);
    out.write(`\r${ESC}2K  ${spinner}  ${text}`);
    frame += 1;
  };

  let timer: NodeJS.Timeout | undefined;
  if (rich) {
    render();
    timer = setInterval(render, 80);
  } else {
    write(`  …  ${initial}`);
    lastPlain = initial;
  }

  return {
    set(next) {
      text = next;
      // In plain mode only print when the meaning changes, not every tick of
      // the countdown, or a log fills with near-identical lines.
      if (!rich) {
        const meaning = next.replace(/\d+:\d{2}/g, '');
        if (meaning !== lastPlain.replace(/\d+:\d{2}/g, '')) {
          write(`  …  ${next}`);
          lastPlain = next;
        }
      }
    },
    done(finalText) {
      if (timer) clearInterval(timer);
      if (rich) out.write(`\r${ESC}2K${finalText ? `${finalText}\n` : ''}`);
      else if (finalText) write(finalText);
    },
  };
}

export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
