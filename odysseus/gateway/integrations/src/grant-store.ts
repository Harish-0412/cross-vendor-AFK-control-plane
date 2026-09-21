/**
 * Signed grants and pending access requests, stored on the workstation.
 *
 * The gateway is the authority on what an integration may read. A grant is
 * valid only if it is signed by *this* device's private key over a fixed
 * field order, belongs to this device, and has not expired — checked every
 * time it is used, not once at load. A grant that was hand-edited, copied
 * from another machine or written by some other process fails the signature
 * check and is treated exactly as if it did not exist.
 */
import type { GrantRequestCommand, IntegrationId, IntegrationScope } from '@odysseus/protocol';

import { readJsonFile, writeJsonFileAtomic } from './atomic-file';
import { grantsFile, requestsFile, type PathContext } from './paths';

export interface DeviceSigner {
  deviceId: string;
  sign(data: string): string;
  verify(data: string, signature: string): boolean;
}

export interface StoredGrant {
  grantId: string;
  requestId: string;
  deviceId: string;
  userId: string;
  integration: IntegrationId;
  scopes: IntegrationScope[];
  /** Real (symlink-resolved) directories this grant covers. */
  roots: string[];
  grantedAt: string;
  expiresAt: string;
  approvedOn: 'workstation';
  signature: string;
}

export type RequestStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface PendingRequest extends GrantRequestCommand {
  status: RequestStatus;
  receivedAt: string;
  /** Wrong confirmation codes entered so far. */
  attempts: number;
  decidedAt?: string | undefined;
  reason?: string | undefined;
}

interface GrantsFile {
  version: 1;
  grants: StoredGrant[];
}

interface RequestsFile {
  version: 1;
  requests: PendingRequest[];
}

/**
 * The exact string that is signed. An array gives a fixed order independent
 * of how the object was built; scopes are sorted so the same grant always
 * produces the same bytes.
 */
export function grantSigningPayload(grant: Omit<StoredGrant, 'signature'>): string {
  return JSON.stringify([
    'odysseus-grant-v1',
    grant.grantId,
    grant.requestId,
    grant.deviceId,
    grant.userId,
    grant.integration,
    [...grant.scopes].sort(),
    grant.roots,
    grant.grantedAt,
    grant.expiresAt,
    grant.approvedOn,
  ]);
}

export interface VerifiedGrants {
  valid: StoredGrant[];
  /** Grants present on disk that failed verification, with why. */
  rejected: Array<{ grantId: string; integration: string; reason: string }>;
}

export class GrantStore {
  constructor(
    private readonly ctx: PathContext,
    private readonly signer: DeviceSigner,
  ) {}

  // -------------------------------------------------------------- grants

  /** Every grant on disk, split into ones that verify and ones that do not. */
  async loadGrants(now = Date.now()): Promise<VerifiedGrants> {
    const file = await readJsonFile<GrantsFile>(grantsFile(this.ctx), { version: 1, grants: [] });
    const result: VerifiedGrants = { valid: [], rejected: [] };

    for (const grant of Array.isArray(file.grants) ? file.grants : []) {
      const reason = this.verify(grant, now);
      if (reason) {
        result.rejected.push({
          grantId: String(grant?.grantId ?? '?'),
          integration: String(grant?.integration ?? '?'),
          reason,
        });
      } else {
        result.valid.push(grant);
      }
    }
    return result;
  }

  /** The valid grant for an integration, or null. Never returns an unverified grant. */
  async findActive(integration: IntegrationId, now = Date.now()): Promise<StoredGrant | null> {
    const { valid } = await this.loadGrants(now);
    return valid.find((grant) => grant.integration === integration) ?? null;
  }

  /** Why a grant is not usable, or null when it is. */
  verify(grant: StoredGrant, now = Date.now()): string | null {
    if (!grant || typeof grant !== 'object') return 'malformed grant';
    if (typeof grant.signature !== 'string' || !grant.signature) return 'unsigned';
    if (grant.deviceId !== this.signer.deviceId) return 'issued for a different device';
    if (grant.approvedOn !== 'workstation') return 'not approved on the workstation';
    if (!Array.isArray(grant.scopes) || !Array.isArray(grant.roots)) return 'malformed grant';

    const { signature, ...unsigned } = grant;
    let signatureOk = false;
    try {
      signatureOk = this.signer.verify(grantSigningPayload(unsigned), signature);
    } catch {
      signatureOk = false;
    }
    if (!signatureOk) return 'signature does not verify';

    const expires = Date.parse(grant.expiresAt);
    if (Number.isNaN(expires) || expires <= now) return 'expired';
    return null;
  }

  /** Sign and store a grant, replacing any earlier grant for the same integration. */
  async saveGrant(unsigned: Omit<StoredGrant, 'signature'>): Promise<StoredGrant> {
    const grant: StoredGrant = {
      ...unsigned,
      signature: this.signer.sign(grantSigningPayload(unsigned)),
    };
    const file = await readJsonFile<GrantsFile>(grantsFile(this.ctx), { version: 1, grants: [] });
    const others = (Array.isArray(file.grants) ? file.grants : []).filter(
      (existing) => existing?.integration !== grant.integration,
    );
    await writeJsonFileAtomic(grantsFile(this.ctx), { version: 1, grants: [...others, grant] });
    return grant;
  }

  /** Remove the grant for an integration. Returns whether one existed. */
  async removeGrant(integration: IntegrationId): Promise<boolean> {
    const file = await readJsonFile<GrantsFile>(grantsFile(this.ctx), { version: 1, grants: [] });
    const grants = Array.isArray(file.grants) ? file.grants : [];
    const remaining = grants.filter((grant) => grant?.integration !== integration);
    if (remaining.length === grants.length) return false;
    await writeJsonFileAtomic(grantsFile(this.ctx), { version: 1, grants: remaining });
    return true;
  }

  // ------------------------------------------------------------ requests

  async loadRequests(): Promise<PendingRequest[]> {
    const file = await readJsonFile<RequestsFile>(requestsFile(this.ctx), {
      version: 1,
      requests: [],
    });
    return Array.isArray(file.requests) ? file.requests : [];
  }

  async saveRequests(requests: PendingRequest[]): Promise<void> {
    // Keep decided requests for a day so `pnpm grants list` can show what
    // happened; older ones are dropped so the file cannot grow forever.
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const kept = requests.filter(
      (request) =>
        request.status === 'pending' ||
        Date.parse(request.decidedAt ?? request.receivedAt) > cutoff,
    );
    await writeJsonFileAtomic(requestsFile(this.ctx), { version: 1, requests: kept });
  }

  async findRequest(requestId: string): Promise<PendingRequest | null> {
    return (await this.loadRequests()).find((request) => request.requestId === requestId) ?? null;
  }

  async upsertRequest(request: PendingRequest): Promise<void> {
    const requests = await this.loadRequests();
    const index = requests.findIndex((existing) => existing.requestId === request.requestId);
    if (index === -1) requests.push(request);
    else requests[index] = request;
    await this.saveRequests(requests);
  }
}
