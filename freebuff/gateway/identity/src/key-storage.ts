import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { type DeviceKeyMaterial } from '@freebuff/protocol';

export interface KeyStorageOptions {
  storageDir?: string;
  keyFileName?: string;
  filePermissions?: number;
  usePlatformKeychain?: boolean;
}

export const DEFAULT_KEY_STORAGE_OPTIONS: Required<Omit<KeyStorageOptions, 'usePlatformKeychain'>> &
  Pick<KeyStorageOptions, 'usePlatformKeychain'> = {
  storageDir: path.join(os.homedir(), '.freebuff'),
  keyFileName: 'device-keys.json',
  filePermissions: 0o600,
  usePlatformKeychain: false,
};

export interface StoredDeviceData extends DeviceKeyMaterial {
  deviceId?: string;
  gatewayId?: string;
}

export interface KeyStorage {
  load(): Promise<StoredDeviceData | null>;
  save(keyMaterial: StoredDeviceData): Promise<void>;
  exists(): Promise<boolean>;
  destroy(): Promise<void>;
  getStoragePath(): string;
}

class FileKeyStorage implements KeyStorage {
  private readonly options: Required<KeyStorageOptions>;

  constructor(options: KeyStorageOptions = {}) {
    this.options = { ...DEFAULT_KEY_STORAGE_OPTIONS, ...options } as Required<KeyStorageOptions>;
  }

  getStoragePath(): string {
    return path.join(this.options.storageDir, this.options.keyFileName);
  }

  private async ensureStorageDir(): Promise<void> {
    await fs.mkdir(this.options.storageDir, { recursive: true, mode: 0o700 });
  }

  async exists(): Promise<boolean> {
    try {
      await fs.access(this.getStoragePath());
      return true;
    } catch {
      return false;
    }
  }

  async load(): Promise<StoredDeviceData | null> {
    const storagePath = this.getStoragePath();

    let raw: string;
    try {
      raw = await fs.readFile(storagePath, 'utf8');
    } catch (err) {
      // A missing key file is the first-run case, not a failure.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to load device keys: ${message}`);
    }

    try {
      const parsed: unknown = JSON.parse(raw);

      if (!this.validateKeyMaterial(parsed)) {
        throw new Error('Invalid key material stored');
      }

      return parsed;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to load device keys: ${message}`);
    }
  }

  async save(keyMaterial: StoredDeviceData): Promise<void> {
    await this.ensureStorageDir();
    const storagePath = this.getStoragePath();

    try {
      const serialized = JSON.stringify(keyMaterial, null, 2);
      await fs.writeFile(storagePath, serialized, {
        mode: this.options.filePermissions,
        flag: 'w',
      });

      if (process.platform !== 'win32') {
        try {
          await fs.chmod(storagePath, this.options.filePermissions);
        } catch {
          // Best effort; ignore on platforms that don't support chmod
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to save device keys: ${message}`);
    }
  }

  async destroy(): Promise<void> {
    try {
      await fs.unlink(this.getStoragePath());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to destroy device keys: ${message}`);
    }
  }

  private validateKeyMaterial(data: unknown): data is StoredDeviceData {
    if (typeof data !== 'object' || data === null) return false;
    const obj = data as Record<string, unknown>;

    if (typeof obj.algorithm !== 'string') return false;
    if (!['Ed25519', 'secp256r1'].includes(obj.algorithm)) return false;
    if (typeof obj.privateKeyJwk !== 'object' || obj.privateKeyJwk === null) return false;
    if (typeof obj.publicKeyJwk !== 'object' || obj.publicKeyJwk === null) return false;
    if (typeof obj.publicKeyDer !== 'string') return false;
    if (typeof obj.publicKeyPem !== 'string') return false;

    return true;
  }
}

export function createKeyStorage(options?: KeyStorageOptions): KeyStorage {
  return new FileKeyStorage(options);
}
