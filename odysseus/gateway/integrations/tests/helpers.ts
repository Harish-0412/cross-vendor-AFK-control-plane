import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { GRANT_REQUEST_TTL_MS, type GrantRequestCommand, type IntegrationId, type IntegrationScope } from '@odysseus/protocol';

import { hashConfirmationCode } from '../src/confirmation';
import type { DeviceSigner } from '../src/grant-store';
import type { PathContext } from '../src/paths';

/** A signer with a real Ed25519 key, matching DeviceIdentityManager. */
export function createSigner(deviceId = 'dev_test_device'): DeviceSigner {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const priv = createPrivateKey(privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const pub = createPublicKey(publicKey.export({ format: 'pem', type: 'spki' }));
  return {
    deviceId,
    sign: (data) => sign(null, Buffer.from(data), priv).toString('base64'),
    verify: (data, signature) => {
      try {
        return verify(null, Buffer.from(data), pub, Buffer.from(signature, 'base64'));
      } catch {
        return false;
      }
    },
  };
}

/** A throwaway home directory laid out like a real one. */
export function createHome(): PathContext & { cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'odysseus-integrations-'));
  return {
    home,
    odysseusHome: join(home, '.odysseus'),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

export function writeFile(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

export const CODE = 'K7Q2MX';

export function makeRequest(
  integration: IntegrationId = 'codex',
  scopes: IntegrationScope[] = ['history.read', 'usage.read'],
  overrides: Partial<GrantRequestCommand> = {},
  now = Date.now(),
): GrantRequestCommand {
  const salt = randomBytes(16).toString('hex');
  return {
    requestId: `req_${randomBytes(8).toString('hex')}`,
    integration,
    scopes,
    requestedBy: { userId: 'usr_owner', email: 'owner@example.com' },
    confirmation: { salt, sha256: hashConfirmationCode(CODE, salt) },
    expiresAt: new Date(now + GRANT_REQUEST_TTL_MS).toISOString(),
    ...overrides,
  };
}
