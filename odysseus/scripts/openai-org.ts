import { emitKeypressEvents } from 'node:readline';
import {
  LocalCredentialStore,
  OpenAiOrgClient,
  defaultPathContext,
} from '../gateway/integrations/src/index';
import { openManager } from './grant-prompt';

async function hidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode)
    throw new Error('The Admin key must be entered in an interactive terminal');
  process.stdout.write(prompt);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const onKey = (chunk: Buffer, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        reject(new Error('Cancelled'));
        return;
      }
      if (key.name === 'return') {
        cleanup();
        process.stdout.write('\n');
        resolve(value);
        return;
      }
      if (key.name === 'backspace') {
        value = value.slice(0, -1);
        return;
      }
      const text = chunk.toString('utf8');
      if (/^[\x20-\x7e]+$/.test(text)) value += text;
    };
    const cleanup = () => {
      process.stdin.off('keypress', onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    process.stdin.on('keypress', onKey);
  });
}

async function main() {
  const command = process.argv[2] ?? 'status';
  const ctx = defaultPathContext();
  const vault = new LocalCredentialStore(ctx);
  if (command === 'status') {
    const status = await vault.status('openai-org');
    console.log(
      status.configured
        ? `OpenAI organization credential configured (ends in ${status.hint}, updated ${status.updatedAt}).`
        : 'OpenAI organization credential is not configured.',
    );
    return;
  }
  if (command === 'remove') {
    await vault.remove('openai-org');
    console.log('OpenAI organization credential removed from this workstation.');
    return;
  }
  const manager = await openManager();
  const grant = await manager.store.findActive('openai-org');
  if (!grant?.scopes.includes('usage.read'))
    throw new Error('Connect OpenAI organisation with Usage access in the web app first');
  if (command === 'configure') {
    const key = (await hidden('OpenAI Admin key (input hidden): ')).trim();
    if (!key) throw new Error('No key entered');
    process.stdout.write('Validating with the OpenAI Costs API… ');
    await new OpenAiOrgClient().validate(key);
    await vault.save('openai-org', key);
    await manager.requestLocalSync('openai-org');
    console.log('saved securely on this workstation.');
    return;
  }
  if (command === 'sync') {
    await manager.requestLocalSync('openai-org');
    console.log('The running gateway will refresh organization usage now.');
    return;
  }
  throw new Error('Usage: pnpm openai-org [configure|status|sync|remove]');
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
