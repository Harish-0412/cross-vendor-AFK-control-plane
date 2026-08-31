import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import {
  DeviceIdentityManager,
  createDeviceIdentityManager,
  createFingerprint,
  formatFingerprintForDisplay,
  verifyFingerprintMatch,
  fingerprintToQrPayload,
  parseQrPayload,
} from '../index';
import { FINGERPRINT_WORD_COUNT, FINGERPRINT_SHORT_CODE_LENGTH } from '@freebuff/protocol';

describe('DeviceIdentityManager', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'freebuff-identity-test-'));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function createManager(deviceId?: string, gatewayId?: string): DeviceIdentityManager {
    return createDeviceIdentityManager({
      algorithm: 'Ed25519',
      deviceId,
      gatewayId,
      storage: {
        storageDir: tmpDir,
        keyFileName: `keys-${Date.now()}.json`,
      },
    });
  }

  it('should initialize with Ed25519 and generate valid identity', async () => {
    const manager = createManager();
    const identity = await manager.initialize();

    expect(identity.deviceId.startsWith('dev_')).toBe(true);
    expect(identity.deviceId.length).toBe(4 + 32);
    expect(identity.gatewayId.startsWith('gw_')).toBe(true);
    expect(identity.algorithm).toBe('Ed25519');
    expect(identity.fingerprint.hex).toMatch(/^[a-f0-9]{64}$/);
    expect(identity.fingerprint.words.length).toBe(FINGERPRINT_WORD_COUNT);
    expect(identity.fingerprint.shortCode.length).toBe(FINGERPRINT_SHORT_CODE_LENGTH);
    expect(identity.fingerprint.hashAlgorithm).toBe('sha256');
    expect(typeof identity.publicKeyPem).toBe('string');
    expect(identity.publicKeyPem.includes('BEGIN PUBLIC KEY')).toBe(true);
  });

  it('should use pre-provided deviceId and gatewayId', async () => {
    const manager = createManager('dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'gw_bbbbbbbbbbbbbbbbbbbbbbbb');
    const identity = await manager.initialize();
    expect(identity.deviceId).toBe('dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(identity.gatewayId).toBe('gw_bbbbbbbbbbbbbbbbbbbbbbbb');
  });

  it('should persist keys and load them on subsequent initialize()', async () => {
    const opts = {
      storageDir: tmpDir,
      keyFileName: 'persistent-keys.json',
    };
    const m1 = createDeviceIdentityManager({ storage: opts });
    const id1 = await m1.initialize();

    const m2 = createDeviceIdentityManager({ storage: opts });
    const id2 = await m2.initialize();

    expect(id2.deviceId).toBe(id1.deviceId);
    expect(id2.gatewayId).toBe(id1.gatewayId);
    expect(id2.fingerprint.hex).toBe(id1.fingerprint.hex);
    expect(id2.publicKeyPem).toBe(id1.publicKeyPem);
    expect(m2.getKeyMaterial().publicKeyDer).toBe(m1.getKeyMaterial().publicKeyDer);
  });

  it('should force regenerate with forceRegenerate', async () => {
    const opts = { storageDir: tmpDir, keyFileName: 'regen-keys.json' };
    const m1 = createDeviceIdentityManager({ storage: opts });
    const id1 = await m1.initialize();

    const m2 = createDeviceIdentityManager({ storage: opts });
    const id2 = await m2.initialize(true);

    expect(id2.fingerprint.hex).not.toBe(id1.fingerprint.hex);
    expect(id2.publicKeyPem).not.toBe(id1.publicKeyPem);
  });

  it('should throw when accessing identity before initialize', () => {
    const manager = createManager();
    expect(() => manager.getIdentity()).toThrow(/not initialized/i);
    expect(() => manager.getKeyMaterial()).toThrow(/not initialized/i);
  });

  it('should sign and verify signatures consistently', async () => {
    const manager = createManager();
    await manager.initialize();

    const message = 'test-payload-1234';
    const signature = manager.sign(message);
    expect(typeof signature).toBe('string');
    expect(signature.length > 0).toBe(true);

    const ok = manager.verifySignature(message, signature);
    expect(ok).toBe(true);

    const badSig = manager.sign('other-payload');
    expect(manager.verifySignature(message, badSig)).toBe(false);
  });

  it('should create and verify signed handshake', async () => {
    const manager = createManager();
    await manager.initialize();

    const handshake = manager.createHandshake();
    expect(handshake.deviceId).toBe(manager.getIdentity().deviceId);
    expect(handshake.nonce.length).toBe(64);
    expect(typeof handshake.signature).toBe('string');

    const ok = manager.verifyHandshake(handshake);
    expect(ok).toBe(true);

    const tampered: typeof handshake = { ...handshake, nonce: 'tampered' };
    expect(manager.verifyHandshake(tampered)).toBe(false);
  });

  it('should rotate keys correctly', async () => {
    const opts = { storageDir: tmpDir, keyFileName: 'rotate-keys.json' };
    const manager = createDeviceIdentityManager({ storage: opts });
    const id1 = await manager.initialize();
    const id2 = await manager.rotateKeys();

    expect(id2.fingerprint.hex).not.toBe(id1.fingerprint.hex);
    expect(id2.publicKeyPem).not.toBe(id1.publicKeyPem);
    expect(id2.metadata.previousDeviceId).toBe(id1.deviceId);
  });

  it('should destroy keys correctly', async () => {
    const opts = { storageDir: tmpDir, keyFileName: 'destroy-keys.json' };
    const manager = createDeviceIdentityManager({ storage: opts });
    await manager.initialize();
    expect(existsSync(manager.getStoragePath())).toBe(true);

    await manager.destroy();
    expect(existsSync(manager.getStoragePath())).toBe(false);
    expect(() => manager.getIdentity()).toThrow();
  });

  it('should detect existing identity via hasExistingIdentity', async () => {
    const opts = { storageDir: tmpDir, keyFileName: 'exist-keys.json' };
    const m1 = createDeviceIdentityManager({ storage: opts });
    expect(await m1.hasExistingIdentity()).toBe(false);
    await m1.initialize();
    expect(await m1.hasExistingIdentity()).toBe(true);
  });
});

