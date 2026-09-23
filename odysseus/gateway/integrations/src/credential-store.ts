import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PathContext } from './paths';
import { readJsonFile, writeJsonFileAtomic } from './atomic-file';

interface EncryptedCredential {
  version: 1;
  algorithm: 'aes-256-gcm';
  iv: string;
  tag: string;
  ciphertext: string;
  updatedAt: string;
  hint: string;
}

/** Local AES-GCM credential vault. Neither keys nor plaintext are logged or returned to the web. */
export class LocalCredentialStore {
  constructor(private readonly ctx: PathContext) {}
  private masterFile() {
    return join(this.ctx.odysseusHome, 'credential-master.key');
  }
  private credentialFile(id: string) {
    return join(this.ctx.odysseusHome, 'credentials', `${id}.json`);
  }

  async save(id: 'openai-org', secret: string): Promise<void> {
    const key = await this.masterKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`odysseus:${id}:v1`));
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    await writeJsonFileAtomic(this.credentialFile(id), {
      version: 1,
      algorithm: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      updatedAt: new Date().toISOString(),
      hint: secret.slice(-4),
    } satisfies EncryptedCredential);
  }
  async load(id: 'openai-org'): Promise<string | null> {
    const record = await readJsonFile<EncryptedCredential | null>(this.credentialFile(id), null);
    if (!record || record.version !== 1 || record.algorithm !== 'aes-256-gcm') return null;
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        await this.masterKey(false),
        Buffer.from(record.iv, 'base64'),
      );
      decipher.setAAD(Buffer.from(`odysseus:${id}:v1`));
      decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new Error('The local OpenAI credential vault could not be decrypted');
    }
  }
  async status(
    id: 'openai-org',
  ): Promise<{ configured: boolean; updatedAt?: string; hint?: string }> {
    const record = await readJsonFile<EncryptedCredential | null>(this.credentialFile(id), null);
    return record
      ? { configured: true, updatedAt: record.updatedAt, hint: record.hint }
      : { configured: false };
  }
  async remove(id: 'openai-org'): Promise<void> {
    await rm(this.credentialFile(id), { force: true });
  }
  private async masterKey(create = true): Promise<Buffer> {
    try {
      const key = await readFile(this.masterFile());
      if (key.length !== 32) throw new Error('invalid master key');
      return key;
    } catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const key = randomBytes(32);
      await mkdir(dirname(this.masterFile()), { recursive: true, mode: 0o700 });
      await writeFile(this.masterFile(), key, { mode: 0o600, flag: 'wx' });
      await chmod(this.masterFile(), 0o600).catch(() => undefined);
      return key;
    }
  }
}
