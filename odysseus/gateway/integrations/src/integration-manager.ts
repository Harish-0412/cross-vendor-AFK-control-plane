/**
 * Access requests, approvals and revocations for external integrations.
 *
 * The Control Plane can *ask* (`integration.grant_request`) and *revoke*
 * (`integration.revoke`). It cannot approve: approval exists only as a local
 * action, taken at an interactive terminal on this machine, with the
 * confirmation code shown in the requesting browser. There is deliberately no
 * command a remote party can send that results in a grant.
 */
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';

import {
  GRANT_REQUEST_TTL_MS,
  GRANT_TTL_MS,
  INTEGRATIONS,
  isIntegrationId,
  isIntegrationScope,
  type GrantRequestCommand,
  type IntegrationGrantState,
  type IntegrationId,
  type IntegrationScope,
  type IntegrationUpdate,
} from '@odysseus/protocol';

import { MAX_CONFIRMATION_ATTEMPTS, confirmationMatches } from './confirmation';
import { readJsonFile, writeJsonFileAtomic } from './atomic-file';
import { GrantGuard } from './grant-guard';
import { GrantStore, type DeviceSigner, type PendingRequest } from './grant-store';
import { connectionControlFile, displayPath, integrationRoots, type PathContext } from './paths';

export interface IntegrationManagerOptions {
  signer: DeviceSigner;
  ctx: PathContext;
  /** Called for every state change and refused read, to forward to the Control Plane. */
  onUpdate?: (update: IntegrationUpdate) => void;
  /** Running gateway callback for a terminate request written by the local CLI. */
  onLocalWebDisconnect?: (request: { id: string; requestedAt: string }) => void;
  now?: () => number;
}

export type ApproveResult =
  { ok: true; state: IntegrationGrantState } | { ok: false; reason: string; attemptsLeft?: number };

export class IntegrationManager {
  readonly store: GrantStore;
  readonly guard: GrantGuard;
  private readonly ctx: PathContext;
  private readonly now: () => number;
  private readonly onUpdate: (update: IntegrationUpdate) => void;
  private watchTimer: NodeJS.Timeout | undefined;
  private lastSnapshot = '';
  private lastWebDisconnectRequestId = '';
  private webControlInitialised = false;

  constructor(options: IntegrationManagerOptions) {
    this.ctx = options.ctx;
    this.now = options.now ?? Date.now;
    this.onUpdate = options.onUpdate ?? (() => undefined);
    this.onLocalWebDisconnect = options.onLocalWebDisconnect ?? (() => undefined);
    this.store = new GrantStore(options.ctx, options.signer);
    this.guard = new GrantGuard(
      this.store,
      (refusal) => this.onUpdate({ kind: 'access_refused', ...refusal }),
      this.now,
    );
    this.signerDeviceId = options.signer.deviceId;
  }

  private readonly signerDeviceId: string;
  private readonly onLocalWebDisconnect: (request: { id: string; requestedAt: string }) => void;

  // ------------------------------------------------------- remote: request

  /**
   * Record a request from the Control Plane. Nothing is granted: the request
   * waits for someone at this machine to approve it.
   */
  async receiveRequest(command: unknown): Promise<{ requestId: string; status: 'pending' }> {
    const request = this.validateRequest(command);

    const existing = await this.store.findRequest(request.requestId);
    if (existing) throw new Error(`Request ${request.requestId} was already received`);

    const pending: PendingRequest = {
      ...request,
      status: 'pending',
      receivedAt: new Date(this.now()).toISOString(),
      attempts: 0,
    };
    await this.store.upsertRequest(pending);

    this.emitState({
      integration: request.integration,
      status: 'pending',
      scopes: request.scopes,
      requestId: request.requestId,
      expiresAt: request.expiresAt,
    });
    return { requestId: request.requestId, status: 'pending' };
  }

  private validateRequest(command: unknown): GrantRequestCommand {
    const value = (command ?? {}) as Partial<GrantRequestCommand>;
    if (typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(value.requestId)) {
      throw new Error('Invalid requestId');
    }
    if (!isIntegrationId(value.integration)) throw new Error('Unknown integration');

    const offered = INTEGRATIONS[value.integration].scopes;
    const scopes = Array.isArray(value.scopes) ? value.scopes : [];
    if (scopes.length === 0) throw new Error('At least one scope is required');
    for (const scope of scopes) {
      if (!isIntegrationScope(scope) || !offered.includes(scope)) {
        throw new Error(`Scope ${String(scope)} is not offered by ${value.integration}`);
      }
    }

    const confirmation = value.confirmation;
    if (
      !confirmation ||
      typeof confirmation.salt !== 'string' ||
      confirmation.salt.length < 16 ||
      typeof confirmation.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(confirmation.sha256)
    ) {
      throw new Error('Request is missing its confirmation code hash');
    }

    // A request may not ask to stay open longer than the standard window —
    // a stale request is an opportunity for a mistaken approval later.
    const expires = Date.parse(value.expiresAt ?? '');
    const now = this.now();
    if (Number.isNaN(expires) || expires <= now || expires > now + GRANT_REQUEST_TTL_MS + 60_000) {
      throw new Error('Request expiry is missing or outside the allowed window');
    }

    const requestedBy = value.requestedBy;
    if (!requestedBy || typeof requestedBy.userId !== 'string' || !requestedBy.userId) {
      throw new Error('Request does not say which account made it');
    }

    return {
      requestId: value.requestId,
      integration: value.integration,
      scopes: [...new Set(scopes)] as IntegrationScope[],
      requestedBy: {
        userId: requestedBy.userId,
        ...(typeof requestedBy.email === 'string' ? { email: requestedBy.email } : {}),
      },
      confirmation: { salt: confirmation.salt, sha256: confirmation.sha256 },
      expiresAt: new Date(expires).toISOString(),
    };
  }

