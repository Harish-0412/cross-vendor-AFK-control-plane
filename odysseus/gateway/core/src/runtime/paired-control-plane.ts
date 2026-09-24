/**
 * Which Control Plane this workstation is paired with.
 *
 * A device is registered on exactly one Control Plane: the one `pair` talked
 * to. A gateway that later connects anywhere else is refused, because that
 * server has never heard of the device. Before this record existed, `pair` and
 * `gateway` each took their URL from a separate environment variable, in a
 * different format (https vs wss), defaulting to localhost. Forgetting either
 * one in a fresh terminal paired the device with — or connected it to — the
 * local development server, while the website on the hosted one showed no
 * devices at all.
 *
 * So pairing writes down where it registered the device, and the gateway uses
 * that as its default. Setting a URL explicitly still wins; the record only
 * replaces the guess.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const PAIRING_RECORD_FILE = 'pairing.json';

/** The hosted Control Plane — the default for a workstation that has never paired. */
export const HOSTED_CONTROL_PLANE_URL = 'https://odysseus-control-plane.onrender.com';
export const HOSTED_WEB_URL = 'https://cross-vendor-afk-control-plane.vercel.app';

export interface PairingRecord {
  /** HTTPS base URL of the Control Plane the device was registered on. */
  controlPlaneUrl: string;
  /** The tunnel URL derived from it, which is what the gateway connects to. */
  tunnelUrl: string;
  /** The website the pairing was approved in. */
  webUrl: string;
  deviceId: string;
  pairedAt: string;
}

export function pairingRecordPath(home: string = homedir()): string {
  return join(home, '.odysseus', PAIRING_RECORD_FILE);
}

/** `https://host` → `wss://host/ws/tunnel`; `http://` → `ws://`. */
export function tunnelUrlFor(controlPlaneUrl: string): string {
  const base = controlPlaneUrl.replace(/\/+$/, '');
  return `${base.replace(/^http/i, 'ws')}/ws/tunnel`;
}

/**
 * The host a URL points at, for comparing two URLs that may differ in scheme
 * (`https` vs `wss`) or path but name the same server.
 */
export function controlPlaneHost(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

export function isLocalControlPlane(url: string): boolean {
  const host = controlPlaneHost(url);
  if (!host) return false;
  const name = host.replace(/:\d+$/, '');
  return name === 'localhost' || name === '127.0.0.1' || name === '0.0.0.0' || name === '[::1]';
}

export function readPairingRecord(
  home: string = homedir(),
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): PairingRecord | null {
  let raw: string;
  try {
    raw = read(pairingRecordPath(home));
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<PairingRecord>;
    if (
      typeof value.controlPlaneUrl !== 'string' ||
      typeof value.tunnelUrl !== 'string' ||
      typeof value.deviceId !== 'string' ||
      !controlPlaneHost(value.controlPlaneUrl) ||
      !controlPlaneHost(value.tunnelUrl)
    ) {
      return null;
    }
    return {
      controlPlaneUrl: value.controlPlaneUrl,
      tunnelUrl: value.tunnelUrl,
      webUrl: typeof value.webUrl === 'string' ? value.webUrl : HOSTED_WEB_URL,
      deviceId: value.deviceId,
      pairedAt: typeof value.pairedAt === 'string' ? value.pairedAt : '',
    };
  } catch {
    // A corrupt record is treated as absent rather than trusted in part: the
    // gateway falls back to its default and the pairing preflight says so.
    return null;
  }
}

/** Written atomically, so a crash mid-write cannot leave a half-record behind. */
export function writePairingRecord(record: PairingRecord, home: string = homedir()): string {
  const path = pairingRecordPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  return path;
}
