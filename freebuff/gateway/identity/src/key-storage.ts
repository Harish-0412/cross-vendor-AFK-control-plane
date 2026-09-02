import * as fs from 'node:fs';
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

  private ensureStorageDir(): void {
    if (!fs.existsSync(this.options.storageDir)) {
      fs.mkdirSync(this.options.storageDir, { recursive: true, mode: 0o700 });
    }
  }

  async exists(): Promise<boolean> {
    return fs.existsSync(this.getStoragePath());
  }

  async load(): Promise<StoredDeviceData | null> {
    const storagePath = this.getStoragePath();
    if (!fs.existsSync(storagePath)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(storagePath, 'utf8');
      const parsed = JSON.parse(raw);

      if (!this.validateKeyMaterial(parsed)) {
        throw new Error('Invalid key material stored');
      }

      return parsed as DeviceKeyMaterial;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to load device keys: ${message}`);
    }
  }

  async save(keyMaterial: StoredDeviceData): Promise<void> {
    this.ensureStorageDir();
    const storagePath = this.getStoragePath();

    try {
      const serialized = JSON.stringify(keyMaterial, null, 2);
      fs.writeFileSync(storagePath, serialized, {
        mode: this.options.filePermissions,
        flag: 'w',
      });

      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(storagePath, this.options.filePermissions);
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
    const storagePath = this.getStoragePath();
    if (fs.existsSync(storagePath)) {
      try {
        fs.unlinkSync(storagePath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to destroy device keys: ${message}`);
      }
    }
  }

  private validateKeyMaterial(data: unknown): boolean {
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
