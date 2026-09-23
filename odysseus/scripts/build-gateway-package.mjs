import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist-package');

const commandEntries = {
  gateway: join(root, 'scripts', 'start-gateway.ts'),
  pair: join(root, 'scripts', 'pair.ts'),
  grants: join(root, 'scripts', 'grants.ts'),
  import: join(root, 'scripts', 'import.ts'),
  'openai-org': join(root, 'scripts', 'openai-org.ts'),
};

const adapterIds = ['antigravity', 'claude', 'codex', 'mock', 'opencode'];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const common = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  // ws and yaml are CommonJS and intentionally perform dynamic requires.
  // Leaving those two tiny runtime dependencies external preserves their Node
  // behavior; every Odysseus workspace module is still bundled.
  external: ['ws', 'yaml'],
  minify: true,
  legalComments: 'none',
  sourcemap: false,
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: commandEntries,
  outdir: output,
  outExtension: { '.js': '.mjs' },
});

for (const id of adapterIds) {
  const sourceDirectory = join(root, 'gateway', 'adapters', id);
  const targetDirectory = join(output, 'adapters', id);
  await mkdir(targetDirectory, { recursive: true });
  await build({
    ...common,
    entryPoints: [join(sourceDirectory, 'src', 'index.ts')],
    outfile: join(targetDirectory, 'index.mjs'),
  });

  const manifest = JSON.parse(
    await readFile(join(sourceDirectory, 'odysseus-adapter.json'), 'utf8'),
  );
  manifest.entry = './index.mjs';
  await writeFile(
    join(targetDirectory, 'odysseus-adapter.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

// Keep the directory self-describing for users inspecting a release asset.
await cp(join(root, 'README.md'), join(output, 'README.md'));
