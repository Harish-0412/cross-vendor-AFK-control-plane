/**
 * `pnpm pair` — pair this workstation with a Control Plane.
 *
 * Registers a short-lived code together with this device's public key, then
 * waits while the user enters the code in the web app, compares the
 * fingerprint words, and approves. The public key is what the tunnel handshake
 * later verifies signatures against, so it is sent here, at pairing time.
 *
 * Which Control Plane:
 *
 *   pnpm pair                        the hosted Control Plane (the product)
 *   pnpm pair --local                a development server on localhost:4000
 *   CONTROL_PLANE_URL=… pnpm pair    anything else
 *
 * This used to default to localhost. A fresh terminal without the variable set
 * therefore registered the device with the local development server, and the
 * hosted website showed no devices. On success the Control Plane is written to
 * ~/.odysseus/pairing.json, and `pnpm gateway` connects there by default — so a
 * device and its gateway can no longer end up on different servers.
 */
import { execFile } from 'node:child_process';
import { hostname, platform as osPlatform } from 'node:os';
import { promisify } from 'node:util';

import {
  HOSTED_CONTROL_PLANE_URL,
  HOSTED_WEB_URL,
  isLocalControlPlane,
  tunnelUrlFor,
  writePairingRecord,
} from '../gateway/core/src/runtime/paired-control-plane';
import { DeviceIdentityManager } from '../gateway/identity/src/device-identity';
import { PairingManager } from '../gateway/pairing/src/pairing-manager';

import {
  bigCode,
  bold,
  card,
  dim,
  fingerprintGrid,
  formatRemaining,
  hideCursor,
  intro,
  link,
  liveLine,
  paint,
  palette,
  showCursor,
  step,
  write,
} from './pair-ui';

const WANTS_LOCAL = process.argv.includes('--local');
const CONTROL_PLANE_URL = (
  process.env['CONTROL_PLANE_URL']?.trim() ||
  (WANTS_LOCAL ? 'http://localhost:4000' : HOSTED_CONTROL_PLANE_URL)
).replace(/\/+$/, '');
const rawWebUrl = process.env['ODYSSEUS_WEB_URL']?.trim();
const IS_LOCAL = isLocalControlPlane(CONTROL_PLANE_URL);

const WEB_URL = (rawWebUrl || (IS_LOCAL ? 'http://localhost:3000' : HOSTED_WEB_URL)).replace(
  /\/+$/,
  '',
);
const POLL_INTERVAL_MS = 2000;
/** How long to keep retrying while a sleeping host starts up. */
const WAKE_BUDGET_MS = 100_000;
const execFileAsync = promisify(execFile);

class PairingError extends Error {}

/**
 * Register the pairing code, retrying through a cold start.
 *
 * Free hosting sleeps when idle and takes about a minute to wake; the first
 * request can fail or time out while it does. A 4xx is a real answer and is
 * not retried — only connection failures and 502/503/504 are.
 */
