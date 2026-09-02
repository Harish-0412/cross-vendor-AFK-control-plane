import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

import {
  type DeviceIdentity,
  type DeviceKeyMaterial,
  type KeyAlgorithm,
  type SignedHandshake,
  generateDeviceId,
  generateGatewayId,
} from '@freebuff/protocol';

import { createFingerprint } from './fingerprint';
import { createKeyStorage, type KeyStorage, type KeyStorageOptions } from './key-storage';

export interface DeviceIdentityManagerOptions {
  algorithm?: KeyAlgorithm;
  deviceId?: string;
  gatewayId?: string;
  storage?: KeyStorageOptions;
  metadata?: Record<string, unknown>;
}

export class DeviceIdentityManager {
  private readonly options: Required<
    Omit<DeviceIdentityManagerOptions, 'deviceId' | 'gatewayId' | 'storage' | 'metadata'>
  > &
    Pick<DeviceIdentityManagerOptions, 'deviceId' | 'gatewayId' | 'metadata'> & {
      storage: KeyStorageOptions;
    };
  private readonly storage: KeyStorage;
  private keyMaterial: DeviceKeyMaterial | null = null;
  private identity: DeviceIdentity | null = null;
  private privateKeyObj: KeyObject | null = null;
  private publicKeyObj: KeyObject | null = null;

  constructor(options: DeviceIdentityManagerOptions = {}) {
    this.options = {
      algorithm: 'Ed25519',
      storage: {},
      metadata: {},
      ...options,
    };
    this.storage = createKeyStorage(this.options.storage);
  }

  getStoragePath(): string {
    return this.storage.getStoragePath();
  }

  async hasExistingIdentity(): Promise<boolean> {
    return this.storage.exists();
  }

  async initialize(forceRegenerate = false): Promise<DeviceIdentity> {
    if (!forceRegenerate) {
      const existing = await this.storage.load();
      if (existing) {
        this.keyMaterial = existing;
        this.identity = this.buildIdentity(existing, existing.deviceId, existing.gatewayId);
        this.cacheKeyObjects(existing);
        return this.identity;
      }
    }

    const keyMaterial = this.generateKeys();
    const identity = this.buildIdentity(keyMaterial);
    await this.storage.save({
      ...keyMaterial,
      deviceId: identity.deviceId,
      gatewayId: identity.gatewayId,
    } as import('./key-storage').StoredDeviceData);
    this.keyMaterial = keyMaterial;
    this.identity = identity;
    this.cacheKeyObjects(keyMaterial);
    return this.identity;
  }

  getIdentity(): DeviceIdentity {
    if (!this.identity) {
      throw new Error('Device identity not initialized. Call initialize() first.');
    }
    return this.identity;
  }

  getKeyMaterial(): DeviceKeyMaterial {
    if (!this.keyMaterial) {
      throw new Error('Device key material not initialized. Call initialize() first.');
    }
    return this.keyMaterial;
  }

  async rotateKeys(): Promise<DeviceIdentity> {
    const newKeys = this.generateKeys();
    const oldIdentity = this.identity;

    const newIdentity = this.buildIdentity(newKeys);
    await this.storage.save({
      ...newKeys,
      deviceId: newIdentity.deviceId,
      gatewayId: newIdentity.gatewayId,
    } as import('./key-storage').StoredDeviceData);
    this.keyMaterial = newKeys;
    this.identity = newIdentity;
    this.cacheKeyObjects(newKeys);

    if (oldIdentity && this.options.metadata) {
      this.identity.metadata = {
        ...this.options.metadata,
        previousDeviceId: oldIdentity.deviceId,
        rotatedAt: new Date().toISOString(),
      };
    }

    return this.identity;
  }

  async destroy(): Promise<void> {
    await this.storage.destroy();
    this.keyMaterial = null;
    this.identity = null;
    this.privateKeyObj = null;
    this.publicKeyObj = null;
  }

  sign(data: string | Buffer): string {
    if (!this.privateKeyObj) {
      throw new Error('Private key not available. Call initialize() first.');
    }

    const dataBuf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const algorithm = this.options.algorithm === 'Ed25519' ? undefined : 'sha512';
    const sig = sign(algorithm, dataBuf, this.privateKeyObj);
    return sig.toString('base64');
  }

