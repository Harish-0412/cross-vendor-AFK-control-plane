import { defineConfig } from 'vitest/config';
import { workspaceAliases, sharedTestConfig } from '../../../vitest.shared';

export default defineConfig({
  test: { ...sharedTestConfig },
  resolve: { alias: workspaceAliases },
});
