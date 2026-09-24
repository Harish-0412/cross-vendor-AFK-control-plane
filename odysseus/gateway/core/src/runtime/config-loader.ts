/**
 * Layered gateway configuration.
 *
 * Precedence follows the Viper/Cobra convention that operators already expect,
 * with one addition:
 *
 *     CLI flag  >  environment variable  >  config file  >  pairing  >  built-in default
 *
 * The pairing layer is the Control Plane this device was registered on, as
 * recorded by `pair`. It sits just above the defaults because it is a better
 * guess than any default — it is the only server that will accept this device —
 * but anything the operator sets explicitly still overrides it.
 *
 * Every resolved value records which layer it came from, so `--print-config`
 * can answer "why is this value what it is" — the question that costs the most
 * time when a deployment behaves unexpectedly.
 *
 * Validation stays where it already was: `mergeGatewayOptions` runs the Zod
 * schema once, at the boundary. This module only decides what goes in.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { mergeGatewayOptions } from '@odysseus/config';
import type { GatewayOptions } from '@odysseus/protocol';
import { parse as parseYaml } from 'yaml';

import { pairingRecordPath, readPairingRecord } from './paired-control-plane';

export type ConfigLayerName = 'defaults' | 'pairing' | 'file' | 'env' | 'flags';

export interface ConfigLayer {
  name: ConfigLayerName;
  values: Partial<GatewayOptions>;
  /** Where this layer came from (file path, or a description). */
  source: string;
}

export interface ResolvedConfig {
  options: GatewayOptions;
  layers: ConfigLayer[];
  /** Dotted option path -> the layer that won it. */
  provenance: Record<string, ConfigLayerName>;
  warnings: string[];
  /** Flags that do not configure the gateway but change what the CLI does. */
  directives: { printConfig: boolean; help: boolean; version: boolean };
}

export interface LoadConfigInput {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  home?: string;
  /** Injectable for tests. */
  readFile?: (path: string) => string;
}

const DEFAULT_CONTROL_PLANE_URL = 'ws://localhost:4000/ws/tunnel';

export const CONFIG_FILE_NAMES = ['config.yaml', 'config.yml', 'config.json'] as const;

// ------------------------------------------------------------------ parsing

interface ParsedFlags {
  values: Partial<GatewayOptions>;
  configPath?: string;
  authTokenFile?: string;
  directives: { printConfig: boolean; help: boolean; version: boolean };
  warnings: string[];
}

function parseFlags(argv: string[]): ParsedFlags {
  const values: Partial<GatewayOptions> = {};
  const warnings: string[] = [];
  const projectRoots: string[] = [];
  const adapters: string[] = [];
  const directives = { printConfig: false, help: false, version: false };
  let configPath: string | undefined;
  let authTokenFile: string | undefined;

  const controlPlane: Partial<NonNullable<GatewayOptions['controlPlane']>> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg || !arg.startsWith('--')) continue;

    // Support both `--flag value` and `--flag=value`.
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
    const next = (): string | undefined => {
      if (inlineValue !== undefined) return inlineValue;
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return undefined;
      i++;
      return value;
    };

    switch (name) {
      case 'print-config':
        directives.printConfig = true;
        break;
      case 'help':
      case 'h':
        directives.help = true;
        break;
      case 'version':
        directives.version = true;
        break;
      case 'config': {
        const value = next();
        if (value) configPath = value;
        else warnings.push('--config given without a path');
        break;
      }
      case 'control-plane-url': {
        const value = next();
        if (value) controlPlane.url = value;
        else warnings.push('--control-plane-url given without a value');
        break;
      }
      case 'auth-token-file': {
        const value = next();
        if (value) authTokenFile = value;
        break;
      }
      case 'project-root': {
        const value = next();
        if (value) projectRoots.push(value);
        break;
      }
      case 'adapter': {
        const value = next();
        if (value) adapters.push(value);
        break;
      }
      case 'log-level': {
        const value = next();
        if (isLogLevel(value)) values.logLevel = value;
        else if (value) warnings.push(`--log-level got an unknown level: ${value}`);
        break;
      }
      case 'heartbeat-ms': {
        const value = toPositiveInt(next());
        if (value !== undefined) controlPlane.heartbeatIntervalMs = value;
        break;
      }
      case 'no-tunnel':
        controlPlane.autoConnect = false;
        break;
      default:
        warnings.push(`Unknown flag: --${name}`);
    }
  }

  if (projectRoots.length > 0) values.projectRoots = projectRoots;
  if (adapters.length > 0) values.allowedAdapters = adapters;
  if (Object.keys(controlPlane).length > 0) {
    values.controlPlane = controlPlane as NonNullable<GatewayOptions['controlPlane']>;
  }

  return {
    values,
    ...(configPath !== undefined ? { configPath } : {}),
    ...(authTokenFile !== undefined ? { authTokenFile } : {}),
    directives,
    warnings,
  };
}

