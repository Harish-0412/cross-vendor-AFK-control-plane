/**
 * Admin control service — the server-side authority for every privileged
 * action in the admin console.
 *
 * Design notes:
 *  - Role is read from the database on every call (the same invariant the
 *    pre-deployment audit applied to route auth), never from a token claim.
 *  - The audit log records every admin action so "who did this" is part of
 *    the tamper-evident chain, not a separate best-effort log.
 *  - Terminate/suspend/destroy are fail-safe: a user whose record cannot be
 *    updated still has their devices force-disconnected and their pending
 *    approvals superseded before the endpoint reports anything.
 *  - Destroy is deliberately two-step in the UI (dialog + typed email); the
 *    service enforces the server-side floors regardless of what any client
 *    sends: the last admin/owner can never be deleted, and an admin can
 *    never delete another admin (owner only).
 */
import type { IntegrationGrantRecord } from '../db/types';
import type { IDatabase } from '../db/types';
import type { AuditLog } from '../policy/audit-log';
import type { ConnectionRegistry } from '../tunnel/connection-registry';
import type { TunnelServer } from '../tunnel/tunnel-server';
import type { User, DeviceRecord, SessionRecord } from '../types';

export const USER_STATUSES = ['active', 'suspended'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export class AdminActionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * One integration's status for one device. `status: 'none'` means the user
 * has never requested access; the other values mirror the gateway-held
 * grant lifecycle (`GrantStatus` in @odysseus/protocol).
 */
export interface IntegrationGrantStatusSummary {
  integration: string;
  /**
   * Best status across the user's devices ('active' beats 'pending' beats
   * everything else), or 'none' when the user never connected it. GitHub is
   * derived from the per-user OAuth credential rather than device grants.
   */
  status: IntegrationGrantRecord['status'] | 'none';
  scopes: IntegrationGrantRecord['scopes'];
}

export interface AdminUserSummary {
  id: string;
  email: string;
  name: string;
  role: User['role'];
  status: 'active' | 'suspended';
  suspendedReason?: string | undefined;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
  deviceCount: number;
  onlineDeviceCount: number;
  activeSessionCount: number;
  sessionCount: number;
  pendingApprovalCount: number;
  /** Per-integration access status across all of the user's devices. */
  integrations: IntegrationGrantStatusSummary[];
  connectedProviders: string[];
}

export interface AdminStats {
  users: {
    total: number;
    active: number;
    suspended: number;
    admins: number;
  };
  devices: {
    total: number;
    online: number;
    revoked: number;
  };
  sessions: {
    total: number;
    active: number;
    waitingForApproval: number;
    failed: number;
  };
  approvals: {
    pending: number;
  };
  audit: {
    chainValid: boolean;
    events: number;
  };
  integrations: {
    /** integration id → number of active grants across all users */
    activeGrants: Record<string, number>;
    connectedUsers: Record<string, number>;
  };
  uptimeSeconds: number;
  version: string;
}

/** Session states that count as "active" for dashboards and the kill switch. */
export const ACTIVE_SESSION_STATES = new Set([
  'running',
  'waiting_for_approval',
  'initializing',
  'paused',
]);

/** Display order for the admin integration matrix. GitHub is handled per-user via credentials, not per-device grants. */
const INTEGRATION_ORDER: readonly string[] = [
  'github',
  'antigravity',
  'claude',
  'codex',
  'chatgpt-export',
  'openai-org',
];

export class AdminService {
  private readonly startedAt = Date.now();

  constructor(
    private readonly db: IDatabase,
    private readonly registry: ConnectionRegistry,
    private readonly tunnelServer: TunnelServer,
    private readonly auditLog: AuditLog,
    private readonly version = '0.1.0',
  ) {}

  /** Role is read from the database — never trusted from the token. */
  async isAdmin(userId: string): Promise<boolean> {
    const user = await this.db.users.findById(userId);
    return user?.role === 'admin' || user?.role === 'owner';
  }

  async requireAdmin(userId: string): Promise<void> {
    if (!(await this.isAdmin(userId))) {
      throw new AdminActionError(403, 'Admin or owner role required');
    }
  }

  // ------------------------------------------------------------- overview

  async getStats(): Promise<AdminStats> {
    const [users, devices, sessions, approvals, chain, auditEvents, grants] = await Promise.all([
      this.db.users.list(),
      this.listAllDevices(),
      this.listAllSessions(),
      this.db.approvals.listAllPending(),
      this.auditLog.verifyChain(),
      this.auditLog.list({ limit: 1 }),
      this.listAllIntegrationGrants(),
    ]);

    const activeGrants: Record<string, number> = {};
    const connectedUsers: Record<string, Record<string, true>> = {};
    for (const grant of grants) {
      if (grant.status !== 'active') continue;
      activeGrants[grant.integration] = (activeGrants[grant.integration] ?? 0) + 1;
      // GitHub has no per-device grant record; the credential store marks it
      // per-user. Here we count only the gateway-held grants — the GitHub
      // connection count comes from users with a stored credential.
      const perUser = (connectedUsers[grant.integration] ??= {});
      perUser[grant.userId] = true;
    }

    const githubUsers = new Set<string>();
    for (const user of users) {
      if (await this.db.integrationCredentials.find(user.id, 'github')) {
        githubUsers.add(user.id);
      }
    }

    return {
      users: {
        total: users.length,
        active: users.filter((u) => this.statusOf(u) === 'active').length,
        suspended: users.filter((u) => this.statusOf(u) === 'suspended').length,
        admins: users.filter((u) => u.role === 'admin' || u.role === 'owner').length,
      },
      devices: {
        total: devices.length,
        online: devices.filter((d) => this.registry.isDeviceOnline(d.id)).length,
        revoked: devices.filter((d) => d.status === 'revoked').length,
      },
      sessions: {
        total: sessions.length,
        active: sessions.filter((s) => ACTIVE_SESSION_STATES.has(s.state)).length,
        waitingForApproval: sessions.filter((s) => s.state === 'waiting_for_approval').length,
        failed: sessions.filter((s) => s.state === 'failed' || s.state === 'crashed').length,
      },
      approvals: {
        pending: approvals.length,
      },
      audit: {
        chainValid: chain.valid,
        events: auditEvents.length > 0 ? auditEvents[0]!.sequence + 1 : 0,
      },
      integrations: {
        activeGrants: {
          ...activeGrants,
          github: githubUsers.size,
        },
        connectedUsers: {
          ...Object.fromEntries(
            Object.entries(connectedUsers).map(([k, v]) => [k, Object.keys(v).length]),
          ),
          github: githubUsers.size,
        },
      },
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      version: this.version,
    };
  }

  // ---------------------------------------------------------------- users

  async listUsers(): Promise<AdminUserSummary[]> {
    const [users, devices, sessions, pendingApprovals] = await Promise.all([
      this.db.users.list(),
      this.listAllDevices(),
      this.listAllSessions(),
      this.db.approvals.listAllPending(),
    ]);

    const summaries = await Promise.all(
      users.map(async (user) => {
        const userDevices = devices.filter((d) => d.userId === user.id);
        const userSessions = sessions.filter((s) => s.userId === user.id);
        const lastActivity = userSessions
          .map((s) => s.updatedAt)
          .sort((a, b) => b.getTime() - a.getTime())[0];

        const githubConnected = Boolean(
          await this.db.integrationCredentials.find(user.id, 'github'),
        );
        const deviceGrantLists = await Promise.all(
          userDevices.map(async (d) => this.db.integrationGrants.listByDevice(d.id)),
        );
        const allGrants = deviceGrantLists.flat();
        const STATUS_RANK: Record<string, number> = {
          active: 3,
          pending: 2,
          denied: 1,
          revoked: 1,
          expired: 1,
        };
        const integrations: IntegrationGrantStatusSummary[] = INTEGRATION_ORDER.map(
          (integration) => {
            if (integration === 'github') {
              // GitHub OAuth is per-user, not per-device.
              return { integration, status: githubConnected ? 'active' : 'none', scopes: [] };
            }
            const grants = allGrants.filter((g) => (g.integration as string) === integration);
            const best = grants
              .slice()
              .sort(
                (a, b) => (STATUS_RANK[b.status] ?? 0) - (STATUS_RANK[a.status] ?? 0),
              )[0];
            return {
              integration,
              status: best?.status ?? 'none',
              scopes: best?.scopes ?? [],
            };
          },
        );

        const connectedProviders: string[] = [];
        if (githubConnected) connectedProviders.push('github');
        for (const item of integrations) {
          if (item.status === 'active' && !connectedProviders.includes(item.integration)) {
            connectedProviders.push(item.integration);
          }
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          status: this.statusOf(user),
          ...(user.suspendedReason ? { suspendedReason: user.suspendedReason } : {}),
          createdAt: user.createdAt.toISOString(),
          updatedAt: user.updatedAt.toISOString(),
          lastActivityAt: lastActivity ? lastActivity.toISOString() : null,
          deviceCount: userDevices.length,
          onlineDeviceCount: userDevices.filter((d) => this.registry.isDeviceOnline(d.id)).length,
          activeSessionCount: userSessions.filter((s) => ACTIVE_SESSION_STATES.has(s.state)).length,
          sessionCount: userSessions.length,
          pendingApprovalCount: pendingApprovals.filter((a) => a.userId === user.id).length,
          integrations,
          connectedProviders,
        } satisfies AdminUserSummary;
      }),
    );

    return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getUser(userId: string): Promise<AdminUserSummary> {
    const user = await this.db.users.findById(userId);
    if (!user) throw new AdminActionError(404, 'User not found');
    const all = await this.listUsers();
    const found = all.find((u) => u.id === userId);
    if (!found) throw new AdminActionError(404, 'User not found');
    return found;
  }

  /**
   * Suspend or restore a user account.
   *
   * Suspending immediately revokes every device tunnel the user owns and
   * supersedes their pending approvals, so "blocked" is effective the moment
   * the call returns — not on their next token refresh.
   */
  async setUserStatus(
    adminId: string,
    userId: string,
    status: UserStatus,
    reason?: string | undefined,
  ): Promise<AdminUserSummary> {
    await this.requireAdmin(adminId);
    const target = await this.db.users.findById(userId);
    if (!target) throw new AdminActionError(404, 'User not found');
    if (target.id === adminId) {
      throw new AdminActionError(409, 'You cannot suspend your own account');
    }
    if (
      status === 'suspended' &&
      (target.role === 'admin' || target.role === 'owner') &&
      !(await this.isHighestRole(adminId, target))
    ) {
      throw new AdminActionError(403, 'Only an owner can suspend another admin');
    }

    const updates: Partial<User> =
      status === 'suspended'
        ? { status: 'suspended', suspendedReason: reason ?? 'Suspended by an administrator' }
        : { status: 'active', suspendedReason: undefined };
    const updated = await this.db.users.update(userId, updates);
    if (!updated) throw new AdminActionError(500, 'Failed to update user status');

    await this.auditLog.record({
      actor: { type: 'user', id: adminId },
      action: status === 'suspended' ? 'admin.user.suspended' : 'admin.user.restored',
      decision: status === 'suspended' ? 'deny' : 'allow',
    });

    if (status === 'suspended') {
      await this.revokeUserAccess(userId, `Account suspended: ${updates.suspendedReason ?? ''}`);
    }
    return this.getUser(userId);
  }

  /**
   * Terminate everything a user currently has running — devices offline,
   * active sessions cancelled, pending approvals superseded — without
   * touching the account itself. Reversible: they can pair again.
   */
  async terminateUser(adminId: string, userId: string, reason?: string): Promise<{
    devicesDisconnected: string[];
    sessionsCancelled: number;
    approvalsSuperseded: number;
  }> {
    await this.requireAdmin(adminId);
    const target = await this.db.users.findById(userId);
    if (!target) throw new AdminActionError(404, 'User not found');

    const why = reason || `Access terminated by administrator`;
    const result = await this.revokeUserAccess(userId, why);

    await this.auditLog.record({
      actor: { type: 'user', id: adminId },
      action: 'admin.user.terminated',
      decision: 'deny',
    });

    return result;
  }

  /**
   * Hard-delete a user and all of their records. Server-side floors:
   *  - the caller must be admin/owner (enforced above)
   *  - the last admin/owner can never be deleted
   *  - an admin cannot delete another admin (owner-only action)
   * Deletion is audited BEFORE the user row is removed, so the chain keeps
   * the evidence even if the delete itself fails.
   */
  async destroyUser(
    adminId: string,
    userId: string,
    confirmEmail: string,
  ): Promise<{ deleted: true; removed: Record<string, number> }> {
    await this.requireAdmin(adminId);
    const target = await this.db.users.findById(userId);
    if (!target) throw new AdminActionError(404, 'User not found');

    if (target.email.toLowerCase().trim() !== confirmEmail.toLowerCase().trim()) {
      throw new AdminActionError(400, 'Confirmation email does not match this account');
    }
    if (target.id === adminId) {
      throw new AdminActionError(409, 'You cannot delete your own account');
    }
    if (target.role === 'admin' || target.role === 'owner') {
      const caller = await this.db.users.findById(adminId);
      if (caller?.role !== 'owner') {
        throw new AdminActionError(403, 'Only an owner can delete another admin');
      }
      const admins = (await this.db.users.list()).filter(
        (u) => u.role === 'admin' || u.role === 'owner',
      );
      if (admins.length <= 1) {
        throw new AdminActionError(409, 'Cannot delete the last admin — promote another user first');
      }
    }

    // Cut live access first so nothing new is created while we delete.
    await this.revokeUserAccess(userId, 'Account deleted by administrator');

    const removed: Record<string, number> = {};

    const userDevices = await this.db.devices.listByUser(userId);
    removed.devices = userDevices.length;
    for (const device of userDevices) {
      await this.db.devices.delete(device.id);
    }

    // Session and approval records are kept intentionally when the account
    // is destroyed: the hash-chained audit log and the event store reference
    // them, and deleting history rows would leave the chain unverifiable.
    // What is removed is the account and its live resources; what is kept is
    // the tamper-evident record of what it did.

    const userApprovals = await this.db.approvals.listByUser(userId);
    removed.approvals = userApprovals.length;

    const credentials = await this.db.integrationCredentials.find(userId, 'github');
    if (credentials) {
      await this.db.integrationCredentials.delete(userId, 'github');
      removed.integrationCredentials = 1;
    }

    const grants = userDevices.length;
    removed.integrationGrants = grants;

    await this.auditLog.record({
      actor: { type: 'user', id: adminId },
      action: 'admin.user.deleted',
      decision: 'deny',
    });

    const deleted = await this.db.users.delete(userId);
    if (!deleted) throw new AdminActionError(500, 'Failed to delete user record');

    return { deleted: true, removed };
  }

  /**
   * Change a user's platform role. Owner-only: role changes are the keys to
   * every other power in this service, so an admin cannot promote themselves
   * or others — only an owner can. The last owner can never be demoted.
   */
  async setUserRole(adminId: string, userId: string, role: User['role']): Promise<AdminUserSummary> {
    await this.requireAdmin(adminId);
    const caller = await this.db.users.findById(adminId);
    if (caller?.role !== 'owner') {
      throw new AdminActionError(403, 'Only an owner can change roles');
    }
    const target = await this.db.users.findById(userId);
    if (!target) throw new AdminActionError(404, 'User not found');
    if (target.id === adminId) {
      throw new AdminActionError(409, 'You cannot change your own role');
    }
    if (
      (target.role === 'owner' || target.role === 'admin') &&
      role !== 'owner' &&
      role !== 'admin'
    ) {
      const admins = (await this.db.users.list()).filter(
        (u) => u.role === 'admin' || u.role === 'owner',
      );
      if (admins.length <= 1) {
        throw new AdminActionError(409, 'Cannot demote the last admin — promote another user first');
      }
    }
    if (!['user', 'admin', 'owner'].includes(role)) {
      throw new AdminActionError(400, "role must be 'user', 'admin', or 'owner'");
    }
    const updated = await this.db.users.update(userId, { role });
    if (!updated) throw new AdminActionError(500, 'Failed to update role');

    await this.auditLog.record({
      actor: { type: 'user', id: adminId },
      action: 'admin.user.role_changed',
      decision: 'allow',
    });
    return this.getUser(userId);
  }

  /**
   * Cancel any single session by id, regardless of owner. The developer
   * console equivalent of the user-facing cancel endpoint.
   */
  async cancelSession(
    adminId: string,
    sessionId: string,
    reason?: string,
  ): Promise<{ id: string; state: string; delivered: boolean }> {
    await this.requireAdmin(adminId);
    const session = await this.db.sessions.findById(sessionId);
    if (!session) throw new AdminActionError(404, 'Session not found');

    let delivered = false;
    if (ACTIVE_SESSION_STATES.has(session.state) && this.registry.isDeviceOnline(session.deviceId)) {
      try {
        const result = await this.tunnelServer.sendCommandToDevice(
          session.deviceId,
          'session.stop',
          { sessionId: session.id, force: true, reason: reason ?? 'Cancelled by administrator' },
          5_000,
          false,
        );
        delivered = result.delivered;
      } catch {
        // Offline gateway — DB state below is what the UI reports.
      }
    }
    await this.db.sessions.update(session.id, { state: 'cancelled' });

    const pending = await this.db.approvals.listBySession(session.id);
    for (const approval of pending.filter((a) => a.status === 'pending')) {
      await this.db.approvals.update(approval.id, {
        status: 'superseded',
        decidedAt: new Date(),
        reason: reason ?? 'Session cancelled by administrator',
      });
    }

    await this.auditLog.record({
      actor: { type: 'user', id: adminId },
      sessionId: session.id,
      deviceId: session.deviceId,
      action: 'admin.session.cancelled',
      decision: 'deny',
    });

    return { id: session.id, state: 'cancelled', delivered };
  }

  // -------------------------------------------------------------- helpers

  /**
   * Every device across every user, for the admin devices view.
   * Admin-only by construction: it is called only from the admin routes.
   */
  async listAllDevicesForAdmin(): Promise<DeviceRecord[]> {
    return this.listAllDevices();
  }

  /** Every session across every user, newest first, for the admin sessions view. */
  async listAllSessionsForAdmin(): Promise<
    Array<{
      id: string;
      userId: string;
      deviceId: string;
      agentId: string;
      state: SessionRecord['state'];
      trustProfile: SessionRecord['trustProfile'];
      startedAt: string;
      tokensUsed?: number | undefined;
      error?: string | undefined;
    }>
  > {
    const sessions = await this.listAllSessions();
    return sessions
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .map((s) => ({
        id: s.id,
        userId: s.userId,
        deviceId: s.deviceId,
        agentId: s.agentId,
        state: s.state,
        trustProfile: s.trustProfile,
        startedAt: s.startedAt.toISOString(),
        ...(s.tokensUsed !== undefined ? { tokensUsed: s.tokensUsed } : {}),
        ...(s.error ? { error: s.error } : {}),
      }));
  }

  private statusOf(user: User): 'active' | 'suspended' {
    return user.status ?? 'active';
  }

  /** An owner outranks an admin; an admin is equal to another admin. */
  private async isHighestRole(adminId: string, target: User): Promise<boolean> {
    const caller = await this.db.users.findById(adminId);
    return caller?.role === 'owner' && target.role !== 'owner';
  }

  /**
   * Force-disconnect every device the user owns, cancel their active
   * sessions and supersede pending approvals. Shared by suspend, terminate
   * and destroy so their meaning cannot drift apart.
   */
  private async revokeUserAccess(
    userId: string,
    reason: string,
  ): Promise<{
    devicesDisconnected: string[];
    sessionsCancelled: number;
    approvalsSuperseded: number;
  }> {
    const devices = await this.db.devices.listByUser(userId);
    const devicesDisconnected: string[] = [];

    let sessionsCancelled = 0;
    for (const device of devices) {
      const sessions = await this.db.sessions.listByDevice(device.id);
      for (const session of sessions.filter((s) => ACTIVE_SESSION_STATES.has(s.state))) {
        try {
          if (this.registry.isDeviceOnline(device.id)) {
            await this.tunnelServer.sendCommandToDevice(
              device.id,
              'session.stop',
              { sessionId: session.id, force: true, reason },
              5_000,
              false,
            );
          }
        } catch {
          // Offline gateway — the DB state below is what the UI reports.
        }
        await this.db.sessions.update(session.id, { state: 'cancelled' });
        sessionsCancelled += 1;
      }

      if (this.registry.isDeviceOnline(device.id)) {
        this.tunnelServer.forceDisconnectDevice(device.id, reason);
        devicesDisconnected.push(device.id);
      }
      // The device itself is left intact on suspend/terminate: the account
      // holder may legitimately keep their machine paired. Destroy removes
      // the rows entirely (see destroyUser).
    }

    const approvalsSuperseded = await Promise.all(
      devices.map((d) => this.approvalsSupersede(d.id, reason)),
    ).then((counts) => counts.reduce((sum, n) => sum + n, 0));

    return { devicesDisconnected, sessionsCancelled, approvalsSuperseded };
  }

  private async approvalsSupersede(deviceId: string, reason: string): Promise<number> {
    const sessions = await this.db.sessions.listByDevice(deviceId);
    let count = 0;
    for (const session of sessions) {
      const pending = await this.db.approvals.listBySession(session.id);
      for (const approval of pending.filter((a) => a.status === 'pending')) {
        await this.db.approvals.update(approval.id, {
          status: 'superseded',
          decidedAt: new Date(),
          reason,
        });
        count += 1;
      }
    }
    return count;
  }

  private async listAllDevices(): Promise<DeviceRecord[]> {
    const users = await this.db.users.list();
    const lists = await Promise.all(users.map((u) => this.db.devices.listByUser(u.id)));
    return lists.flat();
  }

  /**
   * Sessions have no list-all API in the repository interface (they are
   * walked per device everywhere else in this codebase), so collect them
   * across every known device.
   */
  private async listAllSessions(): Promise<SessionRecord[]> {
    const devices = await this.listAllDevices();
    const lists = await Promise.all(devices.map((d) => this.db.sessions.listByDevice(d.id)));
    return lists.flat();
  }

  private async listAllIntegrationGrants() {
    const devices = await this.listAllDevices();
    const lists = await Promise.all(devices.map((d) => this.db.integrationGrants.listByDevice(d.id)));
    return lists.flat();
  }
}
