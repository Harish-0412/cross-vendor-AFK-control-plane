// A stand-in for the Freebuff terminal UI, faithful where the adapter depends
// on it: it refuses to run without a TTY, draws a prompt, takes a bracketed
// paste followed by Enter, animates while it works, edits files in --cwd and
// prints an answer, then waits for the next prompt until Ctrl+C.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write('freebuff needs a terminal\n');
  process.exit(1);
}
const cwdIndex = process.argv.indexOf('--cwd');
const cwd = cwdIndex > 0 ? process.argv[cwdIndex + 1] : process.cwd();
const out = (text) => process.stdout.write(text);

out('\x1b[2J\x1b[H\x1b[1mFreebuff\x1b[0m (fake)\r\n');
if (process.env.FAKE_LOGIN === '1') out('Run freebuff login to sign in with your browser\r\n');
out('> ');

process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
let buffer = '';
let pasting = false;
process.stdin.on('data', (chunk) => {
  if (chunk.includes('\x03')) process.exit(0);
  let rest = chunk;
  while (rest.length) {
    if (rest.startsWith('\x1b[200~')) {
      pasting = true;
      rest = rest.slice(6);
      continue;
    }
    if (rest.startsWith('\x1b[201~')) {
      pasting = false;
      rest = rest.slice(6);
      continue;
    }
    const ch = rest[0];
    rest = rest.slice(1);
    if (ch === '\r' && !pasting) {
      void handle(buffer);
      buffer = '';
      continue;
    }
    buffer += ch;
  }
});

async function handle(prompt) {
  out(`\r\n${prompt.split('\n').join('\r\n')}\r\n`);
  const frames = ['|', '/', '-', '+'];
  for (let i = 0; i < 8; i += 1) {
    out(`\r\x1b[2KWorking ${frames[i % 4]}`);
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  out('\r\x1b[2K');
  if (prompt.includes('WRITE')) writeFileSync(join(cwd, 'answer.txt'), 'hello\n');
  const lines = prompt.split('\n').length;
  out(`Done. I read ${lines} line(s) of instructions and wrote answer.txt.\r\n> `);
}
