import {
  generateKeyPairSync,
  createSign,
  createVerify,
  randomBytes,
  KeyObject,
} from 'node:crypto';
import {
  DeviceIdentity,
  DeviceKeyMaterial,
  KeyAlgorithm,
  SignedHandshake,
  generateDeviceId,
  generateGatewayId,
} from '@freebuff/protocol';
import { createFingerprint } from './fingerprint';
import { createKeyStorage, KeyStorage, KeyStorageOptions } from './key-storage';

export interface DeviceIdentityManagerOptions {
  algorithm?: KeyAlgorithm;
  deviceId?: string;
  gatewayId?: string;
  storage?: KeyStorageOptions;
  metadata?: Record<string, unknown>;
}

export class DeviceIdentityManager {
  private readonly options: Required<Omit<DeviceIdentityManagerOptions, 'deviceId' | 'gatewayId' | 'storage' | 'metadata'>> &
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
        this.identity = this.buildIdentity(existing);
        this.cacheKeyObjects(existing);
        return this.identity;
      }
    }

    const keyMaterial = this.generateKeys();
    await this.storage.save(keyMaterial);
    this.keyMaterial = keyMaterial;
    this.identity = this.buildIdentity(keyMaterial);
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

    await this.storage.save(newKeys);
    this.keyMaterial = newKeys;
    this.identity = this.buildIdentity(newKeys);
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

    const signer = createSign('sha512');
    signer.update(data);
    signer.end();
    return signer.sign(this.privateKeyObj).toString('base64');
  }

  verifySignature(
    data: string | Buffer,
    signature: string,
    publicKeyJwk?: Record<string, unknown>,
  ): boolean {
    const keyObj = publicKeyJwk
      ? KeyObject.from({ format: 'jwk', key: publicKeyJwk as import('node:crypto').JsonWebKey })
      : this.publicKeyObj;

    if (!keyObj) {
      throw new Error('No public key available for verification.');
    }

    try {
      const verifier = createVerify('sha512');
      verifier.update(data);
      verifier.end();
      return verifier.verify(keyObj, Buffer.from(signature, 'base64'));
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
        privateKeyEncoding: { format: 'jwk', type: 'pkcs8' },
        publicKeyEncoding: { format: 'jwk', type: 'spki' },
      });
    } else {
      keyPair = generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
        privateKeyEncoding: { format: 'jwk', type: 'pkcs8' },
        publicKeyEncoding: { format: 'jwk', type: 'spki' },
      });
    }

    const privateJwk = keyPair.privateKey as unknown as Record<string, unknown>;
    const publicJwk = keyPair.publicKey as unknown as Record<string, unknown>;

    const privateKeyObj = KeyObject.from({
      format: 'jwk',
      key: privateJwk as import('node:crypto').JsonWebKey,
    });
    const publicKeyObj = KeyObject.from({
      format: 'jwk',
      key: publicJwk as import('node:crypto').JsonWebKey,
    });

    const { publicKey: publicKeyPem } = {
      publicKey: publicKeyObj
        .export({ format: 'pem', type: 'spki' })
        .toString('utf8'),
    };

    const publicDer = publicKeyObj
      .export({ format: 'der', type: 'spki' })
      .toString('base64');

    return {
      algorithm,
      privateKeyJwk: privateJwk,
      publicKeyJwk: publicJwk,
      publicKeyDer: publicDer,
      publicKeyPem: publicKeyPem,
    };
  }

  private buildIdentity(keyMaterial: DeviceKeyMaterial): DeviceIdentity {
    const fingerprint = createFingerprint(keyMaterial.publicKeyDer);
    const deviceId = this.options.deviceId ?? generateDeviceId();
    const gatewayId = this.options.gatewayId ?? generateGatewayId();

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
    this.privateKeyObj = KeyObject.from({
      format: 'jwk',
      key: keyMaterial.privateKeyJwk as import('node:crypto').JsonWebKey,
    });
    this.publicKeyObj = KeyObject.from({
      format: 'jwk',
      key: keyMaterial.publicKeyJwk as import('node:crypto').JsonWebKey,
    });
  }
}

export function createDeviceIdentityManager(
  options?: DeviceIdentityManagerOptions,
): DeviceIdentityManager {
  return new DeviceIdentityManager(options);
}
