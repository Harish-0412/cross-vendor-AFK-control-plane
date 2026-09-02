import { describe, it, expect } from 'vitest';

import {
  loadEnvOptions,
  mergeGatewayOptions,
  mergeResourceLimits,
  isDevelopmentMode,
  isTestMode,
  ENV_VAR_NAMES,
  DEFAULT_GATEWAY_OPTIONS,
  DEFAULT_API_HOST,
  DEFAULT_API_PORT,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
} from './index';

describe('re-exported protocol defaults', () => {
  it('exposes the API and shutdown defaults through @freebuff/config', () => {
    // Regression: these are imported into constants.ts rather than declared
    // there, and `export *` does not forward plain imports. They were missing
    // from the package's public surface, so `import { DEFAULT_API_HOST } from
    // '@freebuff/config'` resolved to undefined and the API server bound to an
    // undefined host and port.
    expect(DEFAULT_API_HOST).toBeDefined();
    expect(typeof DEFAULT_API_HOST).toBe('string');
    expect(DEFAULT_API_PORT).toBeDefined();
    expect(typeof DEFAULT_API_PORT).toBe('number');
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('loadEnvOptions', () => {
  it('returns an empty object when nothing is set', () => {
    expect(loadEnvOptions({})).toEqual({});
  });

  it('reads gateway and device identifiers', () => {
    const options = loadEnvOptions({
      [ENV_VAR_NAMES.GATEWAY_ID]: 'gw_1',
      [ENV_VAR_NAMES.DEVICE_ID]: 'dev_1',
    });
    expect(options.gatewayId).toBe('gw_1');
    expect(options.deviceId).toBe('dev_1');
  });

  it('ignores a log level that is not a known level', () => {
    // An unrecognised level must fall through to the default rather than being
    // passed to the logger verbatim.
    expect(loadEnvOptions({ [ENV_VAR_NAMES.LOG_LEVEL]: 'verbose' }).logLevel).toBeUndefined();
    expect(loadEnvOptions({ [ENV_VAR_NAMES.LOG_LEVEL]: 'debug' }).logLevel).toBe('debug');
  });

  it('parses the API port as a number', () => {
    const options = loadEnvOptions({ [ENV_VAR_NAMES.API_PORT]: '8080' });
    expect(options.apiServer?.port).toBe(8080);
  });

  it('does not enable remote API access from the environment', () => {
    // Binding beyond localhost is a deliberate decision, never an env-var
    // side effect.
    const options = loadEnvOptions({
      [ENV_VAR_NAMES.API_HOST]: '0.0.0.0',
      [ENV_VAR_NAMES.API_PORT]: '9000',
    });
    expect(options.apiServer?.allowRemote).toBe(false);
  });

  it('treats sandbox and redaction as opt-out, not opt-in', () => {
    // Any value other than the literal 'false' must leave these protections on.
    expect(loadEnvOptions({ [ENV_VAR_NAMES.SANDBOX_ENABLED]: 'false' }).sandboxEnabled).toBe(false);
    expect(loadEnvOptions({ [ENV_VAR_NAMES.SANDBOX_ENABLED]: 'no' }).sandboxEnabled).toBe(true);
    expect(loadEnvOptions({ [ENV_VAR_NAMES.SANDBOX_ENABLED]: '0' }).sandboxEnabled).toBe(true);
    expect(loadEnvOptions({ [ENV_VAR_NAMES.REDACTION_ENABLED]: 'false' }).redaction?.enabled).toBe(
      false,
    );
    expect(loadEnvOptions({ [ENV_VAR_NAMES.REDACTION_ENABLED]: 'off' }).redaction?.enabled).toBe(
      true,
    );
  });

  it('leaves sandbox untouched when the variable is absent', () => {
    expect(loadEnvOptions({}).sandboxEnabled).toBeUndefined();
  });
});

describe('mergeGatewayOptions', () => {
  it('falls back to defaults when given nothing', () => {
    const merged = mergeGatewayOptions();
    expect(merged.sandboxEnabled).toBe(DEFAULT_GATEWAY_OPTIONS.sandboxEnabled);
    expect(merged.logLevel).toBe(DEFAULT_GATEWAY_OPTIONS.logLevel);
  });

  it('lets later sources win', () => {
    const merged = mergeGatewayOptions({ logLevel: 'warn' }, { logLevel: 'error' });
    expect(merged.logLevel).toBe('error');
  });

  it('skips undefined sources', () => {
    const merged = mergeGatewayOptions(undefined, { logLevel: 'debug' }, undefined);
    expect(merged.logLevel).toBe('debug');
  });

  it('keeps sandboxing on unless a source explicitly disables it', () => {
    expect(mergeGatewayOptions({}).sandboxEnabled).toBe(true);
    expect(mergeGatewayOptions({ sandboxEnabled: false }).sandboxEnabled).toBe(false);
  });
});

describe('mergeResourceLimits', () => {
  it('prefers the override and keeps unspecified fields', () => {
    const merged = mergeResourceLimits({ cpuPercent: 50, memoryMb: 1024 }, { cpuPercent: 25 });
    expect(merged.cpuPercent).toBe(25);
    expect(merged.memoryMb).toBe(1024);
  });
});

describe('mode detection', () => {
  it('detects development and test from NODE_ENV', () => {
    expect(isDevelopmentMode({ [ENV_VAR_NAMES.NODE_ENV]: 'development' })).toBe(true);
    expect(isDevelopmentMode({ [ENV_VAR_NAMES.NODE_ENV]: 'production' })).toBe(false);
    expect(isTestMode({ [ENV_VAR_NAMES.NODE_ENV]: 'test' })).toBe(true);
    expect(isTestMode({ [ENV_VAR_NAMES.NODE_ENV]: 'production' })).toBe(false);
  });
});
