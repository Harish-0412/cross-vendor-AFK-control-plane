/**
 * Adapter discovery and loading.
 *
 * Two patterns are borrowed here.
 *
 * From **hashicorp/go-plugin**: a handshake. A plugin whose protocol version
 * does not match is refused at load time with a specific message, rather than
 * being allowed to run and exploding later with a TypeError mid-session. The
 * `AgentAdapter` interface has fourteen required methods; adding a fifteenth
 * would silently break every out-of-tree adapter without this check.
 *
 * From **Packer**: a manifest plus two-phase discovery. Explicitly required
 * adapters are loaded first and take precedence, and a failure to load one is
 * fatal; the rest are discovered optimistically, and a failure there is a
 * warning. Conflating those two cases is what the previous hardcoded
 * try/catch did — a broken adapter looked exactly like an absent one.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { AgentAdapter, Platform } from '@odysseus/protocol';

import type { Logger } from './logger';
import { createNullLogger } from './logger';

/**
 * The adapter contract version this gateway speaks. Bump it when
 * `AgentAdapter` changes in a way existing adapters cannot satisfy.
 */
export const ODYSSEUS_ADAPTER_PROTOCOL = 1;

export const MANIFEST_FILENAME = 'odysseus-adapter.json';

/** Every method an adapter must provide. Optional ones are excluded. */
export const REQUIRED_ADAPTER_METHODS = [
  'metadata',
  'installOrDetect',
  'validateEnvironment',
  'startSession',
  'sendMessage',
  'sendInput',
  'streamEvents',
  'requestApproval',
  'submitApprovalDecision',
  'abortSession',
  'collectDiff',
  'getState',
  'getSession',
  'cleanupSession',
] as const;

export interface AdapterManifest {
  id: string;
  name: string;
  /** Module to import, relative to the manifest's directory. */
  entry: string;
  /** Named export holding the adapter class or factory. */
  export: string;
  /** Protocol version or range this adapter was written against, e.g. "1". */
  protocolVersion: string;
  platforms?: Platform[] | undefined;
  detect?:
    | {
        command?: string;
        versionFlag?: string;
        timeoutMs?: number;
      }
    | undefined;
  description?: string | undefined;
}

export type AdapterSource = 'explicit' | 'workspace' | 'user';

export interface DiscoveredAdapter {
  manifest: AdapterManifest;
  manifestPath: string;
  source: AdapterSource;
  /** Explicitly configured adapters are required: failing to load one is fatal. */
  required: boolean;
}

export interface ManifestValidation {
  ok: boolean;
  manifest?: AdapterManifest;
  errors: string[];
}

// ------------------------------------------------------------- validation

