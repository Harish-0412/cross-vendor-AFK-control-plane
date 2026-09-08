import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { signJwt, verifyJwt } from '../src/auth/jwt';
import { hashPassword, verifyPassword } from '../src/auth/password';
import { ControlPlane } from '../src/control-plane';

describe('Auth Module', () => {
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

  describe('JWT and Password Utilities', () => {
    it('should hash and verify passwords securely', () => {
      const password = 'SuperSecretPassword123!';
      const hash = hashPassword(password);
      expect(hash).toContain(':');
      expect(verifyPassword(password, hash)).toBe(true);
      expect(verifyPassword('WrongPassword', hash)).toBe(false);
    });

    it('should sign and verify valid JWT tokens', () => {
      const secret = 'my-test-secret';
      const token = signJwt(
        { sub: 'usr_123', email: 'test@example.com', role: 'user' },
        secret,
        3600,
      );
      expect(token.split('.').length).toBe(3);

      const payload = verifyJwt(token, secret);
      expect(payload.sub).toBe('usr_123');
      expect(payload.email).toBe('test@example.com');
      expect(payload.role).toBe('user');
    });

    it('should reject expired JWT tokens', () => {
      const secret = 'my-test-secret';
      const token = signJwt({ sub: 'usr_123' }, secret, -10); // expired 10 seconds ago
      expect(() => verifyJwt(token, secret)).toThrow('Token has expired');
    });

    it('should reject tokens with tampered signatures', () => {
      const secret = 'my-test-secret';
      const token = signJwt({ sub: 'usr_123' }, secret, 3600);
      expect(() => verifyJwt(token, 'wrong-secret')).toThrow('Invalid token signature');
    });
  });

  describe('REST Auth Endpoints', () => {
    it('should register a new user and return access + refresh tokens', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'developer@freebuff.dev',
          password: 'Password123!',
          name: 'Lead Developer',
        }),
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as any;
      expect(data.accessToken).toBeDefined();
      expect(data.refreshToken).toBeDefined();
      expect(data.user.email).toBe('developer@freebuff.dev');
      expect(data.user.name).toBe('Lead Developer');
    });

    it('should not allow duplicate user registration', async () => {
      await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'duplicate@freebuff.dev',
          password: 'Password123!',
        }),
      });

      const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'duplicate@freebuff.dev',
          password: 'Password123!',
        }),
      });

      expect(res.status).toBe(409);
    });

    it('should log in with valid credentials and return token pair', async () => {
      await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'login@freebuff.dev',
          password: 'MyPassword!',
        }),
      });

      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'login@freebuff.dev',
          password: 'MyPassword!',
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.accessToken).toBeDefined();
      expect(data.refreshToken).toBeDefined();
      expect(data.user.email).toBe('login@freebuff.dev');
    });

    it('should reject login with wrong password', async () => {
      await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'wrongpass@freebuff.dev',
          password: 'CorrectPassword!',
        }),
      });

      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'wrongpass@freebuff.dev',
          password: 'IncorrectPassword',
        }),
      });

      expect(res.status).toBe(401);
    });

    it('should fetch user profile with Bearer token and include device counts', async () => {
      const regRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'me@freebuff.dev',
          password: 'Password123!',
          name: 'Me User',
        }),
      });
      const { accessToken } = (await regRes.json()) as any;

      const meRes = await fetch(`${baseUrl}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      expect(meRes.status).toBe(200);
      const meData = (await meRes.json()) as any;
      expect(meData.user.email).toBe('me@freebuff.dev');
      expect(meData.user.name).toBe('Me User');
      expect(meData.user.createdAt).toBeDefined();
      expect(meData.deviceCount).toBe(0);
      expect(meData.connectedDeviceCount).toBe(0);
    });

    it('should reject /auth/me without token', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/me`);
      expect(res.status).toBe(401);
    });

    it('should logout successfully with a valid token', async () => {
      const regRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'logout@freebuff.dev',
          password: 'Password123!',
          name: 'Logout User',
        }),
      });
      const { accessToken } = (await regRes.json()) as any;

      const logoutRes = await fetch(`${baseUrl}/api/v1/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      expect(logoutRes.status).toBe(200);
      const data = (await logoutRes.json()) as any;
      expect(data.success).toBe(true);
      expect(data.message).toBe('Logged out successfully');
    });

    it('should reject logout without a token', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/logout`, {
        method: 'POST',
      });
      expect(res.status).toBe(401);
    });

    it('should refresh tokens using a valid refresh token', async () => {
      const regRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'refresh@freebuff.dev',
          password: 'Password123!',
          name: 'Refresh User',
        }),
      });
      const { refreshToken } = (await regRes.json()) as any;
      expect(refreshToken).toBeDefined();

      const refreshRes = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

      expect(refreshRes.status).toBe(200);
      const data = (await refreshRes.json()) as any;
      expect(data.accessToken).toBeDefined();
      expect(data.refreshToken).toBeDefined();
      // New access token should be usable
      const meRes = await fetch(`${baseUrl}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${data.accessToken}` },
      });
      expect(meRes.status).toBe(200);
    });

    it('should reject refresh with an access token instead of refresh token', async () => {
      const regRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'wrong-token-type@freebuff.dev',
          password: 'Password123!',
        }),
      });
      const { accessToken } = (await regRes.json()) as any;

      const refreshRes = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: accessToken }),
      });

      expect(refreshRes.status).toBe(401);
      const data = (await refreshRes.json()) as any;
      expect(data.error).toContain('not a refresh token');
    });

    it('should reject refresh with a tampered token', async () => {
      const refreshRes = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: 'invalid.token.here' }),
      });

      expect(refreshRes.status).toBe(401);
    });

    it('should reject refresh without a refreshToken field', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });
  });
});
