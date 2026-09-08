import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import type { IDatabase } from '../../db/types';

export class EncryptedTokenStore {
  private readonly key: Buffer;
  constructor(
    private readonly db: IDatabase,
    secret: string,
  ) {
    if (!secret) throw new Error('Credential encryption secret is required');
    this.key = createHash('sha256').update(secret, 'utf8').digest();
  }

  async set(userId: string, token: string): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`github:${userId}`, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    await this.db.integrationCredentials.upsert({
      userId,
      provider: 'github',
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    });
  }

  async get(userId: string): Promise<string | null> {
    const record = await this.db.integrationCredentials.find(userId, 'github');
    if (!record) return null;
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(record.iv, 'base64'));
    decipher.setAAD(Buffer.from(`github:${userId}`, 'utf8'));
    decipher.setAuthTag(Buffer.from(record.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  async delete(userId: string): Promise<boolean> {
    return this.db.integrationCredentials.delete(userId, 'github');
  }
}
