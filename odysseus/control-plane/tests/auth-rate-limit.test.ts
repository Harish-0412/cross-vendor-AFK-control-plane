import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ControlPlane } from '../src/control-plane';

/**
 * §4.4 of the pre-deployment audit: /api/v1/auth/login and /register had no
 * rate limiting whatsoever — unlimited password-guessing against a known
 * email, and unlimited account-creation spam.
 */
describe('Auth rate limiting', () => {
  let cp: ControlPlane;
  let baseUrl: string;

  beforeEach(async () => {
    cp = new ControlPlane({ port: 0 });
    const { url } = await cp.start();
    baseUrl = url;
  });

  afterEach(async () => {
    await cp.stop();
  });

  it('locks out login after repeated failed attempts against the same email', async () => {
    await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ratelimit@test.dev', password: 'CorrectPassword123!' }),
    });

    let lastStatus = 0;
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'ratelimit@test.dev', password: 'WrongPassword' }),
      });
      lastStatus = res.status;
    }

    // Default limit is 5 attempts per window; the 6th must be rejected
    // before it even checks the password.
    expect(lastStatus).toBe(429);
  });

  it('does not rate-limit a successful login after prior failures within the limit', async () => {
    await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ratelimit2@test.dev', password: 'CorrectPassword123!' }),
    });

    // Two failed attempts, well under the limit.
    for (let i = 0; i < 2; i++) {
      await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'ratelimit2@test.dev', password: 'WrongPassword' }),
      });
    }

    const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ratelimit2@test.dev', password: 'CorrectPassword123!' }),
    });

    expect(res.status).toBe(200);
  });

  it('does not lock out a different email from the same client after one email is limited', async () => {
    for (let i = 0; i < 6; i++) {
      await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'victim-a@test.dev', password: 'wrong' }),
      });
    }

    const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'victim-b@test.dev', password: 'wrong' }),
    });

    // Wrong credentials, but not rate-limited — a distinct account was not
    // punished for a different account's failed attempts from the same IP.
    expect(res.status).toBe(401);
  });

  it('rate-limits registration spam from the same client', async () => {
    let lastStatus = 0;
    for (let i = 0; i < 11; i++) {
      const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `spam${i}@test.dev`, password: 'Password123!' }),
      });
      lastStatus = res.status;
    }

    // Default limit is 10 registrations per window; the 11th must be rejected.
    expect(lastStatus).toBe(429);
  });
});
