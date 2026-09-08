import { createHmac, timingSafeEqual } from 'node:crypto';

export interface JwtPayload {
  sub: string; // userId or deviceId
  email?: string;
  role?: 'user' | 'admin' | 'owner' | 'device';
  type?: 'access' | 'refresh' | 'device';
  iat?: number;
  exp?: number;
  [key: string]: unknown;
}

function base64UrlEncode(data: string | Buffer): string {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString('utf8');
}

export function signJwt(payload: JwtPayload, secret: string, expiresInSec = 86400): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const fullPayload: JwtPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInSec,
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(fullPayload));
  const data = `${headerB64}.${payloadB64}`;

  const hmac = createHmac('sha256', secret);
  hmac.update(data);
  const signatureB64 = base64UrlEncode(hmac.digest());

  return `${data}.${signatureB64}`;
}

export function verifyJwt(token: string, secret: string): JwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid token structure');
  }

  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
  const data = `${headerB64}.${payloadB64}`;

  const hmac = createHmac('sha256', secret);
  hmac.update(data);
  const expectedSig = hmac.digest();
  const actualSig = Buffer.from(
    signatureB64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((signatureB64.length + 3) % 4),
    'base64',
  );

  if (expectedSig.length !== actualSig.length || !timingSafeEqual(expectedSig, actualSig)) {
    throw new Error('Invalid token signature');
  }

  const payload = JSON.parse(base64UrlDecode(payloadB64)) as JwtPayload;
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) {
    throw new Error('Token has expired');
  }

  return payload;
}
