import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import type { IDatabase } from '../../db/types';

import type { StoredVcsCredential, VcsProvider } from './types';

export class VcsCredentialStore {
  private readonly key: Buffer;

  constructor(
    private readonly db: IDatabase,
    secret: string,
  ) {
    if (!secret) throw new Error('Credential encryption secret is required');
    this.key = createHash('sha256').update(secret, 'utf8').digest();
  }

  async set(userId: string, provider: VcsProvider, credential: StoredVcsCredential): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(this.aad(userId, provider), 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(credential), 'utf8'),
      cipher.final(),
    ]);
    await this.db.integrationCredentials.upsert({
      userId,
      provider,
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    });
  }

  async get(userId: string, provider: VcsProvider): Promise<StoredVcsCredential | null> {
    const record = await this.db.integrationCredentials.find(userId, provider);
    if (!record) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(record.iv, 'base64'));
      decipher.setAAD(Buffer.from(this.aad(userId, provider), 'utf8'));
      decipher.setAuthTag(Buffer.from(record.authTag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      const credential = JSON.parse(plaintext) as Partial<StoredVcsCredential>;
      if (
        typeof credential.accessToken !== 'string' ||
        !credential.account ||
        typeof credential.account.username !== 'string'
      ) {
        throw new Error('Credential payload is invalid');
      }
      return credential as StoredVcsCredential;
    } catch {
      // Never fall back to a corrupt or legacy encrypted value as a token.
      await this.delete(userId, provider);
      return null;
    }
  }

  delete(userId: string, provider: VcsProvider): Promise<boolean> {
    return this.db.integrationCredentials.delete(userId, provider);
  }

  private aad(userId: string, provider: VcsProvider): string {
    return `vcs:${provider}:${userId}`;
  }
}
