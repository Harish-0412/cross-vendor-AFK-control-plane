/**
 * `pnpm verify:deploy` — is the deployed system the code in this repository,
 * and is it configured safely?
 *
 * Written after the hosted Control Plane ran three-day-old code while every
 * test passed locally: pushes to main were not deploying, and nothing said so.
 * A green test suite describes the repository; this describes what is
 * actually answering on the internet.
 *
 *   pnpm verify:deploy
 *   pnpm verify:deploy --control-plane https://cp.example.com --web https://app.example.com
 *
 * It needs no account and changes nothing: every check is an unauthenticated
 * request whose correct answer is a refusal. A route that exists refuses with
 * 401; a route that is missing — because the deploy is stale — answers 404,
 * and that difference is the freshness check.
 *
 * Exit code 0 when everything passes, 1 otherwise.
 */
import WebSocket from 'ws';

import {
  HOSTED_CONTROL_PLANE_URL,
  HOSTED_WEB_URL,
} from '../gateway/core/src/runtime/paired-control-plane';

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}

const argValue = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
};

const CONTROL_PLANE = (
  argValue('--control-plane') ??
  process.env['CONTROL_PLANE_URL'] ??
  HOSTED_CONTROL_PLANE_URL
).replace(/\/+$/, '');
const WEB = (argValue('--web') ?? process.env['ODYSSEUS_WEB_URL'] ?? HOSTED_WEB_URL).replace(
  /\/+$/,
  '',
);
const WS_BASE = CONTROL_PLANE.replace(/^http/, 'ws');
const HOSTILE_ORIGIN = 'https://attacker.example';

/**
 * Routes that must exist. Unauthenticated, each must refuse with 401. Kept to
 * the newest routes on purpose: they are the ones a stale deploy lacks.
 */
const REQUIRED_ROUTES = [
  '/api/v1/devices',
  '/api/v1/sessions',
  '/api/v1/approvals',
  '/api/v1/history',
  '/api/v1/usage/providers',
  '/api/v1/integrations/catalog',
];

const results: Result[] = [];
const record = (name: string, ok: boolean, detail: string) => results.push({ name, ok, detail });

async function request(url: string, init: RequestInit = {}, timeoutMs = 90_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const started = Date.now();
    const response = await fetch(url, { ...init, signal: controller.signal, redirect: 'manual' });
    const body = await response.text().catch(() => '');
    return { status: response.status, headers: response.headers, body, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function checkHealth(): Promise<boolean> {
  try {
    // Generous timeout: a sleeping free-tier instance takes about a minute.
    const res = await request(`${CONTROL_PLANE}/health`, {}, 120_000);
    const ok = res.status === 200 && /"status"\s*:\s*"ok"/.test(res.body);
    record(
      'Control Plane is up',
      ok,
      ok
        ? `200 in ${res.ms} ms${res.ms > 10_000 ? ' (it was asleep; that was a cold start)' : ''}`
        : `${res.status} ${res.body.slice(0, 120)}`,
    );
    return ok;
  } catch (error) {
    record('Control Plane is up', false, `unreachable: ${(error as Error).message}`);
    return false;
  }
}

async function checkRoutes(): Promise<void> {
  const missing: string[] = [];
  const unexpected: string[] = [];
  for (const route of REQUIRED_ROUTES) {
    const res = await request(`${CONTROL_PLANE}${route}`);
    if (res.status === 404 && res.body.includes('Endpoint not found')) missing.push(route);
    else if (res.status !== 401) unexpected.push(`${route} → ${res.status}`);
  }
  record(
    'Deployed code is current (every route present)',
    missing.length === 0,
    missing.length === 0
      ? `${REQUIRED_ROUTES.length} routes present`
      : `missing, so the deploy is older than main: ${missing.join(', ')}`,
  );
  record(
    'Protected routes refuse anonymous requests',
    unexpected.length === 0 && missing.length === 0,
    unexpected.length === 0 ? 'all answered 401' : unexpected.join('; '),
  );
}

async function checkWebProxy(): Promise<void> {
  try {
    const res = await request(`${WEB}/api/v1/history`);
    record(
      'Website reaches the Control Plane through its proxy',
      res.status === 401,
      res.status === 401
        ? 'proxied request refused with 401, as it should be'
        : `${res.status} — ${res.status === 404 ? 'route missing behind the proxy' : res.body.slice(0, 100)}`,
    );
  } catch (error) {
    record('Website reaches the Control Plane through its proxy', false, (error as Error).message);
  }
}

async function checkCors(): Promise<void> {
  const preflight = (origin: string) =>
    request(`${CONTROL_PLANE}/api/v1/devices`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
  const allowed = await preflight(WEB);
  const hostile = await preflight(HOSTILE_ORIGIN);
  const allowedOrigin = allowed.headers.get('access-control-allow-origin');
  const hostileOrigin = hostile.headers.get('access-control-allow-origin');
  record(
    'CORS admits the website',
    allowedOrigin === WEB,
    allowedOrigin === WEB ? `echoes ${WEB}` : `access-control-allow-origin: ${allowedOrigin ?? '(none)'}`,
  );
  record(
    'CORS refuses other sites',
    hostileOrigin !== HOSTILE_ORIGIN && hostileOrigin !== '*',
    hostileOrigin === HOSTILE_ORIGIN || hostileOrigin === '*'
      ? `a foreign origin was allowed (${hostileOrigin})`
      : 'foreign origin not echoed',
  );
}

/** Opens a socket and reports what happened within `waitMs`. */
function probeSocket(
  url: string,
  origin: string | undefined,
  onOpen?: (socket: WebSocket) => void,
  waitMs = 8_000,
): Promise<{ opened: boolean; rejectedStatus?: number; welcomed: boolean; closeCode?: number }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, origin ? { headers: { Origin: origin } } : {});
    const outcome: { opened: boolean; rejectedStatus?: number; welcomed: boolean; closeCode?: number } = {
      opened: false,
      welcomed: false,
    };
    const finish = () => {
      clearTimeout(timer);
      try {
        socket.terminate();
      } catch {
        /* already closed */
      }
      resolve(outcome);
    };
    const timer = setTimeout(finish, waitMs);
    socket.on('open', () => {
      outcome.opened = true;
      onOpen?.(socket);
    });
    socket.on('message', (data) => {
      try {
        if ((JSON.parse(data.toString()) as { type?: string }).type === 'connected') {
          outcome.welcomed = true;
        }
      } catch {
        /* not JSON */
      }
    });
    socket.on('unexpected-response', (_req, res) => {
      outcome.rejectedStatus = res.statusCode;
      finish();
    });
    socket.on('close', (code) => {
      outcome.closeCode = code;
      finish();
    });
    socket.on('error', () => undefined);
  });
}

