import { randomBytes } from 'node:crypto';
import {
  PAIRING_CODE_CHARSET,
  PAIRING_CODE_LENGTH,
  DEFAULT_PAIRING_TTL_MS,
} from './types';
import { PairingCode, isPairingCodeExpired } from '@freebuff/protocol';

export function generatePairingCode(length: number = PAIRING_CODE_LENGTH): string {
  let result = '';
  const charset = PAIRING_CODE_CHARSET;
  const random = randomBytes(length);
  for (let i = 0; i < length; i++) {
    result += charset[random[i] % charset.length];
  }
  return result;
}

export function createPairingCode(
  deviceId: string,
  publicKeyFingerprint: string,
  ttlMs: number = DEFAULT_PAIRING_TTL_MS,
): PairingCode {
  const now = new Date();
  return {
    code: generatePairingCode(),
    issuedAt: now,
    expiresAt: new Date(now.getTime() + ttlMs),
    deviceId,
    publicKeyFingerprint,
  };
}

export function validatePairingCodeFormat(code: string, expectedLength: number = PAIRING_CODE_LENGTH): boolean {
  if (typeof code !== 'string') return false;
  if (code.length !== expectedLength) return false;
  const pattern = new RegExp(`^[${PAIRING_CODE_CHARSET}]+$`);
  return pattern.test(code);
}

export interface RateLimiterConfig {
  maxAttempts: number;
  windowMs: number;
  maxCodesPerWindow: number;
}

export const DEFAULT_RATE_LIMITER_CONFIG: RateLimiterConfig = {
  maxAttempts: 10,
  windowMs: 5 * 60 * 1000,
  maxCodesPerWindow: 5,
};

export class PairingRateLimiter {
  private readonly config: RateLimiterConfig;
  private codeGenerationTimestamps: number[] = [];
  private attemptsPerCode: Map<string, { count: number; expiresAt: number }> = new Map();

  constructor(config: Partial<RateLimiterConfig> = {}) {
    this.config = { ...DEFAULT_RATE_LIMITER_CONFIG, ...config };
  }

  canGenerateCode(): boolean {
    const now = Date.now();
    this.codeGenerationTimestamps = this.codeGenerationTimestamps.filter(
      (t) => now - t < this.config.windowMs,
    );
    return this.codeGenerationTimestamps.length < this.config.maxCodesPerWindow;
  }

  recordCodeGeneration(): void {
    this.codeGenerationTimestamps.push(Date.now());
  }

  recordAttempt(code: string): boolean {
    const now = Date.now();
    const entry = this.attemptsPerCode.get(code);

    if (entry && now < entry.expiresAt) {
      entry.count++;
      if (entry.count > this.config.maxAttempts) {
        return false;
      }
    } else {
      this.attemptsPerCode.set(code, {
        count: 1,
        expiresAt: now + this.config.windowMs,
      });
    }
    return true;
  }

  getAttempts(code: string): number {
    return this.attemptsPerCode.get(code)?.count ?? 0;
  }

  cleanup(): void {
    const now = Date.now();
    for (const [code, entry] of this.attemptsPerCode.entries()) {
      if (now >= entry.expiresAt) {
        this.attemptsPerCode.delete(code);
      }
    }
  }
}

export function createPairingRateLimiter(
  config?: Partial<RateLimiterConfig>,
): PairingRateLimiter {
  return new PairingRateLimiter(config);
}

export { isPairingCodeExpired };