function parseEnv(env: NodeJS.ProcessEnv): {
  values: Partial<GatewayOptions>;
  authTokenFile?: string;
  configPath?: string;
  warnings: string[];
} {
  const values: Partial<GatewayOptions> = {};
  const warnings: string[] = [];
  const controlPlane: Partial<NonNullable<GatewayOptions['controlPlane']>> = {};

  // CONTROL_PLANE_WS is the pre-existing name and stays supported so existing
  // setups keep working; the prefixed name wins when both are present.
  const url = env.ODYSSEUS_CONTROL_PLANE_URL ?? env.CONTROL_PLANE_WS;
  if (url) controlPlane.url = url;

  const heartbeat = toPositiveInt(env.ODYSSEUS_HEARTBEAT_MS);
  if (heartbeat !== undefined) controlPlane.heartbeatIntervalMs = heartbeat;

  if (env.ODYSSEUS_AUTH_TOKEN) controlPlane.authToken = env.ODYSSEUS_AUTH_TOKEN;

  const roots = env.ODYSSEUS_PROJECT_ROOTS;
  if (roots) {
    const parsed = roots
      .split(/[;,]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (parsed.length > 0) values.projectRoots = parsed;
  }

  const adapters = env.ODYSSEUS_ALLOWED_ADAPTERS;
  if (adapters) {
    const parsed = adapters
      .split(/[;,]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (parsed.length > 0) values.allowedAdapters = parsed;
  }

  if (env.ODYSSEUS_LOG_LEVEL) {
    if (isLogLevel(env.ODYSSEUS_LOG_LEVEL)) values.logLevel = env.ODYSSEUS_LOG_LEVEL;
    else warnings.push(`ODYSSEUS_LOG_LEVEL has an unknown level: ${env.ODYSSEUS_LOG_LEVEL}`);
  }

  if (Object.keys(controlPlane).length > 0) {
    values.controlPlane = controlPlane as NonNullable<GatewayOptions['controlPlane']>;
  }

  return {
    values,
    ...(env.ODYSSEUS_AUTH_TOKEN_FILE ? { authTokenFile: env.ODYSSEUS_AUTH_TOKEN_FILE } : {}),
    ...(env.ODYSSEUS_CONFIG ? { configPath: env.ODYSSEUS_CONFIG } : {}),
    warnings,
  };
}

function parseConfigFile(
  path: string,
  read: (p: string) => string,
): { values: Partial<GatewayOptions>; warnings: string[] } {
  const warnings: string[] = [];
  let raw: string;
  try {
    raw = read(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // A missing file at a default location is normal; a missing file the user
    // explicitly asked for is not, and the caller distinguishes them.
    if (code === 'ENOENT') return { values: {}, warnings };
    throw new Error(`Cannot read config file ${path}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = path.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw);
  } catch (err) {
    throw new Error(`Config file ${path} is not valid: ${(err as Error).message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnings.push(`Config file ${path} did not contain an object; ignored`);
    return { values: {}, warnings };
  }

  return { values: parsed as Partial<GatewayOptions>, warnings };
}

// ------------------------------------------------------------------ loading

export function loadGatewayConfig(input: LoadConfigInput = {}): ResolvedConfig {
  const argv = input.argv ?? process.argv.slice(2);
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const home = input.home ?? homedir();
  const read = input.readFile ?? ((p: string) => readFileSync(p, 'utf8'));

  const warnings: string[] = [];

  const flags = parseFlags(argv);
  warnings.push(...flags.warnings);
  const envLayer = parseEnv(env);
  warnings.push(...envLayer.warnings);

  // Defaults layer.
  const defaults: Partial<GatewayOptions> = {
    projectRoots: [cwd],
    controlPlane: { url: DEFAULT_CONTROL_PLANE_URL, autoConnect: true },
  };

  // Pairing layer: where `pair` registered this device.
  const pairing = readPairingRecord(home, read);
  const pairingValues: Partial<GatewayOptions> = pairing
    ? {
        controlPlane: {
          url: pairing.tunnelUrl,
        } as NonNullable<GatewayOptions['controlPlane']>,
      }
    : {};

  // File layer. An explicitly requested path must exist; the default location
  // is optional.
  const explicitPath = flags.configPath ?? envLayer.configPath;
  let filePath: string | undefined;
  let fileValues: Partial<GatewayOptions> = {};

  if (explicitPath) {
    filePath = isAbsolute(explicitPath) ? explicitPath : resolve(cwd, explicitPath);
    // A config file the user explicitly pointed at must exist. Silently
    // ignoring a typo'd --config path is how a deployment ends up running on
    // defaults while everyone believes it read the file.
    let exists = true;
    const parsed = parseConfigFile(filePath, (p) => {
      try {
        return read(p);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') exists = false;
        throw err;
      }
    });
    if (!exists) throw new Error(`Config file not found: ${filePath}`);
    fileValues = parsed.values;
    warnings.push(...parsed.warnings);
  } else {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = join(home, '.odysseus', name);
      const parsed = parseConfigFile(candidate, read);
      if (Object.keys(parsed.values).length > 0) {
        filePath = candidate;
        fileValues = parsed.values;
        warnings.push(...parsed.warnings);
        break;
      }
    }
  }

  // authTokenFile: flag wins over env, and the resolved token is folded into
  // the highest layer that requested it. Reading from a file keeps the secret
  // out of process listings and shell history.
  const authTokenFile = flags.authTokenFile ?? envLayer.authTokenFile;
  if (authTokenFile) {
    try {
      const token = read(authTokenFile).trim();
      if (token) {
        const target = flags.authTokenFile ? flags.values : envLayer.values;
        target.controlPlane = {
          ...(target.controlPlane ?? ({} as NonNullable<GatewayOptions['controlPlane']>)),
          authToken: token,
        } as NonNullable<GatewayOptions['controlPlane']>;
      } else {
        warnings.push(`Auth token file ${authTokenFile} is empty`);
      }
    } catch (err) {
      throw new Error(`Cannot read auth token file ${authTokenFile}: ${(err as Error).message}`);
    }
  }

  const layers: ConfigLayer[] = [
    { name: 'defaults', values: defaults, source: 'built-in' },
    {
      name: 'pairing',
      values: pairingValues,
      source: pairing ? pairingRecordPath(home) : '(not paired)',
    },
    { name: 'file', values: fileValues, source: filePath ?? '(none)' },
    { name: 'env', values: envLayer.values, source: 'environment' },
    { name: 'flags', values: flags.values, source: 'command line' },
  ];

  // mergeGatewayOptions applies later layers over earlier ones and validates
  // the result, so precedence is just the order of this array.
  const options = mergeGatewayOptions(...layers.map((layer) => layer.values));

  return {
    options,
    layers,
    provenance: computeProvenance(layers),
    warnings,
    directives: flags.directives,
  };
}

/** Which layer supplied each leaf value. Later layers overwrite earlier ones. */
function computeProvenance(layers: ConfigLayer[]): Record<string, ConfigLayerName> {
  const provenance: Record<string, ConfigLayerName> = {};
  for (const layer of layers) {
    for (const path of leafPaths(layer.values)) {
      provenance[path] = layer.name;
    }
  }
  return provenance;
}

function leafPaths(value: unknown, prefix = ''): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== 'object' || Array.isArray(value)) return prefix ? [prefix] : [];
  const paths: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child === undefined) continue;
    paths.push(...leafPaths(child, prefix ? `${prefix}.${key}` : key));
  }
  return paths;
}

