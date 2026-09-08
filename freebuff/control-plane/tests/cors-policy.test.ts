import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ControlPlane } from '../src/control-plane';

/**
 * Regression coverage for the CORS misconfiguration found during the
 * pre-deployment audit: `setCORS` used to reflect `req.headers.origin`
 * verbatim and unconditionally set `Access-Control-Allow-Credentials: true`.
 * That combination lets any website read authenticated API responses via a
 * plain credentialed fetch() — no XSS required — which defeats the
 * httpOnly-refresh-cookie design entirely.
 */
describe('CORS policy', () => {
  let cp: ControlPlane;
  let baseUrl: string;

  describe('with an explicit origin allowlist', () => {
    beforeEach(async () => {
      cp = new ControlPlane({ port: 0, corsOrigins: ['https://app.example.com'] });
      const { url } = await cp.start();
      baseUrl = url;
    });

    afterEach(async () => {
      await cp.stop();
    });

    it('reflects and enables credentials only for an allowlisted origin', async () => {
      const res = await fetch(`${baseUrl}/api/v1/health`, {
        headers: { Origin: 'https://app.example.com' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
      expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    });

    it('emits no CORS headers at all for an arbitrary, non-allowlisted origin', async () => {
      // This is the actual exploit shape: a malicious page fetching the API
      // directly. Without an Allow-Origin header naming the attacker's
      // origin, the browser refuses to let that page read the response.
      const res = await fetch(`${baseUrl}/api/v1/health`, {
        headers: { Origin: 'https://evil.attacker.example' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    });

    it('emits no CORS headers when no Origin header is present at all', async () => {
      const res = await fetch(`${baseUrl}/api/v1/health`);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  describe('with wildcard (dev-mode) origins', () => {
    beforeEach(async () => {
      cp = new ControlPlane({ port: 0, corsOrigins: ['*'] });
      const { url } = await cp.start();
      baseUrl = url;
    });

    afterEach(async () => {
      await cp.stop();
    });

    it('allows any origin but never enables credentials alongside a wildcard', async () => {
      const res = await fetch(`${baseUrl}/api/v1/health`, {
        headers: { Origin: 'https://anything.example' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      // A wildcard origin combined with credentials is unsafe regardless of
      // per-browser enforcement — this must never be set together.
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    });
  });
});

/**
 * §4.5 of the pre-deployment audit: the refresh-token cookie never carried
 * `Secure` at all, so it could be transmitted in the clear over a
 * misconfigured or non-TLS connection.
 */
describe('Refresh cookie Secure attribute', () => {
  let cp: ControlPlane;
  let baseUrl: string;

  afterEach(async () => {
    await cp.stop();
  });

  it('sets Secure when secureCookies is enabled', async () => {
    cp = new ControlPlane({ port: 0, secureCookies: true });
    const { url } = await cp.start();
    baseUrl = url;

    const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Type': 'web' },
      body: JSON.stringify({ email: 'secure-cookie@test.dev', password: 'Password123!' }),
    });

    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('HttpOnly');
  });

  it('omits Secure when secureCookies is disabled (local dev default)', async () => {
    cp = new ControlPlane({ port: 0, secureCookies: false });
    const { url } = await cp.start();
    baseUrl = url;

    const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Type': 'web' },
      body: JSON.stringify({ email: 'insecure-cookie@test.dev', password: 'Password123!' }),
    });

    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).not.toContain('Secure');
  });
});
