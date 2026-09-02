import type { GatewayOptions, SandboxProfile, SandboxConfig } from '@freebuff/protocol';
import {
  DEFAULT_API_HOST,
  DEFAULT_API_PORT,
  DEFAULT_GATEWAY_FEATURES,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  SANDBOX_PROFILE_DEFAULTS,
  DEFAULT_DENIED_PATHS,
} from '@freebuff/protocol';

/**
 * Re-exported from `@freebuff/protocol` so consumers can pull defaults and the
 * config helpers that build on them from a single package. `export *` does not
 * forward plain imports, so these have to be named explicitly — without this,
 * `import { DEFAULT_API_HOST } from '@freebuff/config'` silently resolves to
 * `undefined` at runtime and the API server binds to an undefined host/port.
 */
export {
  DEFAULT_API_HOST,
  DEFAULT_API_PORT,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  DEFAULT_GATEWAY_FEATURES,
  SANDBOX_PROFILE_DEFAULTS,
  DEFAULT_DENIED_PATHS,
} from '@freebuff/protocol';

export const APP_NAME = 'freebuff';
export const APP_DISPLAY_NAME = 'Freebuff AFK Control Plane';

export const CONFIG_DIR_NAMES = {
  LINUX: '.config/freebuff',
  DARWIN: 'Library/Application Support/freebuff',
  WIN32: 'AppData/Roaming/freebuff',
} as const;

export const DEFAULT_GATEWAY_OPTIONS: Required<
  Pick<GatewayOptions, 'sandboxEnabled' | 'logLevel' | 'shutdownTimeoutMs'>
> & {
  apiServer: NonNullable<GatewayOptions['apiServer']>;
  redaction: NonNullable<GatewayOptions['redaction']>;
} = {
  sandboxEnabled: true,
  logLevel: 'info',
  shutdownTimeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
  apiServer: {
    enabled: true,
    host: DEFAULT_API_HOST,
    port: DEFAULT_API_PORT,
    allowRemote: false,
  },
  redaction: {
    enabled: true,
    customPatterns: [],
  },
};

export const EVENT_BUFFER_MAX_SIZE = 10000;
export const SESSION_REGISTRY_MAX_SESSIONS = 1000;
export const AGENT_DETECTION_CACHE_TTL_MS = 5 * 60 * 1000;
export const PROJECT_ACCESS_TTL_MS = 24 * 60 * 60 * 1000;
export const SANDBOX_CLEANUP_INTERVAL_MS = 60 * 1000;
export const HEARTBEAT_INTERVAL_MS = 10 * 1000;

export const DEFAULT_EVENT_VERSION = 1;
export const DEFAULT_COMMAND_VERSION = 1;

export const MAX_MESSAGE_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_DIFF_SIZE_BYTES = 5 * 1024 * 1024;

export const APPROVAL_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const APPROVAL_MIN_TIMEOUT_MS = 30 * 1000;
export const APPROVAL_MAX_TIMEOUT_MS = 60 * 60 * 1000;

export const SESSION_DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
export const SESSION_MIN_TIMEOUT_MS = 10 * 1000;
export const SESSION_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_SANDBOX_PROFILE: SandboxProfile = 'standard';

export function getDefaultSandboxConfig(projectRoot: string): SandboxConfig {
  const defaults = SANDBOX_PROFILE_DEFAULTS[DEFAULT_SANDBOX_PROFILE];
  return {
    projectRoot,
    agentBinary: 'node',
    agentArgs: [],
    env: {},
    resourceLimits: { ...defaults.resourceLimits },
    networkPolicy: {
      mode: defaults.networkMode,
    },
    writablePaths: [projectRoot],
    readablePaths: [projectRoot],
    deniedPaths: [...DEFAULT_DENIED_PATHS],
    profile: DEFAULT_SANDBOX_PROFILE,
  };
}

export const LOG_PATTERNS = {
  SESSION_ID: /sess_[a-f0-9]{24}/g,
  EVENT_ID: /evt_[a-f0-9]{32}/g,
  COMMAND_ID: /cmd_[a-f0-9]{24}/g,
  SANDBOX_ID: /sbx_[a-f0-9]{24}/g,
  PROJECT_ID: /proj_[a-f0-9]{24}/g,
  DEVICE_ID: /dev_[a-f0-9]{32}/g,
  GATEWAY_ID: /gw_[a-f0-9]{24}/g,
};

export const ENV_VAR_NAMES = {
  GATEWAY_ID: 'FREEBUFF_GATEWAY_ID',
  DEVICE_ID: 'FREEBUFF_DEVICE_ID',
  DEVICE_KEY_PATH: 'FREEBUFF_DEVICE_KEY_PATH',
  CONFIG_DIR: 'FREEBUFF_CONFIG_DIR',
  DATA_DIR: 'FREEBUFF_DATA_DIR',
  LOG_LEVEL: 'FREEBUFF_LOG_LEVEL',
  LOG_FILE: 'FREEBUFF_LOG_FILE',
  API_HOST: 'FREEBUFF_API_HOST',
  API_PORT: 'FREEBUFF_API_PORT',
  SANDBOX_ENABLED: 'FREEBUFF_SANDBOX_ENABLED',
  REDACTION_ENABLED: 'FREEBUFF_REDACTION_ENABLED',
  NODE_ENV: 'NODE_ENV',
} as const;

export const GATEWAY_FEATURES = DEFAULT_GATEWAY_FEATURES;
