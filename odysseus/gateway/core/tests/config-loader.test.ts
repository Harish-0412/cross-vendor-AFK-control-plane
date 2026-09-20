import { describe, test, expect } from 'vitest';

import {
  formatResolvedConfig,
  loadGatewayConfig,
  redactConfig,
} from '../src/runtime/config-loader';

const HOME = '/home/tester';
const CWD = '/work/project';
const CONFIG_PATH = `${HOME}/.odysseus/config.yaml`;

/** A fake filesystem; anything not present raises ENOENT like readFileSync. */
function fakeFs(files: Record<string, string>) {
  return (path: string): string => {
    // path.resolve() on Windows turns "/work/project" into "C:\work\project",
    // so the fake filesystem normalises separators and drops any drive letter
    // to keep these tests platform-independent.
    const normalized = path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
    const content = files[normalized];
    if (content === undefined) {
      const err = new Error(`ENOENT: no such file or directory, open '${path}'`) as
        NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return content;
  };
}

function load(options: {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  files?: Record<string, string>;
}) {
  return loadGatewayConfig({
    argv: options.argv ?? [],
    env: options.env ?? {},
    cwd: CWD,
    home: HOME,
    readFile: fakeFs(options.files ?? {}),
  });
}

describe('config precedence: flags > env > file > defaults', () => {
  test('defaults apply when nothing else is set', () => {
    const resolved = load({});
    expect(resolved.options.controlPlane?.url).toBe('ws://localhost:4000/ws/tunnel');
    expect(resolved.options.projectRoots).toEqual([CWD]);
    expect(resolved.provenance['controlPlane.url']).toBe('defaults');
  });

  test('config file overrides defaults', () => {
    const resolved = load({
      files: { [CONFIG_PATH]: 'controlPlane:\n  url: ws://file.example:4000/ws/tunnel\n' },
    });
    expect(resolved.options.controlPlane?.url).toBe('ws://file.example:4000/ws/tunnel');
    expect(resolved.provenance['controlPlane.url']).toBe('file');
  });

  test('environment overrides the config file', () => {
    const resolved = load({
      files: { [CONFIG_PATH]: 'controlPlane:\n  url: ws://file.example:4000/ws/tunnel\n' },
      env: { ODYSSEUS_CONTROL_PLANE_URL: 'ws://env.example:4000/ws/tunnel' },
    });
    expect(resolved.options.controlPlane?.url).toBe('ws://env.example:4000/ws/tunnel');
    expect(resolved.provenance['controlPlane.url']).toBe('env');
  });

  test('a CLI flag beats everything', () => {
    const resolved = load({
      files: { [CONFIG_PATH]: 'controlPlane:\n  url: ws://file.example:4000/ws/tunnel\n' },
      env: { ODYSSEUS_CONTROL_PLANE_URL: 'ws://env.example:4000/ws/tunnel' },
      argv: ['--control-plane-url', 'ws://flag.example:4000/ws/tunnel'],
    });
    expect(resolved.options.controlPlane?.url).toBe('ws://flag.example:4000/ws/tunnel');
    expect(resolved.provenance['controlPlane.url']).toBe('flags');
  });

  test('all four layers resolve simultaneously, each winning its own key', () => {
    const resolved = load({
      files: {
        [CONFIG_PATH]: [
          'controlPlane:',
          '  url: ws://file.example:4000/ws/tunnel',
          '  heartbeatIntervalMs: 9000',
          'logLevel: debug',
        ].join('\n'),
      },
      env: { ODYSSEUS_LOG_LEVEL: 'warn' },
      argv: ['--control-plane-url', 'ws://flag.example:4000/ws/tunnel'],
    });

    // flag wins the URL, env wins the log level, file wins the heartbeat,
    // defaults win the project roots.
    expect(resolved.options.controlPlane?.url).toBe('ws://flag.example:4000/ws/tunnel');
    expect(resolved.options.logLevel).toBe('warn');
    expect(resolved.options.controlPlane?.heartbeatIntervalMs).toBe(9000);
    expect(resolved.options.projectRoots).toEqual([CWD]);

    expect(resolved.provenance).toMatchObject({
      'controlPlane.url': 'flags',
      logLevel: 'env',
      'controlPlane.heartbeatIntervalMs': 'file',
      projectRoots: 'defaults',
    });
  });

  test('the legacy CONTROL_PLANE_WS variable still works but loses to the prefixed one', () => {
    const legacyOnly = load({ env: { CONTROL_PLANE_WS: 'ws://legacy.example:4000/ws/tunnel' } });
    expect(legacyOnly.options.controlPlane?.url).toBe('ws://legacy.example:4000/ws/tunnel');

    const both = load({
      env: {
        CONTROL_PLANE_WS: 'ws://legacy.example:4000/ws/tunnel',
        ODYSSEUS_CONTROL_PLANE_URL: 'ws://new.example:4000/ws/tunnel',
      },
    });
    expect(both.options.controlPlane?.url).toBe('ws://new.example:4000/ws/tunnel');
  });
});

describe('config file handling', () => {
  test('JSON config files are supported', () => {
    const resolved = load({
      files: {
        '/work/project/custom.json': JSON.stringify({
          controlPlane: { url: 'ws://json.example:4000/ws/tunnel' },
        }),
      },
      argv: ['--config', 'custom.json'],
    });
    expect(resolved.options.controlPlane?.url).toBe('ws://json.example:4000/ws/tunnel');
  });

  test('an explicitly requested config file that does not exist is an error', () => {
    expect(() => load({ argv: ['--config', '/nope/missing.yaml'] })).toThrow(
      /Config file not found/,
    );
  });

  test('a missing config file at the default location is not an error', () => {
    expect(() => load({})).not.toThrow();
  });

  test('malformed YAML fails loudly rather than silently falling back', () => {
    expect(() =>
      load({ files: { [CONFIG_PATH]: 'controlPlane:\n  url: "unterminated' } }),
    ).toThrow(/not valid/);
  });

  test('an invalid control plane URL is rejected by schema validation', () => {
    expect(() => load({ argv: ['--control-plane-url', 'http://not-a-websocket'] })).toThrow(
      /ws:\/\/ or wss:\/\//,
    );
  });
});

describe('authTokenFile', () => {
  test('reads the token from a file and keeps it out of argv', () => {
    const resolved = load({
      argv: ['--auth-token-file', '/secrets/token'],
      files: { '/secrets/token': '  super-secret-token\n' },
    });
    expect(resolved.options.controlPlane?.authToken).toBe('super-secret-token');
  });

  test('env-provided token file works too', () => {
    const resolved = load({
      env: { ODYSSEUS_AUTH_TOKEN_FILE: '/secrets/token' },
      files: { '/secrets/token': 'from-env-file' },
    });
    expect(resolved.options.controlPlane?.authToken).toBe('from-env-file');
  });

  test('a flag-provided token file beats an env-provided literal token', () => {
    const resolved = load({
      argv: ['--auth-token-file', '/secrets/token'],
      env: { ODYSSEUS_AUTH_TOKEN: 'env-literal' },
      files: { '/secrets/token': 'file-token' },
    });
    expect(resolved.options.controlPlane?.authToken).toBe('file-token');
  });

  test('an unreadable token file is a hard error, not a silent fallback', () => {
    expect(() => load({ argv: ['--auth-token-file', '/secrets/absent'] })).toThrow(
      /Cannot read auth token file/,
    );
  });
});

describe('flag parsing', () => {
  test('supports --flag=value as well as --flag value', () => {
    const resolved = load({ argv: ['--control-plane-url=ws://eq.example:4000/ws/tunnel'] });
    expect(resolved.options.controlPlane?.url).toBe('ws://eq.example:4000/ws/tunnel');
  });

  test('repeatable flags accumulate', () => {
    const resolved = load({
      argv: ['--project-root', '/a', '--project-root', '/b', '--adapter', 'mock'],
    });
    expect(resolved.options.projectRoots).toEqual(['/a', '/b']);
    expect(resolved.options.allowedAdapters).toEqual(['mock']);
  });

  test('unknown flags produce a warning rather than a crash', () => {
    const resolved = load({ argv: ['--not-a-real-flag', 'x'] });
    expect(resolved.warnings.some((w) => w.includes('--not-a-real-flag'))).toBe(true);
  });

  test('directives are surfaced separately from configuration', () => {
    const resolved = load({ argv: ['--print-config'] });
    expect(resolved.directives.printConfig).toBe(true);
  });
});

describe('redaction', () => {
  test('masks secret-looking keys by name', () => {
    const redacted = redactConfig({
      controlPlane: { url: 'wss://x', authToken: 'abcdef123456' },
      nested: { apiKey: 'zzz', password: 'pw', safe: 'visible' },
    }) as Record<string, Record<string, unknown>>;

    expect(redacted.controlPlane?.url).toBe('wss://x');
    expect(String(redacted.controlPlane?.authToken)).toMatch(/redacted/);
    expect(String(redacted.nested?.apiKey)).toMatch(/redacted/);
    expect(String(redacted.nested?.password)).toMatch(/redacted/);
    expect(redacted.nested?.safe).toBe('visible');
  });

  test('--print-config output never contains the token', () => {
    const resolved = load({
      argv: ['--auth-token-file', '/secrets/token', '--print-config'],
      files: { '/secrets/token': 'do-not-leak-me' },
    });
    const output = formatResolvedConfig(resolved);

    expect(output).not.toContain('do-not-leak-me');
    expect(output).toContain('redacted');
    expect(output).toContain('precedence: flags > env > file > defaults');
  });
});
