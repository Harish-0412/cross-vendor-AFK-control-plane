import type { GatewayOptions, ResourceLimits } from '@freebuff/protocol';
import { validateGatewayOptions } from '@freebuff/schemas';

import { DEFAULT_GATEWAY_OPTIONS, ENV_VAR_NAMES } from './constants';

export function loadEnvOptions(
  env: Record<string, string | undefined> = process.env,
): Partial<GatewayOptions> {
  const options: Partial<GatewayOptions> = {};

  const gatewayId = env[ENV_VAR_NAMES.GATEWAY_ID];
  if (gatewayId) {
    options.gatewayId = gatewayId;
  }
  const deviceId = env[ENV_VAR_NAMES.DEVICE_ID];
  if (deviceId) {
    options.deviceId = deviceId;
  }
  const logLevel = env[ENV_VAR_NAMES.LOG_LEVEL];
  if (logLevel && ['error', 'warn', 'info', 'debug', 'trace'].includes(logLevel)) {
    options.logLevel = logLevel as 'error' | 'warn' | 'info' | 'debug' | 'trace';
  }
  const apiHost = env[ENV_VAR_NAMES.API_HOST];
  const apiPort = env[ENV_VAR_NAMES.API_PORT];
  if (apiHost || apiPort) {
    type ApiServer = NonNullable<GatewayOptions['apiServer']>;
    const apiServer: ApiServer = {
      enabled: true,
      allowRemote: false,
    };
    if (apiHost) {
      apiServer.host = apiHost;
    }
    if (apiPort) {
      apiServer.port = parseInt(apiPort, 10);
    }
    options.apiServer = apiServer;
  }
  if (env[ENV_VAR_NAMES.SANDBOX_ENABLED] !== undefined) {
    options.sandboxEnabled = env[ENV_VAR_NAMES.SANDBOX_ENABLED] !== 'false';
  }
  if (env[ENV_VAR_NAMES.REDACTION_ENABLED] !== undefined) {
    type Redaction = NonNullable<GatewayOptions['redaction']>;
    const redaction: Redaction = {
      enabled: env[ENV_VAR_NAMES.REDACTION_ENABLED] !== 'false',
    };
    options.redaction = redaction;
  }

  return options;
}

export function mergeGatewayOptions(
  ...options: Array<Partial<GatewayOptions> | undefined>
): GatewayOptions {
  const sandboxEnabled: boolean = DEFAULT_GATEWAY_OPTIONS.sandboxEnabled;
  const logLevel: 'error' | 'warn' | 'info' | 'debug' | 'trace' = DEFAULT_GATEWAY_OPTIONS.logLevel;
  const shutdownTimeoutMs: number = DEFAULT_GATEWAY_OPTIONS.shutdownTimeoutMs;

  const merged: Record<string, unknown> = {
    sandboxEnabled,
    logLevel,
    shutdownTimeoutMs,
  };

  type ApiServer = NonNullable<GatewayOptions['apiServer']>;
  const api: ApiServer = {
    enabled: DEFAULT_GATEWAY_OPTIONS.apiServer.enabled,
  };
  if (DEFAULT_GATEWAY_OPTIONS.apiServer.host !== undefined) {
    api.host = DEFAULT_GATEWAY_OPTIONS.apiServer.host;
  }
  if (DEFAULT_GATEWAY_OPTIONS.apiServer.port !== undefined) {
    api.port = DEFAULT_GATEWAY_OPTIONS.apiServer.port;
  }
  if (DEFAULT_GATEWAY_OPTIONS.apiServer.allowRemote !== undefined) {
    api.allowRemote = DEFAULT_GATEWAY_OPTIONS.apiServer.allowRemote;
  }
  merged.apiServer = api;

  type Redaction = NonNullable<GatewayOptions['redaction']>;
  const redaction: Redaction = {
    enabled: DEFAULT_GATEWAY_OPTIONS.redaction.enabled,
  };
  if (DEFAULT_GATEWAY_OPTIONS.redaction.customPatterns !== undefined) {
    redaction.customPatterns = DEFAULT_GATEWAY_OPTIONS.redaction.customPatterns;
  }
  merged.redaction = redaction;

  for (const opts of options) {
    if (!opts) continue;

    if (opts.gatewayId !== undefined) merged.gatewayId = opts.gatewayId;
    if (opts.deviceId !== undefined) merged.deviceId = opts.deviceId;
    if (opts.projectRoots !== undefined) merged.projectRoots = opts.projectRoots;
    if (opts.allowedAdapters !== undefined) merged.allowedAdapters = opts.allowedAdapters;
    if (opts.sandboxEnabled !== undefined) merged.sandboxEnabled = opts.sandboxEnabled;
    if (opts.logLevel !== undefined) merged.logLevel = opts.logLevel;
    if (opts.shutdownTimeoutMs !== undefined) merged.shutdownTimeoutMs = opts.shutdownTimeoutMs;

    if (opts.apiServer) {
      const a = opts.apiServer;
      const dst = merged.apiServer as ApiServer;
      if (a.enabled !== undefined) dst.enabled = a.enabled;
      if (a.host !== undefined) dst.host = a.host;
      if (a.port !== undefined) dst.port = a.port;
      if (a.allowRemote !== undefined) dst.allowRemote = a.allowRemote;
    }

    if (opts.redaction) {
      const r = opts.redaction;
      const dst = merged.redaction as Redaction;
      if (r.enabled !== undefined) dst.enabled = r.enabled;
      if (r.customPatterns !== undefined) dst.customPatterns = r.customPatterns;
    }
  }

  const validated = validateGatewayOptions(merged);
  if (!validated.success) {
    const msgs = validated.error.errors.map((e) => e.message).join(', ');
    throw new Error(`Invalid gateway options: ${msgs}`);
  }

  return validated.data as GatewayOptions;
}

export function mergeResourceLimits(
  base: ResourceLimits = {},
  overrides: ResourceLimits = {},
): ResourceLimits {
  return { ...base, ...overrides };
}

export function isDevelopmentMode(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== 'production';
}

export function isTestMode(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === 'test' || !!env.VITEST;
}
