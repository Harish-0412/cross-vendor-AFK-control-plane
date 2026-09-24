import { describe, expect, test } from 'vitest';

import { tunnelUrlFor, isLocalControlPlane } from '../src/runtime/paired-control-plane';
import { pairingCheck } from '../src/runtime/preflight';

const record = (url: string) => ({
  controlPlaneUrl: url,
  tunnelUrl: tunnelUrlFor(url),
  pairedAt: '2026-09-24T00:00:00.000Z',
});

describe('pairing preflight', () => {
  test('warns, naming both servers, when connecting somewhere other than where it paired', async () => {
    const result = await pairingCheck(
      'ws://localhost:4000/ws/tunnel',
      record('https://odysseus-control-plane.onrender.com'),
    ).run();

    expect(result.status).toBe('warn');
    expect(result.message).toContain('odysseus-control-plane.onrender.com');
    expect(result.message).toContain('localhost:4000');
    expect(result.remedy).toContain('ODYSSEUS_CONTROL_PLANE_URL');
  });

  test('passes when the gateway connects to its paired server', async () => {
    const result = await pairingCheck(
      'wss://odysseus-control-plane.onrender.com/ws/tunnel',
      record('https://odysseus-control-plane.onrender.com'),
    ).run();
    expect(result.status).toBe('pass');
  });

  test('warns with the fix when there is no pairing record at all', async () => {
    const result = await pairingCheck('wss://odysseus-control-plane.onrender.com/ws/tunnel', null).run();
    expect(result.status).toBe('warn');
    expect(result.remedy).toContain('pnpm pair');
  });

  test('has nothing to check for a local-only gateway', async () => {
    expect((await pairingCheck(undefined, null).run()).status).toBe('pass');
  });
});

describe('pairing URL helpers', () => {
  test('derive the tunnel URL from the HTTPS URL', () => {
    expect(tunnelUrlFor('https://cp.example.com/')).toBe('wss://cp.example.com/ws/tunnel');
    expect(tunnelUrlFor('http://localhost:4000')).toBe('ws://localhost:4000/ws/tunnel');
  });

  test('recognise a local development server', () => {
    expect(isLocalControlPlane('http://localhost:4000')).toBe(true);
    expect(isLocalControlPlane('http://127.0.0.1:4000')).toBe(true);
    expect(isLocalControlPlane('https://odysseus-control-plane.onrender.com')).toBe(false);
    // A host that merely contains "localhost" is not local.
    expect(isLocalControlPlane('https://localhost.example.com')).toBe(false);
  });
});
