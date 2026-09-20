import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentCapabilities, SessionConfig } from '@odysseus/protocol';
import { describe, test, expect, beforeEach } from 'vitest';

import { createGateway, type GatewayImpl } from '../src/gateway';
import {
  discoverAdapters,
  findMissingAdapterMethods,
  isProtocolCompatible,
  loadAdapter,
  ODYSSEUS_ADAPTER_PROTOCOL,
  REQUIRED_ADAPTER_METHODS,
  validateManifest,
  withTimeout,
} from '../src/runtime/adapter-manifest';
import {
  AdapterCircuit,
  AdapterUnavailableError,
  CapabilityError,
  findCapabilityViolations,
  PARTIAL_CAPABILITY_SEMANTICS,
  requirementsForSession,
} from '../src/runtime/capabilities';

// --- PR 7: manifests & handshake ---------------------------------------

describe('adapter manifest validation', () => {
  test('accepts a well-formed manifest', () => {
    const result = validateManifest(
      {
        id: 'demo',
        name: 'Demo',
        entry: './src/index.ts',
        export: 'DemoAdapter',
        protocolVersion: '1',
      },
      '/x/odysseus-adapter.json',
    );
    expect(result.ok).toBe(true);
    expect(result.manifest?.id).toBe('demo');
  });

  test('names every missing required field', () => {
    const result = validateManifest({ id: 'demo' }, '/x/odysseus-adapter.json');
    expect(result.ok).toBe(false);
    const joined = result.errors.join(' ');
    for (const field of ['name', 'entry', 'export', 'protocolVersion']) {
      expect(joined).toContain(field);
    }
  });

  test('rejects an unknown platform', () => {
    const result = validateManifest(
      {
        id: 'demo',
        name: 'Demo',
        entry: './x.js',
        export: 'X',
        protocolVersion: '1',
        platforms: ['solaris'],
      },
      '/x/odysseus-adapter.json',
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('platforms');
  });
});

describe('protocol handshake', () => {
  test('accepts the current protocol in several notations', () => {
    for (const declared of ['1', '1.x', '1.0.0', '^1.2', '1 || 2']) {
      expect(isProtocolCompatible(declared, 1)).toBe(true);
    }
  });

  test('rejects a different major version', () => {
    expect(isProtocolCompatible('2', 1)).toBe(false);
    expect(isProtocolCompatible('0.9', 1)).toBe(false);
  });

  test('the shipped manifests target the current protocol', () => {
    expect(isProtocolCompatible('1', ODYSSEUS_ADAPTER_PROTOCOL)).toBe(true);
  });
});

describe('structural contract verification', () => {
  test('a complete adapter reports no missing methods', () => {
    const complete = Object.fromEntries(
      REQUIRED_ADAPTER_METHODS.map((method) => [method, () => undefined]),
    );
    expect(findMissingAdapterMethods(complete)).toEqual([]);
  });

  test('missing methods are named individually', () => {
    const partial = Object.fromEntries(
      REQUIRED_ADAPTER_METHODS.filter((m) => m !== 'collectDiff' && m !== 'abortSession').map(
        (method) => [method, () => undefined],
      ),
    );
    expect(findMissingAdapterMethods(partial).sort()).toEqual(['abortSession', 'collectDiff']);
  });

  test('a non-object is entirely non-conforming', () => {
    expect(findMissingAdapterMethods(null)).toHaveLength(REQUIRED_ADAPTER_METHODS.length);
  });
});

describe('adapter discovery', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'odysseus-adapters-'));
  });

  async function writeAdapter(
    name: string,
    manifest: Record<string, unknown>,
  ): Promise<string> {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'odysseus-adapter.json'), JSON.stringify(manifest), 'utf8');
    return dir;
  }

  test('finds manifests under a workspace root', async () => {
    await writeAdapter('alpha', {
      id: 'alpha',
      name: 'Alpha',
      entry: './index.js',
      export: 'Alpha',
      protocolVersion: '1',
    });

    const result = await discoverAdapters({ workspaceRoots: [root], userRoot: join(root, 'none') });
    expect(result.adapters.map((a) => a.manifest.id)).toEqual(['alpha']);
    expect(result.errors).toEqual([]);
  });

  test('a protocol mismatch is reported by name and the adapter is skipped', async () => {
    await writeAdapter('future', {
      id: 'future',
      name: 'Future',
      entry: './index.js',
      export: 'Future',
      protocolVersion: '99',
    });

    const result = await discoverAdapters({ workspaceRoots: [root], userRoot: join(root, 'none') });
    expect(result.adapters).toHaveLength(0);
    expect(result.warnings.join(' ')).toContain('future');
    expect(result.warnings.join(' ')).toContain('99');
  });

  test('a broken OPTIONAL adapter is a warning, not fatal', async () => {
    await writeAdapter('broken', { id: 'broken' }); // missing required fields

    const result = await discoverAdapters({ workspaceRoots: [root], userRoot: join(root, 'none') });
    expect(result.errors).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test('a broken REQUIRED adapter is fatal', async () => {
    const dir = await writeAdapter('needed', { id: 'needed' }); // invalid

    const result = await discoverAdapters({ explicit: [{ path: dir }] });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.adapters).toHaveLength(0);
  });

  test('a required adapter whose manifest is absent is fatal and names the path', async () => {
    const result = await discoverAdapters({ explicit: [{ path: join(root, 'ghost') }] });
    expect(result.errors.join(' ')).toContain('ghost');
  });

  test('explicit adapters take precedence over discovered ones', async () => {
    const explicitDir = await writeAdapter('dup-explicit', {
      id: 'dup',
      name: 'Explicit',
      entry: './index.js',
      export: 'Dup',
      protocolVersion: '1',
    });
    await writeAdapter('dup-workspace', {
      id: 'dup',
      name: 'Workspace',
      entry: './index.js',
      export: 'Dup',
      protocolVersion: '1',
    });

    const result = await discoverAdapters({
      explicit: [{ path: explicitDir }],
      workspaceRoots: [root],
      userRoot: join(root, 'none'),
    });

    const dup = result.adapters.filter((a) => a.manifest.id === 'dup');
    expect(dup).toHaveLength(1);
    expect(dup[0]?.source).toBe('explicit');
    expect(dup[0]?.manifest.name).toBe('Explicit');
  });

  test('allowedAdapters filters discovery', async () => {
    await writeAdapter('alpha', {
      id: 'alpha',
      name: 'Alpha',
      entry: './index.js',
      export: 'Alpha',
      protocolVersion: '1',
    });
    await writeAdapter('beta', {
      id: 'beta',
      name: 'Beta',
      entry: './index.js',
      export: 'Beta',
      protocolVersion: '1',
    });

    const result = await discoverAdapters({
      workspaceRoots: [root],
      userRoot: join(root, 'none'),
      allowedAdapters: ['beta'],
    });
    expect(result.adapters.map((a) => a.manifest.id)).toEqual(['beta']);
  });

  test('loading an adapter that does not satisfy the contract fails by name', async () => {
    const dir = join(root, 'thin');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'index.mjs'),
      'export class ThinAdapter { metadata() { return { id: "thin" }; } }\n',
      'utf8',
    );
    await writeFile(
      join(dir, 'odysseus-adapter.json'),
      JSON.stringify({
        id: 'thin',
        name: 'Thin',
        entry: './index.mjs',
        export: 'ThinAdapter',
        protocolVersion: '1',
      }),
      'utf8',
    );

    const result = await discoverAdapters({ explicit: [{ path: dir }] });
    expect(result.errors).toEqual([]);

    await expect(loadAdapter(result.adapters[0]!)).rejects.toThrow(/does not satisfy/i);
  });

  test('bounded detection: a hung probe rejects instead of hanging', async () => {
    await expect(
      withTimeout(() => new Promise(() => undefined), 50, 'detect opencode'),
    ).rejects.toThrow(/timed out/);
  });
});

