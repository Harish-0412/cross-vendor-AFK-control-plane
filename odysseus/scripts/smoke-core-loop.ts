/**
 * End-to-end smoke test for the Odysseus core loop.
 *
 * Proves, without a browser: pair -> gateway connects -> web client subscribes
 * -> session starts on the real gateway -> agent events stream back to a
 * browser-style WS client.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import WebSocket from 'ws';

import { createGateway } from '../gateway/core/src/gateway';
import { DeviceIdentityManager } from '../gateway/identity/src/device-identity';
import { PairingManager } from '../gateway/pairing/src/pairing-manager';

const CP = 'http://localhost:4000';
const CP_WS = 'ws://localhost:4000/ws/tunnel';

const results: Array<{ step: string; ok: boolean; detail: string }> = [];
function check(step: string, ok: boolean, detail = ''): void {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ` — ${detail}` : ''}`);
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function main(): Promise<void> {
  // 1 ---------------------------------------------------------------- auth
  const email = `smoke_${Date.now()}@odysseus.test`;
  const regRes = await fetch(`${CP}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'SmokeTest123!', name: 'Smoke' }),
  });
  const reg = await json(regRes);
  const token = (reg['accessToken'] ??
    (reg['tokens'] as Record<string, unknown>)?.['accessToken']) as string;
  check('register user', !!token, token ? 'got access token' : JSON.stringify(reg).slice(0, 200));
  if (!token) process.exit(1);
  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  // 2 ------------------------------------------------------------- pairing
  // Each smoke run gets a throwaway identity: the on-disk default identity is
  // claimed by whichever user paired it first, so reusing it across runs would
  // fail ownership checks on the second run.
  const identityManager = new DeviceIdentityManager({
    storage: { storageDir: join(tmpdir(), `odysseus-smoke-${Date.now()}`) },
  });
  await identityManager.initialize();
  const identity = identityManager.getIdentity();

  const pairingManager = new PairingManager(identityManager);
  await pairingManager.startPairing();
  const pairSession = pairingManager.getCurrentSession();
  if (!pairSession) throw new Error('no pairing session');

  await fetch(`${CP}/api/v1/internal/pairing/initiate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: pairSession.code,
      deviceId: pairSession.deviceId,
      gatewayId: pairSession.gatewayId,
      fingerprintHex: pairSession.fingerprintHex,
      fingerprintWords: pairSession.fingerprintWords,
      // Registered so the tunnel handshake can verify this gateway signs
      // with the key the pairing recorded.
      publicKeyJwk: identity.publicKeyJwk,
      publicKeyPem: identity.publicKeyPem,
    }),
  });

  const pairRes = await fetch(`${CP}/api/v1/devices/pair`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ code: pairSession.code }),
  });
  const paired = await json(pairRes);
  check('POST /devices/pair', pairRes.ok, `status ${pairRes.status}`);

  const confirmRes = await fetch(`${CP}/api/v1/devices/confirm`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      code: pairSession.code,
      deviceId: pairSession.deviceId,
      pairingId: paired['pairingId'] ?? paired['id'],
      confirmed: true,
      friendlyName: 'Smoke Workstation',
    }),
  });
  check('POST /devices/confirm', confirmRes.ok, `status ${confirmRes.status}`);
  await pairingManager.shutdown();

  // 3 ------------------------------------------------- browser-style client
  const clientWs = new WebSocket('ws://localhost:4000/ws/client');
  const clientEvents: Array<Record<string, unknown>> = [];
  await new Promise<void>((resolve, reject) => {
    clientWs.on('open', () => {
      clientWs.send(JSON.stringify({ type: 'auth', token }));
    });
    clientWs.on('message', (buf: Buffer) => {
      const message = JSON.parse(buf.toString('utf8')) as { type?: string };
      if (message.type === 'connected') resolve();
    });
    clientWs.on('error', reject);
    setTimeout(() => reject(new Error('client ws timeout')), 8000);
  });
  clientWs.on('message', (buf: Buffer) => {
    try {
      clientEvents.push(JSON.parse(buf.toString('utf8')) as Record<string, unknown>);
    } catch {
      /* ignore */
    }
  });
  clientWs.send(JSON.stringify({ action: 'subscribe_device', deviceId: identity.deviceId }));
  check('web client WS connected + subscribed', clientWs.readyState === WebSocket.OPEN);

  // 4 ------------------------------------------------------------- gateway
  const gateway = createGateway({
    deviceId: identity.deviceId,
    gatewayId: identity.gatewayId,
    projectRoots: [process.cwd()],
    controlPlane: { url: CP_WS, autoConnect: true },
  });

  await gateway.connectToControlPlane({
    webSocketImpl: WebSocket as never,
    authProvider: {
      getPublicKeyJwk: () => identity.publicKeyJwk,
      getCertificateThumbprint: () => null,
      sign: (d: string) => identityManager.sign(d),
      verifySignature: (d: string, s: string) => identityManager.verifySignature(d, s),
    },
  });

  await new Promise((r) => setTimeout(r, 2500));
  check(
    'gateway tunnel connected',
    gateway.isTunnelConnected(),
    `state=${gateway.getTunnelStats().state}`,
  );

  const devRes = await fetch(`${CP}/api/v1/devices`, { headers: authHeaders });
  const devPayload = await devRes.json();
  const devList = (
    Array.isArray(devPayload) ? devPayload : (devPayload as Record<string, unknown>)['devices']
  ) as Array<Record<string, unknown>> | undefined;
  const thisDevice = devList?.find((d) => d['id'] === identity.deviceId);
  check(
    'device visible + online in API',
    !!thisDevice && thisDevice['online'] === true,
    thisDevice ? `online=${String(thisDevice['online'])}` : 'device missing',
  );

  // 5 -------------------------------------------------------- session start
  const sessRes = await fetch(`${CP}/api/v1/sessions`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      deviceId: identity.deviceId,
      agentId: 'mock',
      projectRoot: process.cwd(),
      prompt: 'smoke test: say hello',
    }),
  });
  const sess = await json(sessRes);
  const sessionId = sess['id'] as string;
  check('POST /sessions accepted', sessRes.status === 201, `state=${String(sess['state'])}`);
  check(
    'session reached running (real ack, not false-green)',
    sess['state'] === 'running',
    `state=${String(sess['state'])} error=${String(sess['error'] ?? '')}`,
  );

  // 6 ---------------------------------------------------- events round trip
  await new Promise((r) => setTimeout(r, 4000));

  const evRes = await fetch(`${CP}/api/v1/sessions/${sessionId}/events`, { headers: authHeaders });
  const evBody = await evRes.json();
  const stored = (
    Array.isArray(evBody) ? evBody : ((evBody as Record<string, unknown>)['events'] ?? [])
  ) as Array<Record<string, unknown>>;
  check('gateway events persisted in control plane', stored.length > 0, `${stored.length} events`);
  if (stored.length > 0) {
    const types = [...new Set(stored.map((e) => String(e['eventType'] ?? '')))];
    console.log(`      event types: ${types.join(', ')}`);
  }

  const pushed = clientEvents.filter((m) => String(m['type'] ?? '').includes('event'));
  check('events pushed to browser WS client', pushed.length > 0, `${pushed.length} pushed`);

  // 7 ------------------------------------------------------ steering prompt
  const promptRes = await fetch(`${CP}/api/v1/sessions/${sessionId}/prompt`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ message: 'steer: now do something else' }),
  });
  check(
    'steering prompt delivered to gateway',
    promptRes.ok || promptRes.status === 202,
    `status ${promptRes.status}`,
  );

  // ------------------------------------------------------------------ done
  clientWs.close();
  await gateway.shutdown(true);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('SMOKE TEST CRASHED:', err);
  process.exit(1);
});
