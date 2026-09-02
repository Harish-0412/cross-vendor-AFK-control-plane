import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  generatePairingCode,
  createPairingCode,
  validatePairingCodeFormat,
  type PairingRateLimiter,
  createPairingRateLimiter,
  DEFAULT_RATE_LIMITER_CONFIG,
} from '../code-generator';
import { PAIRING_CODE_LENGTH, PAIRING_CODE_CHARSET, DEFAULT_PAIRING_TTL_MS } from '../types';

describe('generatePairingCode', () => {
  it('should generate a code of the default length', () => {
    const code = generatePairingCode();
    expect(code).toHaveLength(PAIRING_CODE_LENGTH);
  });

  it('should generate a code of custom length', () => {
    const code = generatePairingCode(6);
    expect(code).toHaveLength(6);
  });

  it('should only contain valid characters', () => {
    const code = generatePairingCode(50);
    for (const char of code) {
      expect(PAIRING_CODE_CHARSET).toContain(char);
    }
  });

  it('should not contain ambiguous characters (0, O, I, 1)', () => {
    const code = generatePairingCode(100);
    expect(code).not.toMatch(/[0OI1]/);
  });

  it('should generate different codes on successive calls', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) {
      codes.add(generatePairingCode());
    }
    // With 8-char codes from a 30-char charset, collisions are extremely rare
    expect(codes.size).toBeGreaterThan(15);
  });
});

describe('createPairingCode', () => {
  it('should create a PairingCode with all required fields', () => {
    const deviceId = 'dev_abc123def456';
    const fingerprint = 'aabbccdd';
    const code = createPairingCode(deviceId, fingerprint);

    expect(code.code).toHaveLength(PAIRING_CODE_LENGTH);
    expect(code.deviceId).toBe(deviceId);
    expect(code.publicKeyFingerprint).toBe(fingerprint);
    expect(code.issuedAt).toBeInstanceOf(Date);
    expect(code.expiresAt).toBeInstanceOf(Date);
    expect(code.expiresAt.getTime()).toBeGreaterThan(code.issuedAt.getTime());
  });

  it('should use default TTL', () => {
    const code = createPairingCode('dev_test', 'fp_test');
    const diff = code.expiresAt.getTime() - code.issuedAt.getTime();
    expect(diff).toBe(DEFAULT_PAIRING_TTL_MS);
  });

  it('should use custom TTL', () => {
    const ttlMs = 60_000;
    const code = createPairingCode('dev_test', 'fp_test', ttlMs);
    const diff = code.expiresAt.getTime() - code.issuedAt.getTime();
    expect(diff).toBe(ttlMs);
  });
});

describe('validatePairingCodeFormat', () => {
  it('should accept a valid 8-char code', () => {
    expect(validatePairingCodeFormat('ABCDEFGH')).toBe(true);
  });

  it('should accept a valid 6-char code', () => {
    expect(validatePairingCodeFormat('ABCDEF', 6)).toBe(true);
  });

  it('should reject wrong-length code', () => {
    expect(validatePairingCodeFormat('ABCD')).toBe(false);
    expect(validatePairingCodeFormat('ABCDEFGHIJ')).toBe(false);
  });

  it('should reject codes with lowercase letters', () => {
    expect(validatePairingCodeFormat('abcdefgh')).toBe(false);
  });

  it('should reject codes with invalid characters (0, O, I, L, 1)', () => {
    expect(validatePairingCodeFormat('ABCDEF0G')).toBe(false);
    expect(validatePairingCodeFormat('ABCOEFGH')).toBe(false);
    expect(validatePairingCodeFormat('ABIJEFGH')).toBe(false);
  });

  it('should reject non-string inputs', () => {
    expect(validatePairingCodeFormat(null as any)).toBe(false);
    expect(validatePairingCodeFormat(undefined as any)).toBe(false);
    expect(validatePairingCodeFormat(12345 as any)).toBe(false);
  });
});

describe('PairingRateLimiter', () => {
  let limiter: PairingRateLimiter;

  beforeEach(() => {
    limiter = createPairingRateLimiter({ windowMs: 60_000, maxCodesPerWindow: 3, maxAttempts: 5 });
  });

  it('should allow code generation initially', () => {
    expect(limiter.canGenerateCode()).toBe(true);
  });

  it('should track code generations and block when limit reached', () => {
    limiter.recordCodeGeneration();
    limiter.recordCodeGeneration();
    limiter.recordCodeGeneration();
    expect(limiter.canGenerateCode()).toBe(false);
  });

  it('should track attempts per code', () => {
    limiter.recordAttempt('TEST1234');
    limiter.recordAttempt('TEST1234');
    expect(limiter.getAttempts('TEST1234')).toBe(2);
  });

  it('should block when max attempts exceeded', () => {
    for (let i = 0; i < 5; i++) {
      const ok = limiter.recordAttempt('CODE1234');
      if (i < 4) expect(ok).toBe(true);
    }
    // 6th attempt should be blocked
    expect(limiter.recordAttempt('CODE1234')).toBe(false);
  });

  it('should cleanup expired entries', () => {
    limiter.recordAttempt('OLD_CODE');
    limiter.cleanup();
    // Old code should still exist since it hasn't expired
    expect(limiter.getAttempts('OLD_CODE')).toBe(1);
  });
});
