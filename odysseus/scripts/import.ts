import { resolve } from 'node:path';
import { ChatGptExportStore, defaultPathContext } from '../gateway/integrations/src/index';
import { openManager } from './grant-prompt';

async function main() {
  const [provider, archive] = process.argv.slice(2);
  if (provider !== 'chatgpt' || !archive)
    throw new Error('Usage: pnpm import chatgpt <path-to-export.zip>');
  const manager = await openManager();
  const store = new ChatGptExportStore(defaultPathContext());
  const result = await store.importArchive(resolve(archive), manager);
  await manager.requestLocalSync('chatgpt-export');
  console.log(
    `Imported ${result.imported} ChatGPT conversations locally (${result.skipped} skipped).`,
  );
  console.log(
    'The running gateway will sync redacted titles now; conversation content remains local until requested.',
  );
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