  // -------------------------------------------------- local: approve / deny

  /**
   * Approve a pending request. Only ever called from this machine.
   *
   * `interactive` must be true: callers pass whether stdin is a real terminal.
   * It is not a security boundary against software running as this user — that
   * software can read any file anyway — but it stops an agent from quietly
   * approving by running the command non-interactively.
   */
  async approve(
    requestId: string,
    typedCode: string,
    context: { interactive: boolean },
  ): Promise<ApproveResult> {
    if (!context.interactive) {
      return { ok: false, reason: 'Approval must be made at an interactive terminal' };
    }

    const request = await this.store.findRequest(requestId);
    if (!request) return { ok: false, reason: 'No such request' };
    if (request.status !== 'pending')
      return { ok: false, reason: `Request is already ${request.status}` };

    if (Date.parse(request.expiresAt) <= this.now()) {
      await this.decide(request, 'expired', 'Request expired before it was approved');
      return { ok: false, reason: 'Request expired' };
    }

    if (!confirmationMatches(typedCode, request.confirmation)) {
      request.attempts += 1;
      if (request.attempts >= MAX_CONFIRMATION_ATTEMPTS) {
        await this.decide(request, 'denied', 'Too many wrong confirmation codes');
        return { ok: false, reason: 'Too many wrong codes; the request was denied' };
      }
      await this.store.upsertRequest(request);
      return {
        ok: false,
        reason: 'That code does not match the one shown in the browser',
        attemptsLeft: MAX_CONFIRMATION_ATTEMPTS - request.attempts,
      };
    }

    const roots = await this.resolveRoots(request.integration);
    const grantedAt = new Date(this.now());
    const grant = await this.store.saveGrant({
      grantId: `grant_${randomUUID().replace(/-/g, '')}`,
      requestId: request.requestId,
      deviceId: this.signerDeviceId,
      userId: request.requestedBy.userId,
      integration: request.integration,
      scopes: request.scopes,
      roots,
      grantedAt: grantedAt.toISOString(),
      expiresAt: new Date(grantedAt.getTime() + GRANT_TTL_MS).toISOString(),
      approvedOn: 'workstation',
    });

    request.status = 'approved';
    request.decidedAt = grantedAt.toISOString();
    await this.store.upsertRequest(request);

    const state: IntegrationGrantState = {
      integration: grant.integration,
      status: 'active',
      scopes: grant.scopes,
      requestId: grant.requestId,
      grantId: grant.grantId,
      roots: grant.roots.map((root) => displayPath(root, this.ctx)),
      grantedAt: grant.grantedAt,
      expiresAt: grant.expiresAt,
    };
    this.emitState(state);
    return { ok: true, state };
  }

  async deny(requestId: string, reason = 'Denied at the workstation'): Promise<boolean> {
    const request = await this.store.findRequest(requestId);
    if (!request || request.status !== 'pending') return false;
    await this.decide(request, 'denied', reason);
    return true;
  }

  private async decide(
    request: PendingRequest,
    status: 'denied' | 'expired',
    reason: string,
  ): Promise<void> {
    request.status = status;
    request.decidedAt = new Date(this.now()).toISOString();
    request.reason = reason;
    await this.store.upsertRequest(request);
    this.emitState({
      integration: request.integration,
      status,
      scopes: request.scopes,
      requestId: request.requestId,
      reason,
    });
  }

  /**
   * The real directories a grant will cover. A root that does not exist is
   * left out rather than recorded as a promise — a grant should describe what
   * is actually there.
   */
  private async resolveRoots(integration: IntegrationId): Promise<string[]> {
    const resolved: string[] = [];
    for (const root of integrationRoots(integration, this.ctx)) {
      try {
        if ((await stat(root)).isDirectory()) resolved.push(await realpath(root));
      } catch {
        /* not present on this machine */
      }
    }
    return resolved;
  }

  // ------------------------------------------------------ revoke / list

  /** Revoke from either side. Returns whether a grant existed. */
  async revoke(integration: unknown, by: 'web' | 'workstation'): Promise<boolean> {
    if (!isIntegrationId(integration)) throw new Error('Unknown integration');
    const removed = await this.store.removeGrant(integration);

    // A pending request for the same integration is cancelled too, so a revoke
    // cannot be undone by an approval that was already waiting.
    for (const request of await this.store.loadRequests()) {
      if (request.integration === integration && request.status === 'pending') {
        await this.decide(request, 'denied', `Cancelled by revoke (${by})`);
      }
    }

    this.emitState({
      integration,
      status: 'revoked',
      scopes: [],
      reason: `Revoked from the ${by === 'web' ? 'web app' : 'workstation'}`,
    });
    return removed;
  }