async function checkSockets(): Promise<void> {
  // A browser from the real website, with a token that is not valid. The
  // server drops the connection within a second of refusing it; Render's edge
  // has been measured taking about twenty more to pass that on, so the wait is
  // long enough to see the close rather than time out before it.
  const started = Date.now();
  const badToken = await probeSocket(
    `${WS_BASE}/ws/client`,
    WEB,
    (socket) => socket.send(JSON.stringify({ type: 'auth', token: 'not-a-real-token' })),
    35_000,
  );
  const closedAfter = ((Date.now() - started) / 1000).toFixed(1);
  // Render's proxy has been seen to report the server's 4001 as 1006, so the
  // close code is not asserted. What is asserted: the socket was never
  // welcomed, and it was actually closed. A refused socket left open holds
  // server resources for as long as the client likes, and that is what
  // production did before refused sockets were torn down.
  record(
    'Live-updates socket refuses an invalid token',
    badToken.opened && !badToken.welcomed && badToken.closeCode !== undefined,
    !badToken.opened
      ? `could not open (${badToken.rejectedStatus ?? 'no response'})`
      : badToken.welcomed
        ? 'an invalid token was accepted'
        : badToken.closeCode === undefined
          ? 'refused, but left open for 35 s — rejected sockets are not being torn down'
          : `refused and closed after ${closedAfter} s (code ${badToken.closeCode})`,
  );

  // Browsers do not apply CORS to WebSockets, so the server must check Origin.
  const hostile = await probeSocket(`${WS_BASE}/ws/client`, HOSTILE_ORIGIN);
  record(
    'Live-updates socket refuses other sites',
    !hostile.opened,
    hostile.opened ? 'a foreign origin was allowed to open the socket' : `refused (${hostile.rejectedStatus ?? 'closed'})`,
  );

  const tunnel = await probeSocket(`${WS_BASE}/ws/tunnel`, undefined, undefined, 5_000);
  record(
    'Gateway tunnel accepts connections',
    tunnel.opened,
    tunnel.opened ? 'upgrade succeeded (authentication happens next)' : `refused (${tunnel.rejectedStatus ?? 'no response'})`,
  );
}

async function checkWebApp(): Promise<void> {
  const manifest = await request(`${WEB}/manifest.webmanifest`);
  record(
    'Website is installable (manifest served)',
    manifest.status === 200 && manifest.body.includes('"start_url"'),
    `${manifest.status}`,
  );
  const preview = await request(`${WEB}/dev-preview`);
  record(
    'Development preview is not reachable in production',
    preview.status !== 200,
    preview.status === 200 ? 'the sample-data preview is being served' : `${preview.status}`,
  );
}

async function main(): Promise<void> {
  process.stdout.write(`\nVerifying deployment\n  Control Plane  ${CONTROL_PLANE}\n  Website        ${WEB}\n\n`);

  if (await checkHealth()) {
    await checkRoutes();
    await checkCors();
    await checkSockets();
  }
  await checkWebProxy();
  await checkWebApp();

  const width = Math.max(...results.map((result) => result.name.length));
  for (const result of results) {
    process.stdout.write(
      `  ${result.ok ? '✓' : '✗'}  ${result.name.padEnd(width)}  ${result.detail}\n`,
    );
  }
  const failed = results.filter((result) => !result.ok);
  process.stdout.write(
    failed.length === 0
      ? `\n  All ${results.length} checks passed.\n\n`
      : `\n  ${failed.length} of ${results.length} checks failed.\n\n`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

void main();