  verifySignature(
    data: string | Buffer,
    signature: string,
    publicKeyJwk?: Record<string, unknown>,
  ): boolean {
    let keyObj: KeyObject | null = null;
    if (publicKeyJwk) {
      keyObj = createPublicKey({
        key: publicKeyJwk as import('node:crypto').JsonWebKey,
        format: 'jwk',
      });
    } else {
      keyObj = this.publicKeyObj;
    }

    if (!keyObj) {
      throw new Error('No public key available for verification.');
    }

    try {
      const dataBuf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      const algorithm = this.options.algorithm === 'Ed25519' ? undefined : 'sha512';
      return verify(algorithm, dataBuf, keyObj, Buffer.from(signature, 'base64'));
    } catch {
      return false;
    }
  }

  createHandshake(certificateThumbprint?: string): SignedHandshake {
    const identity = this.getIdentity();
    const nonce = randomBytes(32).toString('hex');
    const timestamp = new Date();

    const payload = JSON.stringify({
      deviceId: identity.deviceId,
      nonce,
      timestamp: timestamp.toISOString(),
      certificateThumbprint: certificateThumbprint ?? '',
    });

    return {
      deviceId: identity.deviceId,
      nonce,
      timestamp,
      signature: this.sign(payload),
      publicKeyJwk: identity.publicKeyJwk,
      certificateThumbprint,
    };
  }

  verifyHandshake(handshake: SignedHandshake): boolean {
    const payload = JSON.stringify({
      deviceId: handshake.deviceId,
      nonce: handshake.nonce,
      timestamp: handshake.timestamp.toISOString(),
      certificateThumbprint: handshake.certificateThumbprint ?? '',
    });

    try {
      return this.verifySignature(payload, handshake.signature, handshake.publicKeyJwk);
    } catch {
      return false;
    }
  }

  private generateKeys(): DeviceKeyMaterial {
    const algorithm = this.options.algorithm;
    let keyPair;

    if (algorithm === 'Ed25519') {
      keyPair = generateKeyPairSync('ed25519', {
        privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
        publicKeyEncoding: { format: 'pem', type: 'spki' },
      });
    } else {
      keyPair = generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
        privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
        publicKeyEncoding: { format: 'pem', type: 'spki' },
      });
    }

    const privateKeyPem = keyPair.privateKey;
    const publicKeyPem = keyPair.publicKey;

    const privateKeyObj = createPrivateKey(privateKeyPem);
    const publicKeyObj = createPublicKey(publicKeyPem);

    const privateJwk = privateKeyObj.export({ format: 'jwk' }) as Record<string, unknown>;
    const publicJwk = publicKeyObj.export({ format: 'jwk' }) as Record<string, unknown>;

    const publicDer = publicKeyObj.export({ format: 'der', type: 'spki' }).toString('base64');

    return {
      algorithm,
      privateKeyJwk: privateJwk,
      publicKeyJwk: publicJwk,
      publicKeyDer: publicDer,
      publicKeyPem,
    };
  }

  private buildIdentity(
    keyMaterial: DeviceKeyMaterial,
    savedDeviceId?: string,
    savedGatewayId?: string,
  ): DeviceIdentity {
    const fingerprint = createFingerprint(keyMaterial.publicKeyDer);
    const deviceId = this.options.deviceId ?? savedDeviceId ?? generateDeviceId();
    const gatewayId = this.options.gatewayId ?? savedGatewayId ?? generateGatewayId();

    return {
      deviceId,
      gatewayId,
      publicKeyJwk: keyMaterial.publicKeyJwk,
      publicKeyPem: keyMaterial.publicKeyPem,
      fingerprint,
      algorithm: keyMaterial.algorithm,
      createdAt: new Date(),
      metadata: { ...(this.options.metadata ?? {}) },
    };
  }

  private cacheKeyObjects(keyMaterial: DeviceKeyMaterial): void {
    this.privateKeyObj = createPrivateKey({
      key: keyMaterial.privateKeyJwk as import('node:crypto').JsonWebKey,
      format: 'jwk',
    });
    this.publicKeyObj = createPublicKey({
      key: keyMaterial.publicKeyJwk as import('node:crypto').JsonWebKey,
      format: 'jwk',
    });
  }
}

export function createDeviceIdentityManager(
  options?: DeviceIdentityManagerOptions,
): DeviceIdentityManager {
  return new DeviceIdentityManager(options);
}
