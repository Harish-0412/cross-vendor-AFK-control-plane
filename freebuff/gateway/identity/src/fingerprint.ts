import { createHash } from 'node:crypto';
import { getWord } from './wordlist';
import {
  DeviceFingerprint,
  FINGERPRINT_WORD_COUNT,
  FINGERPRINT_SHORT_CODE_LENGTH,
} from '@freebuff/protocol';

function hashPublicKey(publicKeyDer: string | Buffer): Buffer {
  const derBuffer = typeof publicKeyDer === 'string'
    ? Buffer.from(publicKeyDer, 'base64')
    : publicKeyDer;
  return createHash('sha256').update(derBuffer).digest();
}

function bytesToColonHex(bytes: Buffer): string {
  return bytes.toString('hex').match(/.{2}/g)!.join(':');
}

function bytesToWords(bytes: Buffer, wordCount: number): string[] {
  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    const byte1 = bytes[i * 2] ?? 0;
    const byte2 = bytes[(i * 2) + 1] ?? 0;
    const index = ((byte1 << 8) | byte2) & 0x7ff;
    words.push(getWord(index));
  }
  return words;
}

function bytesToShortCode(bytes: Buffer, length: number): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    const byte = bytes[i % bytes.length];
    result += chars[byte % chars.length];
  }
  return result;
}

export function createFingerprint(publicKeyDer: string | Buffer): DeviceFingerprint {
  const hash = hashPublicKey(publicKeyDer);
  const hex = hash.toString('hex');
  return {
    hex,
    colonSeparated: bytesToColonHex(hash),
    words: bytesToWords(hash, FINGERPRINT_WORD_COUNT),
    shortCode: bytesToShortCode(hash, FINGERPRINT_SHORT_CODE_LENGTH),
    hashAlgorithm: 'sha256',
  };
}

export function formatFingerprintForDisplay(fp: DeviceFingerprint, style: 'words' | 'colon' | 'short' = 'words'): string {
  switch (style) {
    case 'words':
      return fp.words.join(' ');
    case 'colon':
      return fp.colonSeparated;
    case 'short':
      return fp.shortCode;
  }
}

export function verifyFingerprintMatch(fp1: DeviceFingerprint, fp2: DeviceFingerprint): boolean {
  return fp1.hex === fp2.hex && fp1.hashAlgorithm === fp2.hashAlgorithm;
}

export function fingerprintToQrPayload(
  fingerprint: DeviceFingerprint,
  deviceId: string,
  gatewayId: string,
): string {
  const data = {
    v: 1,
    d: deviceId,
    g: gatewayId,
    f: fingerprint.hex,
    t: Date.now(),
  };
  return Buffer.from(JSON.stringify(data)).toString('base64url');
}

export function parseQrPayload(payload: string): {
  version: number;
  deviceId: string;
  gatewayId: string;
  fingerprintHex: string;
  timestamp: number;
} | null {
  try {
    const decoded = Buffer.from(payload, 'base64url').toString('utf8');
    const data = JSON.parse(decoded);
    if (!data.v || !data.d || !data.g || !data.f || !data.t) return null;
    return {
      version: data.v,
      deviceId: data.d,
      gatewayId: data.g,
      fingerprintHex: data.f,
      timestamp: data.t,
    };
  } catch {
    return null;
  }
}
