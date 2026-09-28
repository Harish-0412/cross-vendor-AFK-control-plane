import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentAdapter } from '@odysseus/protocol';
import { describe, expect, test } from 'vitest';

import * as acp from '../../adapters/acp/src/index';
import { discoverAdapters, findMissingAdapterMethods } from '../src/runtime/adapter-manifest';
import { findCapabilityViolations, requirementsForSession } from '../src/runtime/capabilities';

const adaptersRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'adapters');

/**
 * The ACP presets are found by the same discovery every adapter uses. (The
 * module is imported directly: vitest cannot import a file:// URL with spaces
 * in it on Windows, which this checkout's path has; plain Node can.)
 */
describe('ACP adapters', () => {
  test.each(['claude-acp', 'codex-acp', 'gemini-acp', 'opencode-acp'])(
    '%s is discovered, satisfies the contract and can take approval-gated sessions',
    async (id) => {
      const { adapters, errors } = await discoverAdapters({
        workspaceRoots: [adaptersRoot],
        userRoot: join(adaptersRoot, '__none__'),
      });
      expect(errors).toEqual([]);
      const discovered = adapters.find((item) => item.manifest.id === id);
      expect(discovered?.manifest.entry).toBe('../acp/src/index.ts');

      const Exported = (acp as Record<string, unknown>)[discovered!.manifest.export] as new () => AgentAdapter;
      const adapter = new Exported();
      expect(findMissingAdapterMethods(adapter)).toEqual([]);
      expect(adapter.metadata().id).toBe(id);
      // Sessions where a person approves each action are refused for adapters
      // that cannot intercept; ACP adapters can take them.
      expect(
        findCapabilityViolations(
          adapter.metadata().capabilities,
          requirementsForSession({ projectRoot: '/p', adapter: id, approvalMode: 'ask' }),
        ),
      ).toEqual([]);
    },
  );
});