  /** Current state of every integration, as this device sees it. */
  async list(): Promise<IntegrationGrantState[]> {
    const now = this.now();
    const { valid } = await this.store.loadGrants(now);
    const requests = await this.store.loadRequests();

    return (Object.keys(INTEGRATIONS) as IntegrationId[]).map((integration) => {
      const grant = valid.find((candidate) => candidate.integration === integration);
      if (grant) {
        return {
          integration,
          status: 'active' as const,
          scopes: grant.scopes,
          requestId: grant.requestId,
          grantId: grant.grantId,
          roots: grant.roots.map((root) => displayPath(root, this.ctx)),
          grantedAt: grant.grantedAt,
          expiresAt: grant.expiresAt,
        };
      }
      const pending = requests.find(
        (request) =>
          request.integration === integration &&
          request.status === 'pending' &&
          Date.parse(request.expiresAt) > now,
      );
      if (pending) {
        return {
          integration,
          status: 'pending' as const,
          scopes: pending.scopes,
          requestId: pending.requestId,
          expiresAt: pending.expiresAt,
        };
      }
      return { integration, status: 'revoked' as const, scopes: [] };
    });
  }

  async pendingRequests(): Promise<PendingRequest[]> {
    const now = this.now();
    return (await this.store.loadRequests()).filter(
      (request) => request.status === 'pending' && Date.parse(request.expiresAt) > now,
    );
  }

  /**
   * Ask the running gateway on this workstation to close every active web
   * client for the paired account. The request is a local mode-0600 file; it
   * grants no access and carries no cloud credential.
   */
  async requestLocalWebDisconnect(): Promise<string> {
    const id = `disconnect_${randomUUID().replace(/-/g, '')}`;
    await writeJsonFileAtomic(connectionControlFile(this.ctx), {
      version: 1,
      terminateRequest: { id, requestedAt: new Date(this.now()).toISOString() },
    });
    return id;
  }

  // ---------------------------------------------------------- lifecycle

  /** Expire stale requests. Grants expire on their own at verification time. */
  async sweep(): Promise<void> {
    const now = this.now();
    for (const request of await this.store.loadRequests()) {
      if (request.status === 'pending' && Date.parse(request.expiresAt) <= now) {
        await this.decide(request, 'expired', 'Not approved in time');
      }
    }
  }

  /**
   * Notice changes made by another process — `pnpm grants approve` runs
   * separately from the gateway — and report them. Polling a small file is
   * simpler and more reliable across platforms than fs.watch.
   */
  startWatching(intervalMs = 1500): void {
    if (this.watchTimer) return;
    const check = async () => {
      try {
        await this.sweep();
        await this.checkLocalWebControl();
        const snapshot = JSON.stringify(await this.list());
        if (this.lastSnapshot && snapshot !== this.lastSnapshot) {
          const previous = JSON.parse(this.lastSnapshot) as IntegrationGrantState[];
          for (const state of JSON.parse(snapshot) as IntegrationGrantState[]) {
            const before = previous.find(
              (candidate) => candidate.integration === state.integration,
            );
            if (JSON.stringify(before) !== JSON.stringify(state))
              this.onUpdate({ kind: 'grant_changed', state });
          }
        }
        this.lastSnapshot = snapshot;
      } catch {
        /* a transient read error is retried on the next tick */
      }
    };
    void check();
    this.watchTimer = setInterval(() => void check(), intervalMs);
    this.watchTimer.unref?.();
  }

  stopWatching(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = undefined;
  }

  private emitState(state: IntegrationGrantState): void {
    // Keep the watcher's snapshot in step, so a change this process made is
    // reported once, here, and not a second time by the watcher.
    void this.list()
      .then((all) => {
        this.lastSnapshot = JSON.stringify(all);
      })
      .catch(() => undefined);
    this.onUpdate({ kind: 'grant_changed', state });
  }

  private async checkLocalWebControl(): Promise<void> {
    const file = await readJsonFile<{
      terminateRequest?: { id?: unknown; requestedAt?: unknown };
    }>(connectionControlFile(this.ctx), {});
    const request = file.terminateRequest;
    const id = typeof request?.id === 'string' ? request.id : '';
    const requestedAt = typeof request?.requestedAt === 'string' ? request.requestedAt : '';

    // Treat the file present when the gateway starts as a baseline, not a new
    // instruction. This prevents an old request from kicking out a future web
    // session after a workstation reboot.
    if (!this.webControlInitialised) {
      this.webControlInitialised = true;
      this.lastWebDisconnectRequestId = id;
      return;
    }
    if (!id || id === this.lastWebDisconnectRequestId || !requestedAt) return;
    this.lastWebDisconnectRequestId = id;
    this.onLocalWebDisconnect({ id, requestedAt });
  }
}
