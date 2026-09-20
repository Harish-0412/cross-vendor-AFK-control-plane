import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = scryptSync(password, salt, 64);
  return `${salt}:${derivedKey.toString('hex')}`;
}

export function verifyPassword(password: string, combinedHash: string): boolean {
  const parts = combinedHash.split(':');
  if (parts.length !== 2) {
    return false;
  }
  const [salt, keyHex] = parts as [string, string];
  const expectedKey = Buffer.from(keyHex, 'hex');
  const actualKey = scryptSync(password, salt, 64);

  if (expectedKey.length !== actualKey.length) {
    return false;
  }
  return timingSafeEqual(expectedKey, actualKey);
}