describe('fingerprint helpers', () => {
  it('should create SHA-256 fingerprint in all formats', () => {
    const der = Buffer.from('fake-key-der-bytes-for-test-1234567890abcdef');
    const fp = createFingerprint(der);
    expect(fp.hashAlgorithm).toBe('sha256');
    expect(fp.hex).toMatch(/^[a-f0-9]{64}$/);
    expect(fp.colonSeparated).toMatch(/^([a-f0-9]{2}:){31}[a-f0-9]{2}$/);
    expect(fp.words.length).toBe(FINGERPRINT_WORD_COUNT);
    expect(fp.shortCode.length).toBe(FINGERPRINT_SHORT_CODE_LENGTH);
    expect(fp.hex.replace(/../g, (m) => `${m}:`).slice(0, -1)).toBe(fp.colonSeparated);
  });

  it('should format fingerprints for display', () => {
    const fp = createFingerprint(Buffer.from('der-bytes'));
    const wordStyle = formatFingerprintForDisplay(fp, 'words');
    expect(wordStyle.split(' ').length).toBe(FINGERPRINT_WORD_COUNT);
    const colonStyle = formatFingerprintForDisplay(fp, 'colon');
    expect(colonStyle).toContain(':');
    const shortStyle = formatFingerprintForDisplay(fp, 'short');
    expect(shortStyle.length).toBe(FINGERPRINT_SHORT_CODE_LENGTH);
  });

  it('should match equivalent fingerprints', () => {
    const der = Buffer.from('same-der-bytes-every-time');
    const a = createFingerprint(der);
    const b = createFingerprint(der);
    expect(verifyFingerprintMatch(a, b)).toBe(true);

    const c = createFingerprint(Buffer.from('different-der-bytes'));
    expect(verifyFingerprintMatch(a, c)).toBe(false);
  });

  it('should round-trip QR payloads', () => {
    const fp = createFingerprint(Buffer.from('qr-test-der'));
    const payload = fingerprintToQrPayload(fp, 'dev_1234567890abcdef1234567890abcdef', 'gw_abcdef1234567890abcdef');
    expect(typeof payload).toBe('string');
    expect(payload.length > 0).toBe(true);

    const parsed = parseQrPayload(payload);
    expect(parsed).not.toBeNull();
    expect(parsed!.deviceId).toBe('dev_1234567890abcdef1234567890abcdef');
    expect(parsed!.gatewayId).toBe('gw_abcdef1234567890abcdef');
    expect(parsed!.fingerprintHex).toBe(fp.hex);
    expect(typeof parsed!.timestamp).toBe('number');

    expect(parseQrPayload('not-valid-base64url!!!')).toBeNull();
  });
});
