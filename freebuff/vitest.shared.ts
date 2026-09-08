import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Single source of truth for how tests resolve workspace packages.
 *
 * Builds resolve `@freebuff/*` through each package's `exports`/`types` field
 * to its built `dist`. Tests deliberately do not: they alias straight to
 * TypeScript source so the suite runs on a clean checkout with no build step,
 * and so a failure points at a source line rather than a compiled artifact.
 *
 * Every package's vitest.config.ts pulls its aliases from here — previously
 * three packages each resolved workspace imports a different way, which let
 * them drift apart silently.
 */
const workspaceRoot = path.dirname(fileURLToPath(import.meta.url));

const packageSources: Record<string, string> = {
  '@freebuff/protocol': 'packages/protocol/src/index.ts',
  '@freebuff/schemas': 'packages/schemas/src/index.ts',
  '@freebuff/config': 'packages/config/src/index.ts',
  '@freebuff/mock-adapter': 'gateway/adapters/mock/src/index.ts',
  '@freebuff/opencode-adapter': 'gateway/adapters/opencode/src/index.ts',
  '@freebuff/antigravity-adapter': 'gateway/adapters/antigravity/src/index.ts',
  '@freebuff/checkpoint': 'gateway/checkpoint/src/index.ts',
  '@freebuff/health': 'gateway/health/src/index.ts',
  '@freebuff/sandbox': 'gateway/sandbox/src/index.ts',
  '@freebuff/tunnel': 'gateway/tunnel/src/index.ts',
  '@freebuff/identity': 'gateway/identity/src/index.ts',
  '@freebuff/pairing': 'gateway/pairing/src/index.ts',
  '@freebuff/certificate': 'gateway/certificate/src/index.ts',
  '@freebuff/reconciliation': 'gateway/reconciliation/src/index.ts',
  '@freebuff/gateway-core': 'gateway/core/src/index.ts',
  '@freebuff/control-plane': 'control-plane/src/index.ts',
  '@freebuff/policy-engine': 'packages/policy-engine/src/index.ts',
  '@freebuff/attention-engine': 'packages/attention-engine/src/index.ts',
  '@freebuff/gateway-policy': 'gateway/policy/src/index.ts',
  '@freebuff/redaction': 'gateway/redaction/src/index.ts',
};

export const workspaceAliases: Record<string, string> = Object.fromEntries(
  Object.entries(packageSources).map(([name, relativePath]) => [
    name,
    path.join(workspaceRoot, relativePath).replace(/\\/g, '/'),
  ]),
);

/** Shared `test` block. Packages spread this and override only what differs. */
export const sharedTestConfig = {
  environment: 'node' as const,
  globals: true,
  include: ['src/**/*.{test,spec}.ts', 'tests/**/*.{test,spec}.ts'],
  coverage: {
    provider: 'v8' as const,
    reporter: ['text', 'json', 'html'],
    include: ['src/**/*.ts'],
    exclude: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'src/**/index.ts'],
  },
  testTimeout: 30_000,
  hookTimeout: 30_000,
};
