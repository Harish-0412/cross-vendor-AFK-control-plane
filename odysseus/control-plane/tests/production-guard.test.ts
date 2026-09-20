import { describe, it, expect } from 'vitest';

import { DEV_JWT_SECRET } from '../src/config';
import {
  assertProductionConfig,
  collectProductionConfigErrors,
  isProduction,
} from '../src/production-guard';

/**
 * Every default this guards is correct for local development and dangerous in
 * production. The point of the guard is that a misconfigured deployment must
 * not start: an insecure Control Plane that boots cleanly looks exactly like a
 * secure one, and nobody re-reads a warning in a deploy log.
 */
describe('production configuration guard', () => {
  const goodSecret = 'x'.repeat(48);

  const safeInput = {
    config: {
      jwtSecret: goodSecret,
      corsOrigins: ['https://app.odysseus.test'],
      secureCookies: true,
    },
    env: {
      JWT_SECRET: goodSecret,
      CORS_ORIGINS: 'https://app.odysseus.test',
    } as NodeJS.ProcessEnv,
    usingMemoryDatabase: false,
  };

  it('passes a correctly configured deployment', () => {
    expect(collectProductionConfigErrors(safeInput)).toEqual([]);
    expect(() => assertProductionConfig(safeInput)).not.toThrow();
  });

  it('refuses a missing JWT_SECRET', () => {
    const errors = collectProductionConfigErrors({
      ...safeInput,
      config: { ...safeInput.config, jwtSecret: DEV_JWT_SECRET },
      env: { CORS_ORIGINS: 'https://app.odysseus.test' },
    });
    expect(errors.join('\n')).toMatch(/JWT_SECRET is not set/);
  });

  it('refuses the published development secret', () => {
    const errors = collectProductionConfigErrors({
      ...safeInput,
      config: { ...safeInput.config, jwtSecret: DEV_JWT_SECRET },
      env: { ...safeInput.env, JWT_SECRET: DEV_JWT_SECRET },
    });
    expect(errors.join('\n')).toMatch(/development default/);
  });

  it('refuses a short secret', () => {
    const errors = collectProductionConfigErrors({
      ...safeInput,
      config: { ...safeInput.config, jwtSecret: 'short' },
      env: { ...safeInput.env, JWT_SECRET: 'short' },
    });
    expect(errors.join('\n')).toMatch(/at least 32/);
  });

  it('refuses a wildcard CORS origin', () => {
    const errors = collectProductionConfigErrors({
      ...safeInput,
      config: { ...safeInput.config, corsOrigins: ['*'] },
      env: { ...safeInput.env, CORS_ORIGINS: '*' },
    });
    expect(errors.join('\n')).toMatch(/cookie security model/);
  });

  it('refuses an unset CORS_ORIGINS, which would reject the real frontend', () => {
    const errors = collectProductionConfigErrors({
      ...safeInput,
      env: { JWT_SECRET: goodSecret },
    });
    expect(errors.join('\n')).toMatch(/CORS_ORIGINS is not set/);
  });

  it('refuses a plain-http production origin but allows loopback', () => {
    const insecure = collectProductionConfigErrors({
      ...safeInput,
      config: { ...safeInput.config, corsOrigins: ['http://app.odysseus.test'] },
      env: { ...safeInput.env, CORS_ORIGINS: 'http://app.odysseus.test' },
    });
    expect(insecure.join('\n')).toMatch(/insecure origin/);

    const loopback = collectProductionConfigErrors({
      ...safeInput,
      config: { ...safeInput.config, corsOrigins: ['http://localhost:3000'] },
      env: { ...safeInput.env, CORS_ORIGINS: 'http://localhost:3000' },
    });
    expect(loopback).toEqual([]);
  });

  it('refuses to run on the in-memory database', () => {
    const errors = collectProductionConfigErrors({ ...safeInput, usingMemoryDatabase: true });
    expect(errors.join('\n')).toMatch(/erase users, paired devices, sessions/);
  });

  it('refuses insecure cookies', () => {
    const errors = collectProductionConfigErrors({
      ...safeInput,
      config: { ...safeInput.config, secureCookies: false },
    });
    expect(errors.join('\n')).toMatch(/SECURE_COOKIES/);
  });

  it('reports every problem at once rather than one per deploy', () => {
    // Finding out about four misconfigurations one deploy at a time is what
    // makes people disable the check.
    const errors = collectProductionConfigErrors({
      config: { jwtSecret: DEV_JWT_SECRET, corsOrigins: ['*'], secureCookies: false },
      env: {} as NodeJS.ProcessEnv,
      usingMemoryDatabase: true,
    });
    expect(errors.length).toBeGreaterThanOrEqual(4);

    let thrown: Error | undefined;
    try {
      assertProductionConfig({
        config: { jwtSecret: DEV_JWT_SECRET, corsOrigins: ['*'], secureCookies: false },
        env: {} as NodeJS.ProcessEnv,
        usingMemoryDatabase: true,
      });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown?.message).toMatch(/Refusing to start/);
    expect(thrown?.message).toMatch(/1\./);
    expect(thrown?.message).toMatch(/4\./);
  });

  it('only applies in production', () => {
    expect(isProduction({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isProduction({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isProduction({} as NodeJS.ProcessEnv)).toBe(false);
  });
});