// --------------------------------------------------------------- reporting

const SECRET_KEY_PATTERN = /token|secret|password|key/i;

/**
 * A copy with secret-looking values masked.
 *
 * `--print-config` exists to be pasted into a bug report, so it must never be
 * the reason a token leaks. Keys are matched by name rather than by an
 * allowlist so a newly added secret is redacted by default.
 */
export function redactConfig(value: unknown, key = ''): unknown {
  if (SECRET_KEY_PATTERN.test(key) && typeof value === 'string' && value.length > 0) {
    return `***redacted(${value.length} chars)***`;
  }
  if (Array.isArray(value)) return value.map((entry) => redactConfig(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactConfig(v, k)]),
    );
  }
  return value;
}

/** Human-readable resolved configuration, with the winning layer per value. */
export function formatResolvedConfig(resolved: ResolvedConfig): string {
  const lines: string[] = [];
  lines.push('Resolved gateway configuration');
  lines.push('  precedence: flags > env > file > pairing > defaults');
  for (const layer of resolved.layers) {
    lines.push(`  layer ${layer.name.padEnd(9)} ${layer.source}`);
  }
  lines.push('');
  lines.push(JSON.stringify(redactConfig(resolved.options), null, 2));
  lines.push('');
  lines.push('Value provenance:');
  for (const [path, layer] of Object.entries(resolved.provenance).sort()) {
    lines.push(`  ${path.padEnd(34)} ${layer}`);
  }
  if (resolved.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const warning of resolved.warnings) lines.push(`  - ${warning}`);
  }
  return lines.join('\n');
}

// ----------------------------------------------------------------- helpers

function isLogLevel(value: unknown): value is NonNullable<GatewayOptions['logLevel']> {
  return (
    value === 'error' ||
    value === 'warn' ||
    value === 'info' ||
    value === 'debug' ||
    value === 'trace'
  );
}

function toPositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