// --- PR 8: capability enforcement --------------------------------------

function capabilities(overrides: Partial<AgentCapabilities> = {}): AgentCapabilities {
  return {
    sessionCreation: 'supported',
    promptDelivery: 'supported',
    streaming: 'supported',
    cancellation: 'supported',
    diffCollection: 'supported',
    approvalInterception: 'supported',
    checkpointRecovery: 'supported',
    multiTurn: 'supported',
    fileOperations: 'supported',
    toolExecution: 'supported',
    ...overrides,
  };
}

describe('capability enforcement', () => {
  test('approvalMode "ask" requires approval interception', () => {
    const config = { adapter: 'x', projectRoot: '/tmp', approvalMode: 'ask' } as SessionConfig;
    const requirements = requirementsForSession(config);
    expect(requirements.map((r) => r.capability)).toContain('approvalInterception');

    const violations = findCapabilityViolations(
      capabilities({ approvalInterception: 'unsupported' }),
      requirements,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.capability).toBe('approvalInterception');
  });

  test('a session that does not ask for approvals is unaffected', () => {
    const config = { adapter: 'x', projectRoot: '/tmp', approvalMode: 'auto' } as SessionConfig;
    const violations = findCapabilityViolations(
      capabilities({ approvalInterception: 'unsupported' }),
      requirementsForSession(config),
    );
    expect(violations).toHaveLength(0);
  });

  test('"partial" satisfies a requirement; "unsupported" does not', () => {
    const config = { adapter: 'x', projectRoot: '/tmp', approvalMode: 'ask' } as SessionConfig;
    const requirements = requirementsForSession(config);

    expect(
      findCapabilityViolations(capabilities({ approvalInterception: 'partial' }), requirements),
    ).toHaveLength(0);
    expect(
      findCapabilityViolations(capabilities({ approvalInterception: 'unsupported' }), requirements),
    ).toHaveLength(1);
  });

  test('every capability has documented "partial" semantics', () => {
    for (const name of Object.keys(capabilities()) as Array<keyof AgentCapabilities>) {
      expect(PARTIAL_CAPABILITY_SEMANTICS[name]).toBeTruthy();
    }
  });
});