async function registerPairing(
  body: Record<string, unknown>,
  onWaking: () => void,
): Promise<string> {
  const deadline = Date.now() + WAKE_BUDGET_MS;
  let lastProblem = '';

  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      const res = await fetch(`${CONTROL_PLANE_URL}/api/v1/internal/pairing/initiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (res.ok) {
        const json = (await res.json()) as { pairingId: string };
        return json.pairingId;
      }

      if (![502, 503, 504].includes(res.status)) {
        const detail = (await res.json().catch(() => ({}))) as { error?: string };
        throw new PairingError(detail.error ?? `The Control Plane answered HTTP ${res.status}`);
      }
      lastProblem = `HTTP ${res.status}`;
    } catch (error) {
      if (error instanceof PairingError) throw error;
      lastProblem = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }

    onWaking();
    await new Promise((resolve) => setTimeout(resolve, 4_000));
  }

  throw new PairingError(`Could not reach ${CONTROL_PLANE_URL} (${lastProblem})`);
}

async function suggestedProjectRoot(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      windowsHide: true,
      timeout: 3_000,
    });
    if (stdout.trim()) return stdout.trim();
  } catch {
    // Pairing also works outside a Git checkout; the current directory is the
    // most useful safe suggestion in that case.
  }
  return process.cwd();
}

/**
 * The next command to run. With a pairing record written, the gateway finds
 * its Control Plane on its own; the environment variable is only shown when
 * the record could not be saved — it was the step people missed.
 */
function nextStepCommand(projectRoot: string, recorded: boolean): string[] {
  const gatewayCommand = process.env['ODYSSEUS_CLI_COMMAND']
    ? `${process.env['ODYSSEUS_CLI_COMMAND']} gateway`
    : 'pnpm gateway';
  const run = paint(palette.amber, `${gatewayCommand} --project-root "${projectRoot}"`);
  if (recorded) return [run];
  const tunnelUrl = tunnelUrlFor(CONTROL_PLANE_URL);
  return [
    paint(
      palette.amber,
      process.platform === 'win32'
        ? `$env:ODYSSEUS_CONTROL_PLANE_URL = "${tunnelUrl}"`
        : `export ODYSSEUS_CONTROL_PLANE_URL=${tunnelUrl}`,
    ),
    run,
  ];
}

async function main(): Promise<void> {
  hideCursor();
  await intro();

  const identityManager = new DeviceIdentityManager();
  const identity = await step(
    'Device identity',
    async () => {
      await identityManager.initialize();
      return identityManager.getIdentity();
    },
    (id) => `${id.deviceId.slice(0, 14)}…  ·  ${id.algorithm}`,
  );

  const pairingManager = new PairingManager(identityManager, { printInstructions: false });
  const session = await step(
    'Pairing code',
    async () => {
      await pairingManager.startPairing();
      const current = pairingManager.getCurrentSession();
      if (!current) throw new PairingError('No pairing session was created');
      return current;
    },
    () => 'valid for 5 minutes',
  );

  const host = new URL(CONTROL_PLANE_URL).host;
  if (IS_LOCAL) {
    // Said before anything is registered, because this is the mistake that
    // leaves the hosted website with no devices on it.
    write(
      `  ${paint(palette.amber, '!')}  Pairing with a ${bold('local development')} Control Plane (${host}).`,
    );
    write(
      `     ${dim('This device will appear only on the website that server serves, not the hosted one.')}`,
    );
    write(`     ${dim('Run plain `pnpm pair` to pair with the hosted Control Plane instead.')}`);
    write();
  }
  await step(
    `Registering with ${host}`,
    (handle) =>
      registerPairing(
        {
          code: session.code,
          deviceId: session.deviceId,
          gatewayId: session.gatewayId,
          deviceName: hostname().slice(0, 120),
          platform:
            osPlatform() === 'win32'
              ? 'windows'
              : osPlatform() === 'darwin'
                ? 'darwin'
                : osPlatform() === 'linux'
                  ? 'linux'
                  : 'unknown',
          fingerprintHex: session.fingerprintHex,
          fingerprintWords: session.fingerprintWords,
          // Registered so the Control Plane can verify the tunnel signatures
          // this gateway produces. Without it, the device can never connect.
          publicKeyJwk: identity.publicKeyJwk,
          publicKeyPem: identity.publicKeyPem,
        },
        () =>
          handle.update(`Waking ${host} ${dim('— free hosting sleeps when idle, up to a minute')}`),
      ),
    () => 'public key registered',
  );

  const pairUrl = `${WEB_URL}/devices/pair?code=${encodeURIComponent(session.code)}`;

  write();
  card('PAIR THIS DEVICE', [
    bigCode(session.code),
    '',
    `${dim('fingerprint')}  ${paint(palette.cream, bold(session.fingerprintShort))}`,
    '',
    ...fingerprintGrid(session.fingerprintWords),
  ]);
  write();
  write(
    `  ${paint(palette.violet, '→')}  ${bold('Open')}  ${link(pairUrl, paint(palette.violet, pairUrl))}`,
  );
  write();
  write(`  ${dim('1')}  Sign in on your phone or browser`);
  write(`  ${dim('2')}  The link fills in the code ${dim('— or type it')}`);
  write(
    `  ${dim('3')}  ${bold('Check all 10 words match, in order')} ${dim('— this is the security check')}`,
  );
  write(`  ${dim('4')}  Approve`);
  write();

  const status = liveLine('Waiting for you to enter the code');
  const deadline = session.expiresAt.getTime();
  let tick: NodeJS.Timeout | undefined;
  let phase = 'Waiting for you to enter the code';

  const render = () =>
    status.set(`${phase}  ${dim('·')}  ${dim(`${formatRemaining(deadline - Date.now())} left`)}`);
  tick = setInterval(render, 1000);
  render();

  const finish = async (line: string, code: number) => {
    if (tick) clearInterval(tick);
    tick = undefined;
    status.done(line);
    await pairingManager.shutdown().catch(() => undefined);
    showCursor();
    process.exit(code);
  };

  process.on('SIGINT', () => {
    void finish(`  ${paint(palette.slate, '○')}  Pairing cancelled`, 130);
  });

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    let state: string;
    try {
      const res = await fetch(
        `${CONTROL_PLANE_URL}/api/v1/internal/pairing/status?code=${encodeURIComponent(session.code)}`,
      );
      if (!res.ok) continue;
      state = ((await res.json()) as { status: string }).status;
    } catch {
      // Briefly unreachable; the countdown keeps going and polling resumes.
      continue;
    }

    if (state === 'code_verified') {
      phase = `${paint(palette.amber, 'Code entered')} — compare the words, then approve`;
      render();
    } else if (state === 'confirmed') {
      if (tick) clearInterval(tick);
      tick = undefined;
      status.done(`  ${paint(palette.green, '✓')}  ${bold('Paired')}`);
      // Remember where this device is registered, so the gateway connects to
      // the same server without being told.
      let recorded = false;
      try {
        writePairingRecord({
          controlPlaneUrl: CONTROL_PLANE_URL,
          tunnelUrl: tunnelUrlFor(CONTROL_PLANE_URL),
          webUrl: WEB_URL,
          deviceId: identity.deviceId,
          pairedAt: new Date().toISOString(),
        });
        recorded = true;
      } catch {
        // Pairing itself succeeded. Without the record the gateway needs the
        // environment variable, which the card below then shows.
      }
      const projectRoot = await suggestedProjectRoot();
      write();
      card(
        'THIS MACHINE IS TRUSTED',
        [
          `${dim('device ')}  ${identity.deviceId}`,
          `${dim('gateway')}  ${identity.gatewayId}`,
          `${dim('server ')}  ${host}`,
          '',
          dim('Next — start the gateway so your phone can reach this machine:'),
          '',
          ...nextStepCommand(projectRoot, recorded),
        ],
        palette.green,
      );
      write();
      await pairingManager.shutdown().catch(() => undefined);
      showCursor();
      process.exit(0);
    } else if (state === 'rejected') {
      await finish(
        `  ${paint(palette.red, '✗')}  Rejected in the web app — the fingerprint did not match, or it was declined`,
        1,
      );
    } else if (state === 'expired') {
      await finish(
        `  ${paint(palette.red, '✗')}  The code expired before it was approved — run ${bold('pnpm pair')} again`,
        1,
      );
    }
  }

  await finish(
    `  ${paint(palette.red, '✗')}  Timed out after 5 minutes — run ${bold('pnpm pair')} again`,
    1,
  );
}

main().catch((error: unknown) => {
  showCursor();
  write();
  if (error instanceof PairingError) {
    write(`  ${paint(palette.red, '✗')}  ${error.message}`);
    if (/reach/i.test(error.message)) {
      write(dim(`     Is the Control Plane running? CONTROL_PLANE_URL is ${CONTROL_PLANE_URL}`));
    }
  } else {
    console.error(error);
  }
  write();
  process.exit(1);
});