export function validateManifest(raw: unknown, manifestPath: string): ManifestValidation {
  const errors: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [`${manifestPath}: manifest must be a JSON object`] };
  }

  const value = raw as Record<string, unknown>;
  const requireString = (field: string): string | undefined => {
    const item = value[field];
    if (typeof item !== 'string' || item.length === 0) {
      errors.push(`${manifestPath}: "${field}" is required and must be a non-empty string`);
      return undefined;
    }
    return item;
  };

  const id = requireString('id');
  const name = requireString('name');
  const entry = requireString('entry');
  const exported = requireString('export');
  const protocolVersion = requireString('protocolVersion');

  if (value.platforms !== undefined) {
    if (
      !Array.isArray(value.platforms) ||
      value.platforms.some((p) => p !== 'linux' && p !== 'darwin' && p !== 'win32')
    ) {
      errors.push(`${manifestPath}: "platforms" must contain only linux, darwin or win32`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const manifest: AdapterManifest = {
    id: id!,
    name: name!,
    entry: entry!,
    export: exported!,
    protocolVersion: protocolVersion!,
    ...(value.platforms ? { platforms: value.platforms as Platform[] } : {}),
    ...(value.detect ? { detect: value.detect as AdapterManifest['detect'] } : {}),
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
  };

  return { ok: true, manifest, errors: [] };
}

/**
 * Whether this gateway can run an adapter built against `declared`.
 *
 * Accepts an exact major ("1"), a wildcard ("1.x") or a range list ("1 || 2").
 * Only the major version is compared: the contract is the interface shape, and
 * that is what a major bump represents.
 */
export function isProtocolCompatible(
  declared: string,
  current = ODYSSEUS_ADAPTER_PROTOCOL,
): boolean {
  const majors = declared
    .split('||')
    .map((part) => part.trim())
    .map((part) => Number.parseInt(part.replace(/^[\^~>=<]+/, '').split('.')[0] ?? '', 10))
    .filter((n) => Number.isFinite(n));
  return majors.includes(current);
}

/**
 * Structural check that an instance really implements `AgentAdapter`.
 *
 * TypeScript cannot help here: adapters are loaded at runtime from a path in a
 * manifest. Returns the names of any missing methods.
 */
export function findMissingAdapterMethods(instance: unknown): string[] {
  if (!instance || (typeof instance !== 'object' && typeof instance !== 'function')) {
    return [...REQUIRED_ADAPTER_METHODS];
  }
  const candidate = instance as Record<string, unknown>;
  return REQUIRED_ADAPTER_METHODS.filter((method) => typeof candidate[method] !== 'function');
}

// -------------------------------------------------------------- discovery

export interface DiscoveryOptions {
  /** Adapters named in configuration. These are required. */
  explicit?: Array<{ id?: string; path: string }>;
  /** Workspace roots to scan, e.g. <repo>/gateway/adapters. */
  workspaceRoots?: string[];
  /** User-installed roots, default ~/.odysseus/adapters. */
  userRoot?: string;
  /** Only these adapter ids may be registered. */
  allowedAdapters?: string[];
  logger?: Logger;
}

export interface DiscoveryResult {
  adapters: DiscoveredAdapter[];
  warnings: string[];
  /** Problems with a REQUIRED adapter. Startup should fail on these. */
  errors: string[];
}

async function readManifestAt(
  manifestPath: string,
): Promise<{ manifest?: AdapterManifest; errors: string[] }> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch (err) {
    return { errors: [`${manifestPath}: ${(err as Error).message}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { errors: [`${manifestPath}: invalid JSON (${(err as Error).message})`] };
  }

  const validation = validateManifest(parsed, manifestPath);
  if (!validation.ok || !validation.manifest) return { errors: validation.errors };

  if (!isProtocolCompatible(validation.manifest.protocolVersion)) {
    return {
      errors: [
        `${manifestPath}: adapter "${validation.manifest.id}" declares protocolVersion ` +
          `"${validation.manifest.protocolVersion}" but this gateway speaks ` +
          `${ODYSSEUS_ADAPTER_PROTOCOL}. Upgrade the adapter or the gateway.`,
      ],
    };
  }

  return { manifest: validation.manifest, errors: [] };
}

/** Find `<dir>/*\/odysseus-adapter.json`. */
async function scanRoot(root: string): Promise<string[]> {
  try {
    const info = await stat(root);
    if (!info.isDirectory()) return [];
  } catch {
    return [];
  }

  const found: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const candidate = join(root, entry, MANIFEST_FILENAME);
    try {
      await stat(candidate);
      found.push(candidate);
    } catch {
      /* not an adapter directory */
    }
  }
  return found;
}

export async function discoverAdapters(options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const log = options.logger ?? createNullLogger();
  const adapters: DiscoveredAdapter[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  const admit = (
    manifest: AdapterManifest,
    manifestPath: string,
    source: AdapterSource,
    required: boolean,
  ): void => {
    // Precedence: the first source to claim an id wins, and sources are
    // visited explicit -> workspace -> user.
    if (seen.has(manifest.id)) {
      warnings.push(
        `Adapter "${manifest.id}" at ${manifestPath} ignored; already provided by a higher-precedence source`,
      );
      return;
    }
    if (
      options.allowedAdapters &&
      options.allowedAdapters.length > 0 &&
      !options.allowedAdapters.includes(manifest.id)
    ) {
      log.debug('adapter.excluded', { adapter: manifest.id, reason: 'allowedAdapters' });
      return;
    }
    if (manifest.platforms && !manifest.platforms.includes(process.platform as Platform)) {
      warnings.push(
        `Adapter "${manifest.id}" does not support platform ${process.platform}; skipped`,
      );
      return;
    }
    seen.add(manifest.id);
    adapters.push({ manifest, manifestPath, source, required });
  };

  // Phase 1 — explicitly required adapters.
  for (const entry of options.explicit ?? []) {
    const manifestPath = entry.path.endsWith('.json')
      ? resolve(entry.path)
      : resolve(entry.path, MANIFEST_FILENAME);
    const { manifest, errors: manifestErrors } = await readManifestAt(manifestPath);
    if (!manifest) {
      // Required: this is fatal, not a warning.
      errors.push(...manifestErrors);
      continue;
    }
    if (entry.id && entry.id !== manifest.id) {
      errors.push(
        `${manifestPath}: expected adapter id "${entry.id}" but manifest declares "${manifest.id}"`,
      );
      continue;
    }
    admit(manifest, manifestPath, 'explicit', true);
  }

  // Phase 2 — optimistic discovery.
  const optimisticRoots: Array<{ root: string; source: AdapterSource }> = [
    ...(options.workspaceRoots ?? []).map((root) => ({ root, source: 'workspace' as const })),
    { root: options.userRoot ?? join(homedir(), '.odysseus', 'adapters'), source: 'user' as const },
  ];

  for (const { root, source } of optimisticRoots) {
    for (const manifestPath of await scanRoot(root)) {
      const { manifest, errors: manifestErrors } = await readManifestAt(manifestPath);
      if (!manifest) {
        // Optional: a broken manifest is a warning, but a *named* one.
        warnings.push(...manifestErrors);
        continue;
      }
      admit(manifest, manifestPath, source, false);
    }
  }

  return { adapters, warnings, errors };
}

// ----------------------------------------------------------------- loading

export interface LoadedAdapter {
  adapter: AgentAdapter;
  manifest: AdapterManifest;
}

/**
 * Import and instantiate an adapter, verifying it satisfies the contract.
 *
 * Construction is deferred until this is called, so a machine with several
 * adapters installed does not pay for all of them at boot.
 */
export async function loadAdapter(discovered: DiscoveredAdapter): Promise<LoadedAdapter> {
  const { manifest, manifestPath } = discovered;
  const entryPath = isAbsolute(manifest.entry)
    ? manifest.entry
    : resolve(dirname(manifestPath), manifest.entry);

  let module: Record<string, unknown>;
  try {
    module = (await import(pathToFileURL(entryPath).href)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Adapter "${manifest.id}": cannot import ${entryPath} (${(err as Error).message})`,
    );
  }

  const exported = module[manifest.export];
  if (exported === undefined) {
    throw new Error(
      `Adapter "${manifest.id}": ${entryPath} has no export named "${manifest.export}". ` +
        `Available: ${Object.keys(module).join(', ') || '(none)'}`,
    );
  }

  let instance: unknown;
  try {
    // Supports both a class and a zero-argument factory.
    instance =
      typeof exported === 'function' && /^\s*class\s/.test(exported.toString())
        ? new (exported as new () => unknown)()
        : typeof exported === 'function'
          ? (exported as () => unknown)()
          : exported;
  } catch (err) {
    throw new Error(
      `Adapter "${manifest.id}": constructing "${manifest.export}" threw (${(err as Error).message})`,
    );
  }

  const missing = findMissingAdapterMethods(instance);
  if (missing.length > 0) {
    throw new Error(
      `Adapter "${manifest.id}" does not satisfy the AgentAdapter contract ` +
        `(protocol ${ODYSSEUS_ADAPTER_PROTOCOL}). Missing: ${missing.join(', ')}`,
    );
  }

  const adapter = instance as AgentAdapter;

  // The manifest's id is the identity the rest of the system routes on, so a
  // mismatch with the adapter's own metadata would make routing unreliable.
  let metadataId: string | undefined;
  try {
    metadataId = adapter.metadata().id;
  } catch (err) {
    throw new Error(`Adapter "${manifest.id}": metadata() threw (${(err as Error).message})`);
  }
  if (metadataId !== manifest.id) {
    throw new Error(
      `Adapter id mismatch: manifest says "${manifest.id}" but metadata() reports "${metadataId}"`,
    );
  }

  return { adapter, manifest };
}

/** Run a promise with a hard timeout, so a hung CLI cannot hang startup. */
export async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
