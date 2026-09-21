/**
 * The confirmation code that links a browser request to a workstation approval.
 *
 * The Control Plane generates the code, shows it only in the requesting
 * browser, and sends the gateway a salted hash of it. Approving at the
 * workstation means typing that code — so whoever approves must be looking at
 * the browser session that asked. A request made from a stolen web session
 * shows its code only to the thief; the owner at the workstation cannot
 * approve it by accident, because they do not have the code.
 *
 * Scheme (the Control Plane implements the same): sha256(`${salt}:${code}`),
 * hex, where `code` is uppercased with separators removed.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export const MAX_CONFIRMATION_ATTEMPTS = 5;

export function normaliseConfirmationCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hashConfirmationCode(code: string, salt: string): string {
  return createHash('sha256')
    .update(`${salt}:${normaliseConfirmationCode(code)}`)
    .digest('hex');
}

export function confirmationMatches(
  typed: string,
  expected: { salt: string; sha256: string },
): boolean {
  if (!typed || !expected?.salt || !/^[0-9a-f]{64}$/.test(expected.sha256 ?? '')) return false;
  const actual = Buffer.from(hashConfirmationCode(typed, expected.salt), 'hex');
  const wanted = Buffer.from(expected.sha256, 'hex');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
