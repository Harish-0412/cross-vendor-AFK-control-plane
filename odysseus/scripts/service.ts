/**
 * `odysseus service` — run the gateway in the background, started when you
 * sign in, so agent sessions carry on after a restart.
 *
 *   odysseus service install [--dry-run] [-- <gateway options>]
 *   odysseus service uninstall
 *   odysseus service status
 *   odysseus service run [-- <gateway options>]    (what the service starts)
 *
 * What gets written, and why, is decided in gateway/core/src/runtime/service.ts.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GatewaySupervisor,
  servicePlan,
  type ServicePlan,
} from '../gateway/core/src/runtime/service';

const home = homedir();
const serviceDir = join(home, '.odysseus', 'service');
const logDir = join(home, '.odysseus', 'logs');
const pidFile = join(serviceDir, 'supervisor.pid');
const gatewayLog = join(logDir, 'gateway.log');
const MAX_LOG_BYTES = 10 * 1024 * 1024;
/** bin/odysseus.mjs, from both scripts/ (source) and dist-package/ (installed). */
const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'odysseus.mjs');

const argv = process.argv.slice(2);
const separator = argv.indexOf('--');
const gatewayArgs = separator >= 0 ? argv.slice(separator + 1) : [];
const own = separator >= 0 ? argv.slice(0, separator) : argv;
const action = own[0];
const dryRun = own.includes('--dry-run');

const usage = `Usage:
  odysseus service install [--dry-run] [-- <gateway options>]
  odysseus service uninstall
  odysseus service status
  odysseus service run [-- <gateway options>]

install     Start the gateway whenever you sign in, and now
uninstall   Stop it and remove the startup entry
status      Show whether it is installed and running
run         Run the gateway under the restart supervisor (what the service starts)`;

function plan(): ServicePlan {
  const platform = process.platform;
  if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') {
    console.error(`Background service is not supported on ${platform}.`);
    process.exit(69);
  }
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value && /^(ODYSSEUS_|CONTROL_PLANE_URL$)/.test(name)) env[name] = value;
  }
  return servicePlan({
    platform,
    home,
    node: process.execPath,
    cli,
    gatewayArgs,
    ...(process.env['PATH'] ? { path: process.env['PATH'] } : {}),
    env,
    ...(platform === 'win32'
      ? { windowsUser: `${process.env['USERDOMAIN'] ?? '.'}\\${process.env['USERNAME'] ?? ''}` }
      : {}),
    ...(typeof process.getuid === 'function' ? { uid: process.getuid() } : {}),
  });
}

function exec(command: string[], tolerate = false): boolean {
  const result = spawnSync(command[0]!, command.slice(1), { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0 && !tolerate) {
    console.error(`\`${command.join(' ')}\` failed (${result.status ?? result.error?.message}).`);
    return false;
  }
  return true;
}

function install(): void {
  if (!existsSync(cli)) {
    console.error(`Cannot find the odysseus CLI at ${cli}. Install the gateway package first.`);
    process.exit(78);
  }
  const steps = plan();
  if (dryRun) {
    for (const file of steps.files) console.log(`--- would write ${file.path}\n${file.content}`);
    for (const command of steps.install) console.log(`--- would run: ${command.join(' ')}`);
    return;
  }
  for (const file of steps.files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(
      file.path,
      file.encoding === 'utf16le'
        ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(file.content, 'utf16le')])
        : file.content,
    );
  }
  mkdirSync(logDir, { recursive: true });
  for (const command of steps.install) {
    // Unloading a service that is not loaded yet is expected to fail.
    if (!exec(command, command.includes('bootout'))) process.exit(1);
  }
  console.log('Installed. The Odysseus gateway now starts when you sign in, and is starting now.');
  for (const note of steps.notes) console.log(note);
  console.log(`Its log: ${gatewayLog}`);
}

function uninstall(): void {
  const steps = plan();
  stopSupervisor();
  for (const command of steps.uninstall) exec(command, true);
  for (const file of steps.remove) rmSync(file, { force: true });
  console.log('Removed. The gateway no longer starts when you sign in.');
}

function status(): void {
  const pid = readPid();
  console.log(
    pid && isRunning(pid) ? `Supervisor running (pid ${pid}).` : 'Supervisor not running.',
  );
  for (const command of plan().status) exec(command, true);
  console.log(`Log: ${gatewayLog}`);
}

function readPid(): number | null {
  try {
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopSupervisor(): void {
  const pid = readPid();
  if (pid && isRunning(pid)) {
    process.kill(pid, 'SIGTERM');
    console.log(`Stopped the running gateway (supervisor pid ${pid}).`);
  }
  rmSync(pidFile, { force: true });
}

/** Keep the log from growing without bound: one previous file is kept. */
function openLog(): number {
  mkdirSync(logDir, { recursive: true });
  try {
    if (statSync(gatewayLog).size > MAX_LOG_BYTES) renameSync(gatewayLog, `${gatewayLog}.1`);
  } catch {
    // No log yet.
  }
  return openSync(gatewayLog, 'a');
}

async function run(): Promise<void> {
  mkdirSync(serviceDir, { recursive: true });
  writeFileSync(pidFile, String(process.pid));
  const log = (message: string) => {
    const line = `${new Date().toISOString()} [supervisor] ${message}\n`;
    try {
      writeFileSync(gatewayLog, line, { flag: 'a' });
    } catch {
      process.stderr.write(line);
    }
  };
  const supervisor = new GatewaySupervisor({
    start: () => {
      const output = openLog();
      const child = spawn(process.execPath, [cli, 'gateway', ...gatewayArgs], {
        stdio: ['ignore', output, output],
        windowsHide: true,
        env: process.env,
      });
      log(`Started the gateway (pid ${child.pid ?? '?'}).`);
      return {
        exited: new Promise((resolve) => {
          child.once('exit', (code) => resolve(code));
          child.once('error', (error) => {
            log(`Could not start the gateway: ${error.message}`);
            resolve(75);
          });
        }),
        stop: (signal) => child.kill(signal),
      };
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log,
  });
  // Stopping the service stops the gateway gracefully, and it stays stopped.
  process.once('SIGTERM', () => supervisor.stop('SIGTERM'));
  process.once('SIGINT', () => supervisor.stop('SIGINT'));
  const code = await supervisor.run();
  rmSync(pidFile, { force: true });
  process.exit(code);
}

switch (action) {
  case 'install':
    install();
    break;
  case 'uninstall':
    uninstall();
    break;
  case 'status':
    status();
    break;
  case 'run':
    await run();
    break;
  default:
    console.log(usage);
    process.exit(action === undefined || action === 'help' || action === '--help' ? 0 : 64);
}
