import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const freebuffRoot = path.resolve(__dirname, '../..');

function alias(pkg: string) {
  return path.join(freebuffRoot, pkg).replace(/\\/g, '/');
}

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.{test,spec}.ts', 'tests/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/index.ts']
    },
    testTimeout: 30000
  },
  resolve: {
    alias: {
      '@freebuff/protocol': alias('packages/protocol/src/index.ts'),
      '@freebuff/schemas': alias('packages/schemas/src/index.ts'),
      '@freebuff/config': alias('packages/config/src/index.ts')
    }
  }
});