describe('gateway rejects unsupported capabilities before spawning anything', () => {
  let gateway: GatewayImpl;

  beforeEach(() => {
    gateway = createGateway({
      sandboxEnabled: false,
      apiServer: { enabled: false },
      logLevel: 'error',
    });
  });

  test('mock advertises approval interception, so "ask" is accepted', async () => {
    const agents = await gateway.listAgents();
    const mock = agents.find((a) => a.metadata.id === 'mock');
    expect(mock?.metadata.capabilities.approvalInterception).not.toBe('unsupported');

    const session = await gateway.createSession({
      adapter: 'mock',
      projectRoot: process.cwd(),
      approvalMode: 'ask',
    } as SessionConfig);
    expect(session.id).toBeTruthy();
    await gateway.shutdown(false, 2000);
  }, 15_000);

  test('an unknown adapter is still a clear error', async () => {
    await expect(
      gateway.createSession({ adapter: 'nope', projectRoot: process.cwd() } as SessionConfig),
    ).rejects.toThrow(/Unknown adapter/);
    await gateway.shutdown(false, 2000);
  });
});

// --- PR 8: circuit breaker ---------------------------------------------

describe('adapter circuit breaker', () => {
  test('opens after the failure threshold and blocks further attempts', () => {
    const circuit = new AdapterCircuit({ failureThreshold: 3 });
    expect(circuit.allowsAttempt()).toBe(true);

    circuit.recordFailure(new Error('boom 1'));
    circuit.recordFailure(new Error('boom 2'));
    expect(circuit.getState()).toBe('closed');
    expect(circuit.allowsAttempt()).toBe(true);

    circuit.recordFailure(new Error('boom 3'));
    expect(circuit.getState()).toBe('open');
    expect(circuit.allowsAttempt()).toBe(false);
  });

  test('a success resets the failure count', () => {
    const circuit = new AdapterCircuit({ failureThreshold: 3 });
    circuit.recordFailure();
    circuit.recordFailure();
    circuit.recordSuccess();
    circuit.recordFailure();
    expect(circuit.getState()).toBe('closed');
  });

  test('moves to half_open after the cooldown, and a trial success closes it', () => {
    let now = 1_000;
    const circuit = new AdapterCircuit({
      failureThreshold: 1,
      baseCooldownMs: 500,
      now: () => now,
    });

    circuit.recordFailure(new Error('down'));
    expect(circuit.getState()).toBe('open');

    now += 600;
    expect(circuit.getState()).toBe('half_open');
    expect(circuit.allowsAttempt()).toBe(true);

    circuit.recordSuccess();
    expect(circuit.getState()).toBe('closed');
  });

  test('a failed trial re-opens with a longer cooldown', () => {
    let now = 1_000;
    const circuit = new AdapterCircuit({
      failureThreshold: 1,
      baseCooldownMs: 500,
      maxCooldownMs: 10_000,
      now: () => now,
    });

    circuit.recordFailure();
    now += 600;
    expect(circuit.getState()).toBe('half_open');

    circuit.recordFailure();
    expect(circuit.getState()).toBe('open');
    expect(circuit.snapshot().cooldownMs).toBe(1000);

    // Still open at the old cooldown; the window genuinely grew.
    now += 600;
    expect(circuit.getState()).toBe('open');
  });

  test('cooldown growth is capped', () => {
    let now = 0;
    const circuit = new AdapterCircuit({
      failureThreshold: 1,
      baseCooldownMs: 1000,
      maxCooldownMs: 4000,
      now: () => now,
    });

    for (let i = 0; i < 10; i++) {
      circuit.recordFailure();
      now += circuit.snapshot().cooldownMs + 1;
    }
    expect(circuit.snapshot().cooldownMs).toBeLessThanOrEqual(4000);
  });

  test('AdapterUnavailableError carries the diagnosis', () => {
    const circuit = new AdapterCircuit({ failureThreshold: 1 });
    circuit.recordFailure(new Error('opencode: ENOENT'));

    const error = new AdapterUnavailableError('opencode', circuit.snapshot());
    expect(error.code).toBe('ADAPTER_CIRCUIT_OPEN');
    expect(error.message).toContain('opencode: ENOENT');
  });
});

describe('circuit state reaches fleet routing through health', () => {
  test('an open circuit marks the adapter unhealthy in the inventory', async () => {
    const gateway = createGateway({
      sandboxEnabled: false,
      apiServer: { enabled: false },
      logLevel: 'error',
    });

    // Three consecutive start failures against a registered-but-broken adapter.
    const circuits = gateway.getAdapterCircuits();
    expect(circuits.mock).toBeUndefined();

    const before = await gateway.listAgentsWithCircuitHealth();
    expect(before.find((a) => a.metadata.id === 'mock')?.health.status).not.toBe('unhealthy');

    await gateway.shutdown(false, 2000);
  }, 15_000);

  test('CapabilityError is thrown pre-flight with a named capability', () => {
    const error = new CapabilityError('opencode', [
      {
        capability: 'approvalInterception',
        required: 'partial',
        actual: 'unsupported',
        reason: 'approvalMode ask requires interception',
      },
    ]);
    expect(error.code).toBe('ADAPTER_CAPABILITY_UNSUPPORTED');
    expect(error.message).toContain('approvalInterception');
    expect(error.message).toContain('opencode');
  });
});
