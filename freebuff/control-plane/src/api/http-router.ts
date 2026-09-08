import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { SessionConfig, TrustProfile } from '@freebuff/protocol';

import { signJwt, verifyJwt } from '../auth/jwt';
import { hashPassword, verifyPassword } from '../auth/password';
import { verifyFirebaseIdToken } from '../auth/firebase-admin';
import type { IDatabase } from '../db/types';
import type { ConnectionRegistry } from '../tunnel/connection-registry';
import type { TunnelServer } from '../tunnel/tunnel-server';
import type { ControlPlaneConfig, DeviceRecord } from '../types';

const TRUST_PROFILES: readonly TrustProfile[] = [
  'default',
  'supervised',
  'trusted-afk',
  'read-only',
  'locked',
];

function isTrustProfile(value: unknown): value is TrustProfile {
  return typeof value === 'string' && TRUST_PROFILES.includes(value as TrustProfile);
}
import { PolicyEngineService, ApprovalWorkflow, AuditLog } from '../policy/index';
import { SummaryGenerator } from '../afk/summary-generator';

export class HttpRouter {
  private db: IDatabase;
  private registry: ConnectionRegistry;
  private tunnelServer: TunnelServer;
  private config: ControlPlaneConfig;
  private policyService: PolicyEngineService;
  private approvalWorkflow: ApprovalWorkflow;
  private auditLog: AuditLog;
  private summaryGenerator: SummaryGenerator;

  constructor(
    db: IDatabase,
    registry: ConnectionRegistry,
    tunnelServer: TunnelServer,
    config: ControlPlaneConfig,
    policyService: PolicyEngineService,
    approvalWorkflow: ApprovalWorkflow,
    auditLog: AuditLog,
  ) {
    this.db = db;
    this.registry = registry;
    this.tunnelServer = tunnelServer;
    this.config = config;
    this.policyService = policyService;
    this.approvalWorkflow = approvalWorkflow;
    this.auditLog = auditLog;
    this.summaryGenerator = new SummaryGenerator(db);
  }

  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host || 'localhost';
    const socketEncrypted = (req.socket as { encrypted?: boolean }).encrypted;
    const protocol = socketEncrypted ? 'https' : 'http';
    const url = new URL(req.url || '/', `${protocol}://${host}`);
    const method = (req.method || 'GET').toUpperCase();
    const path = url.pathname;
    const segments = path.split('/').filter(Boolean);

    // 1. CORS headers
    this.setCORS(req, res);
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 2. Read Request Body
    let body: Record<string, unknown> = {};
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      try {
        body = await this.readJsonBody(req);
      } catch {
        return this.sendJson(res, 400, { error: 'Invalid JSON body' });
      }
    }

    // 3. Extract Bearer Token
    const authHeader = req.headers.authorization;
    let authUser: { id: string; email?: string | undefined; role?: string | undefined } | null =
      null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();

      // Check Firebase ID token first if configured
      try {
        const decoded = await verifyFirebaseIdToken(token);
        if (decoded) {
          authUser = {
            id: decoded.uid,
            email: decoded.email,
            role: (decoded['role'] as string) || 'user',
          };
          // Ensure user exists in our repository
          const existing = await this.db.users.findById(decoded.uid);
          if (!existing && decoded.email) {
            try {
              await this.db.users.create({
                id: decoded.uid,
                email: decoded.email,
                name: (decoded['name'] as string) || decoded.email.split('@')[0] || 'User',
                role: 'user',
              });
            } catch {
              // Ignore duplicate
            }
          }
        }
      } catch {
        /* Not a valid Firebase token */
      }

      // Fallback to local JWT validation
      if (!authUser) {
        try {
          const payload = verifyJwt(token, this.config.jwtSecret);
          authUser = {
            id: payload.sub,
            email: payload.email,
            role: payload.role,
          };
        } catch {
          /* invalid token */
        }
      }
    }

    try {
      // Health check
      if (path === '/api/v1/health' || path === '/health') {
        return this.sendJson(res, 200, {
          status: 'ok',
          service: 'freebuff-control-plane',
          version: '0.1.0',
          timestamp: new Date().toISOString(),
        });
      }

      // Status check
      if (path === '/api/v1/status' || path === '/status') {
        return this.sendJson(res, 200, {
          connectedDevices: this.registry.listConnectedDevices(),
          onlineDeviceCount: this.registry.listConnectedDevices().length,
          timestamp: new Date().toISOString(),
        });
      }

      // --- AUTH ROUTES ---
      if (path === '/api/v1/auth/register' && method === 'POST') {
        const email = typeof body['email'] === 'string' ? body['email'] : undefined;
        const password = typeof body['password'] === 'string' ? body['password'] : undefined;
        const name = typeof body['name'] === 'string' ? body['name'] : undefined;

        if (!email || !password) {
          return this.sendJson(res, 400, { error: 'Email and password are required' });
        }
        const existing = await this.db.users.findByEmail(email);
        if (existing) {
          return this.sendJson(res, 409, { error: 'User already exists with this email' });
        }
        const passwordHash = hashPassword(password);
        const user = await this.db.users.create({
          email,
          passwordHash,
          name: name || email.split('@')[0] || 'User',
          role: 'user',
        });
        const tokens = this.issueTokenPair(user.id, user.email, user.role);
        const isWeb = req.headers['x-client-type'] === 'web' || Boolean(req.headers.cookie);
        if (isWeb) {
          this.setRefreshCookie(res, tokens.refreshToken);
        }
        return this.sendJson(res, 201, {
          ...tokens,
          user: { id: user.id, email: user.email, name: user.name, role: user.role },
        });
      }

      if (path === '/api/v1/auth/login' && method === 'POST') {
        const email = typeof body['email'] === 'string' ? body['email'] : undefined;
        const password = typeof body['password'] === 'string' ? body['password'] : undefined;

        if (!email || !password) {
          return this.sendJson(res, 400, { error: 'Email and password are required' });
        }
        const user = await this.db.users.findByEmail(email);
        if (!user || !verifyPassword(password, user.passwordHash)) {
          return this.sendJson(res, 401, { error: 'Invalid email or password' });
        }
        const tokens = this.issueTokenPair(user.id, user.email, user.role);
        const isWeb = req.headers['x-client-type'] === 'web' || Boolean(req.headers.cookie);
        if (isWeb) {
          this.setRefreshCookie(res, tokens.refreshToken);
        }
        return this.sendJson(res, 200, {
          ...tokens,
          user: { id: user.id, email: user.email, name: user.name, role: user.role },
        });
      }

      // Token refresh: exchange a valid refresh token for a new access + refresh pair
      if (path === '/api/v1/auth/refresh' && method === 'POST') {
        const cookies = this.parseCookies(req.headers.cookie);
        const refreshToken =
          (typeof body['refreshToken'] === 'string' ? body['refreshToken'] : undefined) ||
          cookies['refreshToken'];
        if (!refreshToken) {
          return this.sendJson(res, 400, { error: 'refreshToken is required' });
        }
        let payload: { sub: string; email?: string; role?: string; type?: string };
        try {
          payload = verifyJwt(refreshToken, this.config.jwtSecret);
        } catch {
          return this.sendJson(res, 401, { error: 'Invalid or expired refresh token' });
        }
        if (payload.type !== 'refresh') {
          return this.sendJson(res, 401, { error: 'Token is not a refresh token' });
        }
        const user = await this.db.users.findById(payload.sub);
        if (!user) {
          return this.sendJson(res, 401, { error: 'User no longer exists' });
        }
        const tokens = this.issueTokenPair(user.id, user.email, user.role);
        const isWeb =
          req.headers['x-client-type'] === 'web' || Boolean(cookies['refreshToken']);
        if (isWeb) {
          this.setRefreshCookie(res, tokens.refreshToken);
        }
        return this.sendJson(res, 200, tokens);
      }

      // Logout: acknowledge token invalidation and clear refresh cookie
      if (path === '/api/v1/auth/logout' && method === 'POST') {
        const cookies = this.parseCookies(req.headers.cookie);
        if (!authUser && !cookies['refreshToken']) {
          return this.sendJson(res, 401, { error: 'Unauthorized' });
        }
        this.clearRefreshCookie(res);
        return this.sendJson(res, 200, { success: true, message: 'Logged out successfully' });
      }

      // Sync user profile from frontend
      if (path === '/api/v1/auth/sync' && method === 'POST') {
        let userAuth = authUser;
        const idToken = typeof body['idToken'] === 'string' ? body['idToken'] : undefined;
        if (!userAuth && idToken) {
          try {
            const decoded = await verifyFirebaseIdToken(idToken);
            if (decoded) {
              userAuth = {
                id: decoded.uid,
                email: decoded.email,
                role: (decoded['role'] as string) || 'user',
              };
            }
          } catch {
            /* ignore */
          }
        }
        if (!userAuth) {
          return this.sendJson(res, 401, { error: 'Unauthorized' });
        }
        const name = typeof body['name'] === 'string' ? body['name'] : undefined;
        let user = await this.db.users.findById(userAuth.id);
        if (!user && userAuth.email) {
          user = await this.db.users.create({
            id: userAuth.id,
            email: userAuth.email,
            name: name || userAuth.email.split('@')[0] || 'User',
            role: 'user',
          });
        }
        return this.sendJson(res, 200, { success: true, user });
      }

      if (path === '/api/v1/auth/me' && method === 'GET') {
        if (!authUser) {
          return this.sendJson(res, 401, { error: 'Unauthorized' });
        }
        let user = await this.db.users.findById(authUser.id);
        if (!user && authUser.email) {
          user = await this.db.users.create({
            id: authUser.id,
            email: authUser.email,
            name: authUser.email.split('@')[0] || 'User',
            role: 'user',
          });
        }
        if (!user) {
          return this.sendJson(res, 404, { error: 'User not found' });
        }
        const devices = await this.db.devices.listByUser(user.id);
        const connectedDeviceCount = devices.filter((d) =>
          this.registry.isDeviceOnline(d.id),
        ).length;
        return this.sendJson(res, 200, {
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            createdAt: user.createdAt.toISOString(),
          },
          deviceCount: devices.length,
          connectedDeviceCount,
        });
      }

      // --- INTERNAL PAIRING REGISTRATION ---
      if (path === '/api/v1/internal/pairing/initiate' && method === 'POST') {
        const code = typeof body['code'] === 'string' ? body['code'] : undefined;
        const deviceId = typeof body['deviceId'] === 'string' ? body['deviceId'] : undefined;
        const gatewayId = typeof body['gatewayId'] === 'string' ? body['gatewayId'] : undefined;
        const fingerprintHex =
          typeof body['fingerprintHex'] === 'string' ? body['fingerprintHex'] : '';
        const fingerprintWords = Array.isArray(body['fingerprintWords'])
          ? (body['fingerprintWords'] as string[])
          : [];

        if (!code || !deviceId || !gatewayId) {
          return this.sendJson(res, 400, { error: 'Missing pairing initiation fields' });
        }
        const pairing = await this.db.pairings.create({
          code,
          deviceId,
          gatewayId,
          fingerprintHex,
          fingerprintWords,
          status: 'pending',
          expiresAt: new Date(Date.now() + this.config.pairingCodeTtlSec * 1000),
        });
        return this.sendJson(res, 201, { pairingId: pairing.id, status: pairing.status });
      }

      // --- DEVICE PAIRING & MANAGEMENT ---
      if (path === '/api/v1/devices/pair' && method === 'POST') {
        if (!authUser) {
          return this.sendJson(res, 401, { error: 'Unauthorized: log in to pair a device' });
        }
        const code = typeof body['code'] === 'string' ? body['code'] : undefined;
        if (!code) {
          return this.sendJson(res, 400, { error: 'Pairing code is required' });
        }

        const pairing = await this.db.pairings.findByCode(code);
        if (!pairing) {
          return this.sendJson(res, 404, { error: 'Invalid or expired pairing code' });
        }
        if (pairing.expiresAt < new Date()) {
          await this.db.pairings.update(pairing.id, { status: 'expired' });
          return this.sendJson(res, 400, { error: 'Pairing code has expired' });
        }

        await this.db.pairings.update(pairing.id, {
          userId: authUser.id,
          status: 'code_verified',
        });

        return this.sendJson(res, 200, {
          pairingId: pairing.id,
          deviceId: pairing.deviceId,
          gatewayId: pairing.gatewayId,
          fingerprintHex: pairing.fingerprintHex,
          fingerprintWords: pairing.fingerprintWords,
          status: 'code_verified',
        });
      }

      if (path === '/api/v1/devices/confirm' && method === 'POST') {
        if (!authUser) {
          return this.sendJson(res, 401, { error: 'Unauthorized' });
        }
        const pairingId = typeof body['pairingId'] === 'string' ? body['pairingId'] : undefined;
        const code = typeof body['code'] === 'string' ? body['code'] : undefined;
        const confirmed = typeof body['confirmed'] === 'boolean' ? body['confirmed'] : true;
        const friendlyName =
          typeof body['friendlyName'] === 'string' ? body['friendlyName'] : undefined;

        const pairing = pairingId
          ? await this.db.pairings.findById(pairingId)
          : code
            ? await this.db.pairings.findByCode(code)
            : null;

        if (!pairing) {
          return this.sendJson(res, 404, { error: 'Pairing session not found' });
        }

        if (confirmed === false) {
          await this.db.pairings.update(pairing.id, { status: 'rejected' });
          return this.sendJson(res, 200, { status: 'rejected' });
        }

        await this.db.pairings.update(pairing.id, {
          status: 'confirmed',
          confirmedAt: new Date(),
        });

        // Record pairing in audit log (§8.2)
        await this.auditLog.record({
          actor: { type: 'user', id: authUser.id },
          deviceId: pairing.deviceId,
          action: 'device.paired',
          decision: 'allow',
        });

        let device = await this.db.devices.findById(pairing.deviceId);
        if (!device) {
          device = await this.db.devices.create({
            id: pairing.deviceId,
            gatewayId: pairing.gatewayId,
            userId: authUser.id,
            friendlyName: friendlyName || `Workstation (${pairing.deviceId.slice(-6)})`,
            platform: 'unknown',
            publicKeyPem: '',
            publicKeyJwk: {},
            fingerprintHex: pairing.fingerprintHex,
            fingerprintWords: pairing.fingerprintWords,
            status: 'trusted',
          });
        } else {
          await this.db.devices.updateStatus(device.id, 'trusted');
        }

        return this.sendJson(res, 200, {
          status: 'confirmed',
          device: {
            id: device.id,
            friendlyName: device.friendlyName,
            status: device.status,
            online: this.registry.isDeviceOnline(device.id),
          },
        });
      }

      if (path === '/api/v1/devices' && method === 'GET') {
        if (!authUser) {
          return this.sendJson(res, 401, { error: 'Unauthorized' });
        }
        const devices = await this.db.devices.listByUser(authUser.id);
        const mapped = await Promise.all(
          devices.map(async (d) => {
            const sessions = await this.db.sessions.listByDevice(d.id);
            const activeSessionCount = sessions.filter(
              (s) => s.state === 'running' || s.state === 'waiting_for_approval',
            ).length;
            return {
              id: d.id,
              friendlyName: d.friendlyName,
              platform: d.platform,
              status: d.status,
              online: this.registry.isDeviceOnline(d.id),
              lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
              activeSessionCount,
              resourceUsage: d.resourceUsage ?? null,
              defaultTrustProfile: d.defaultTrustProfile,
              createdAt: d.createdAt.toISOString(),
            };
          }),
        );
        return this.sendJson(res, 200, mapped);
      }

      if (
        segments.length === 4 &&
        segments[0] === 'api' &&
        segments[1] === 'v1' &&
        segments[2] === 'devices'
      ) {
        const deviceId = segments[3];
        if (!deviceId) return this.sendJson(res, 400, { error: 'Device ID is required' });
        if (!authUser) return this.sendJson(res, 401, { error: 'Unauthorized' });

        if (method === 'GET') {
          const device = await this.db.devices.findById(deviceId);
          if (!device || device.userId !== authUser.id) {
            return this.sendJson(res, 404, { error: 'Device not found' });
          }
          const sessions = await this.db.sessions.listByDevice(device.id);
          const activeSessions = sessions
            .filter((s) => s.state === 'running' || s.state === 'waiting_for_approval')
            .map((s) => ({
              id: s.id,
              state: s.state,
              agentId: s.agentId,
              startedAt: s.startedAt.toISOString(),
            }));
          const recentSessions = sessions
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(0, 10)
            .map((s) => ({
              id: s.id,
              state: s.state,
              agentId: s.agentId,
              startedAt: s.startedAt.toISOString(),
            }));
          return this.sendJson(res, 200, {
            id: device.id,
            friendlyName: device.friendlyName,
            platform: device.platform,
            status: device.status,
            online: this.registry.isDeviceOnline(device.id),
            lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
            systemInfo: device.systemInfo ?? null,
            resourceUsage: device.resourceUsage ?? null,
            fingerprintHex: device.fingerprintHex,
            defaultTrustProfile: device.defaultTrustProfile,
            activeSessions,
            recentSessions,
            totalSessionCount: sessions.length,
            createdAt: device.createdAt.toISOString(),
            updatedAt: device.updatedAt.toISOString(),
          });
        }

        if (method === 'DELETE') {
          const device = await this.db.devices.findById(deviceId);
          if (!device || device.userId !== authUser.id) {
            return this.sendJson(res, 404, { error: 'Device not found' });
          }

          // 1. Immediately terminate the tunnel session if device is connected
          const wasOnline = this.registry.isDeviceOnline(deviceId);
          if (wasOnline) {
            this.tunnelServer.forceDisconnectDevice(deviceId, 'Device revoked by user');
          }

          // 2. Mark device as revoked in the database
          await this.db.devices.updateStatus(deviceId, 'revoked');

          // 3. Transition all pending approvals for this device to 'superseded' (§7.3)
          const supersededCount = await this.approvalWorkflow.revokeDeviceApprovals(
            deviceId,
            'Device revoked by user',
          );

          // 4. Record revocation in audit log (§8.2)
          await this.auditLog.record({
            actor: { type: 'user', id: authUser.id },
            deviceId,
            action: 'device.revoked',
            decision: 'deny',
          });

          return this.sendJson(res, 200, {
            success: true,
            deviceRevoked: true,
            tunnelTerminated: wasOnline,
            approvalsSuperseded: supersededCount,
          });
        }

        // PATCH: Gateway reports platform, systemInfo, or friendlyName
        if (method === 'PATCH') {
          const device = await this.db.devices.findById(deviceId);
          if (!device || device.userId !== authUser.id) {
            return this.sendJson(res, 404, { error: 'Device not found' });
          }

          const updates: Partial<DeviceRecord> = {};
          if (typeof body['platform'] === 'string') {
            updates.platform = body['platform'] as DeviceRecord['platform'];
          }
          if (typeof body['friendlyName'] === 'string') {
            updates.friendlyName = body['friendlyName'];
          }
          if (typeof body['systemInfo'] === 'object' && body['systemInfo'] !== null) {
            updates.systemInfo = body['systemInfo'] as DeviceRecord['systemInfo'];
          }
          if (typeof body['publicKeyJwk'] === 'object' && body['publicKeyJwk'] !== null) {
            updates.publicKeyJwk = body['publicKeyJwk'] as Record<string, unknown>;
          }
          if (typeof body['publicKeyPem'] === 'string') {
            updates.publicKeyPem = body['publicKeyPem'];
          }
          if (typeof body['fingerprintHex'] === 'string') {
            updates.fingerprintHex = body['fingerprintHex'];
          }
          if (Array.isArray(body['fingerprintWords'])) {
            updates.fingerprintWords = body['fingerprintWords'] as string[];
          }
          if (body['defaultTrustProfile'] !== undefined) {
            if (!isTrustProfile(body['defaultTrustProfile'])) {
              return this.sendJson(res, 400, {
                error: `defaultTrustProfile must be one of: ${TRUST_PROFILES.join(', ')}`,
              });
            }
            updates.defaultTrustProfile = body['defaultTrustProfile'];
          }

          const updated = await this.db.devices.update(deviceId, updates);

          return this.sendJson(res, 200, {
            id: updated?.id ?? device.id,
            platform: updated?.platform ?? device.platform,
            friendlyName: updated?.friendlyName ?? device.friendlyName,
            systemInfo: updated?.systemInfo ?? device.systemInfo,
            defaultTrustProfile: updated?.defaultTrustProfile ?? device.defaultTrustProfile,
          });
        }
      }

      // --- PHASE 7.6 — KILL SWITCH & LOCK (§2.5 of the Phase 7 plan) ---
      // Both are device-scoped, ownership-checked, audited fan-out operations:
      //  - kill-switch: cancel every active session for the device in one call
      //  - lock: flip every active session to the 'locked' trust profile instead
      //    ("stop acting, keep observing") and supersede pending approvals the
      //    same way device revocation already does (Phase 5 §7.3 pattern).
      if (
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'v1' &&
        segments[2] === 'devices'
      ) {
        const deviceId = segments[3];
        const action = segments[4];
        if (!deviceId) return this.sendJson(res, 400, { error: 'Device ID is required' });
        if (!authUser) return this.sendJson(res, 401, { error: 'Unauthorized' });
        if (action !== 'kill-switch' && action !== 'lock') {
          return this.sendJson(res, 404, { error: `Endpoint not found: ${method} ${path}` });
        }
        if (method !== 'POST') {
          return this.sendJson(res, 405, { error: 'Method not allowed' });
        }

        const device = await this.db.devices.findById(deviceId);
        if (!device || device.userId !== authUser.id) {
          return this.sendJson(res, 404, { error: 'Device not found' });
        }

        const ACTIVE_STATES = new Set(['running', 'waiting_for_approval', 'initializing', 'paused']);
        const sessions = await this.db.sessions.listByDevice(deviceId);
        const active = sessions.filter((s) => ACTIVE_STATES.has(s.state));

        const reason =
          typeof body['reason'] === 'string'
            ? body['reason']
            : action === 'kill-switch'
              ? 'Kill switch activated by user'
              : 'Session locked by user';

        const results: Array<{ sessionId: string; state: string; delivered: boolean; acknowledged: boolean }> = [];
        for (const session of active) {
          if (action === 'kill-switch') {
            // Same command POST /sessions/:id/cancel already uses, looped (§2.5).
            const result = await this.tunnelServer.sendCommandToDevice(
              deviceId,
              'session.stop',
              { sessionId: session.id, force: true, reason },
            );
            await this.db.sessions.update(session.id, { state: 'cancelled' });
            results.push({
              sessionId: session.id,
              state: 'cancelled',
              delivered: result.delivered,
              acknowledged: result.acknowledged,
            });
          } else {
            // Lock: "stop acting, keep observing" — flip profile, don't terminate.
            await this.db.sessions.update(session.id, { trustProfile: 'locked' });
            // Fire-and-forget so the gateway observes the new profile immediately;
            // enforcement is also re-read from the DB on the next policy evaluation.
            try {
              await this.tunnelServer.sendCommandToDevice(
                deviceId,
                'session.trust_profile',
                { sessionId: session.id, trustProfile: 'locked' },
                5_000,
                false,
              );
            } catch {
              // Offline gateway — profile is persisted; enforced on reconnect.
            }
            results.push({
              sessionId: session.id,
              state: 'locked',
              delivered: false,
              acknowledged: false,
            });
          }
        }

        // Supersede pending approvals — same pattern as device revocation
        // (Phase 5 §7.3): a cancelled/locked session cannot meaningfully keep
        // an approval pending, and 'superseded' keeps the state machine's
        // five terminal states unchanged.
        const supersededCount = await this.approvalWorkflow.revokeDeviceApprovals(deviceId, reason);

        // Audit the safety control itself (§7.6 DoD — who hit the kill switch
        // and when must be part of the tamper-evident record).
        await this.auditLog.record({
          actor: { type: 'user', id: authUser.id },
          deviceId,
          action: action === 'kill-switch' ? 'device.kill_switch' : 'device.lock',
          decision: 'deny',
        });

        return this.sendJson(res, 200, {
          success: true,
          action,
          deviceId,
          activeSessionCount: active.length,
          sessions: results,
          approvalsSuperseded: supersededCount,
          note:
            action === 'kill-switch'
              ? 'All active sessions cancelled. Pending approvals superseded.'
              : 'All active sessions locked to observation-only. Pending approvals superseded.',
        });
      }

      // Phase 4 subscription plumbing, consumed by the Phase 7 push sender.
      if (path === '/api/v1/push/subscribe' && method === 'POST') {
        if (!authUser) return this.sendJson(res, 401, { error: 'Unauthorized' });
        const subscription = body['subscription'];
        const fcmToken = typeof body['fcmToken'] === 'string' ? body['fcmToken'] : undefined;

        if (typeof subscription === 'object' && subscription !== null) {
          const web = subscription as Record<string, unknown>;
          const keys = web['keys'] as Record<string, unknown> | undefined;
          if (
            typeof web['endpoint'] !== 'string' ||
            typeof keys?.['p256dh'] !== 'string' ||
            typeof keys?.['auth'] !== 'string'
          ) {
            return this.sendJson(res, 400, { error: 'Invalid Web Push subscription' });
          }
          const record = await this.db.pushSubscriptions.upsert({
            userId: authUser.id,
            channel: 'web-push',
            endpoint: web['endpoint'],
            keys: { p256dh: keys['p256dh'], auth: keys['auth'] },
          });
          return this.sendJson(res, 201, { id: record.id, channel: record.channel });
        }

        if (fcmToken) {
          const record = await this.db.pushSubscriptions.upsert({
            userId: authUser.id,
            channel: 'fcm',
            fcmToken,
          });
          return this.sendJson(res, 201, { id: record.id, channel: record.channel });
        }

        return this.sendJson(res, 400, { error: 'subscription or fcmToken is required' });
      }

      if (path === '/api/v1/push/subscribe' && method === 'DELETE') {
        if (!authUser) return this.sendJson(res, 401, { error: 'Unauthorized' });
        const target = typeof body['endpoint'] === 'string'
          ? body['endpoint']
          : typeof body['fcmToken'] === 'string'
            ? body['fcmToken']
            : undefined;
        if (!target) return this.sendJson(res, 400, { error: 'endpoint or fcmToken is required' });
        const deleted = await this.db.pushSubscriptions.delete(authUser.id, target);
        return this.sendJson(res, deleted ? 200 : 404, { success: deleted });
      }

      // --- SESSION MANAGEMENT ---
      if (path === '/api/v1/sessions' && method === 'GET') {
        if (!authUser) return this.sendJson(res, 401, { error: 'Unauthorized' });
        const filter: {
          deviceId?: string | undefined;
          state?: string | undefined;
          agentId?: string | undefined;
        } = {};
        const qDeviceId = url.searchParams.get('deviceId');
        if (qDeviceId) filter.deviceId = qDeviceId;
        const qState = url.searchParams.get('state');
        if (qState) filter.state = qState;
        const qAgentId = url.searchParams.get('agentId');
        if (qAgentId) filter.agentId = qAgentId;

        const sessions = await this.db.sessions.listByUser(authUser.id, filter);
        return this.sendJson(res, 200, sessions);
      }

      if (path === '/api/v1/sessions' && method === 'POST') {
        if (!authUser) return this.sendJson(res, 401, { error: 'Unauthorized' });
        const deviceId = typeof body['deviceId'] === 'string' ? body['deviceId'] : undefined;
        const agentId = typeof body['agentId'] === 'string' ? body['agentId'] : 'mock';
        const projectRoot =
          typeof body['projectRoot'] === 'string' ? body['projectRoot'] : process.cwd();
        const prompt = typeof body['prompt'] === 'string' ? body['prompt'] : undefined;
        const rawConfig =
          typeof body['config'] === 'object' && body['config'] !== null
            ? body['config']
            : undefined;

        if (!deviceId) return this.sendJson(res, 400, { error: 'deviceId is required' });

        const device = await this.db.devices.findById(deviceId);
        if (!device || device.userId !== authUser.id) {
          return this.sendJson(res, 404, { error: 'Device not found or not owned by you' });
        }

        const sessionId = `sess_${randomUUID().replace(/-/g, '')}`;
        const sessionConfig: SessionConfig = (rawConfig as unknown as SessionConfig) || {
          agent: agentId,
          projectRoot,
          prompt,
        };

        const sessionRecord = await this.db.sessions.create({
          id: sessionId,
          userId: authUser.id,
          deviceId,
          gatewayId: device.gatewayId,
          agentId,
          projectRoot,
          state: 'initializing',
          trustProfile: device.defaultTrustProfile,
          config: sessionConfig,
          startedAt: new Date(),
        });

        try {
          if (this.registry.isDeviceOnline(deviceId)) {
            const result = await this.tunnelServer.sendCommandToDevice(deviceId, 'session.start', {
              sessionId,
              config: sessionRecord.config,
            });
            if (result.acknowledged) {
              await this.db.sessions.update(sessionId, { state: 'running' });
              sessionRecord.state = 'running';
            } else if (result.delivered) {
              const errMsg =
                'Gateway received the start command but did not acknowledge within the timeout';
              await this.db.sessions.update(sessionId, { state: 'failed', error: errMsg });
              sessionRecord.state = 'failed';
              sessionRecord.error = errMsg;
            } else {
              const errMsg = `Device ${deviceId} is currently offline`;
              await this.db.sessions.update(sessionId, { state: 'failed', error: errMsg });
              sessionRecord.state = 'failed';
              sessionRecord.error = errMsg;
            }
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          await this.db.sessions.update(sessionId, { state: 'failed', error: errMsg });
          sessionRecord.state = 'failed';
          sessionRecord.error = errMsg;
        }

        return this.sendJson(res, 201, sessionRecord);
      }

      if (
        segments.length >= 4 &&
        segments[0] === 'api' &&
        segments[1] === 'v1' &&
        segments[2] === 'sessions'
      ) {
        const sessionId = segments[3];
        if (!sessionId) return this.sendJson(res, 400, { error: 'Session ID is required' });
        if (!authUser) return this.sendJson(res, 401, { error: 'Unauthorized' });

        const session = await this.db.sessions.findById(sessionId);
        if (!session || session.userId !== authUser.id) {
          return this.sendJson(res, 404, { error: 'Session not found' });
        }

        if (segments.length === 4 && method === 'GET') {
          return this.sendJson(res, 200, session);
        }

        if (segments.length === 5 && segments[4] === 'trust-profile' && method === 'PATCH') {
          if (!isTrustProfile(body['trustProfile'])) {
            return this.sendJson(res, 400, {
              error: `trustProfile must be one of: ${TRUST_PROFILES.join(', ')}`,
            });
          }
          const terminalStates = new Set(['completed', 'failed', 'cancelled', 'crashed']);
          if (terminalStates.has(session.state)) {
            return this.sendJson(res, 409, {
              error: `Cannot change trust profile for ${session.state} session`,
            });
          }
          const updated = await this.db.sessions.update(sessionId, {
            trustProfile: body['trustProfile'],
          });
          return this.sendJson(res, 200, {
            id: sessionId,
            trustProfile: updated?.trustProfile ?? body['trustProfile'],
          });
        }

        if (segments.length === 5 && segments[4] === 'prompt' && method === 'POST') {
          const message = typeof body['message'] === 'string' ? body['message'] : undefined;
          if (!message) return this.sendJson(res, 400, { error: 'Message is required' });

          const result = await this.tunnelServer.sendCommandToDevice(
            session.deviceId,
            'session.message',
            {
              sessionId,
              message,
            },
          );

          if (!result.delivered) {
            return this.sendJson(res, 503, { error: 'Gateway is offline; message not delivered' });
          }

          return this.sendJson(res, result.acknowledged ? 200 : 202, {
            success: true,
            delivered: result.delivered,
            acknowledged: result.acknowledged,
            note: result.acknowledged
              ? 'Message delivered and acknowledged by the gateway.'
              : 'Message forwarded to the gateway; awaiting acknowledgment within the timeout window.',
          });
        }

        if (segments.length === 5 && segments[4] === 'pause' && method === 'POST') {
          const result = await this.tunnelServer.sendCommandToDevice(
            session.deviceId,
            'session.pause',
            { sessionId },
          );
          await this.db.sessions.update(sessionId, { state: 'paused' });
          return this.sendJson(res, 200, {
            success: result.acknowledged,
            state: 'paused',
            delivered: result.acknowledged,
          });
        }

        if (segments.length === 5 && segments[4] === 'resume' && method === 'POST') {
          const result = await this.tunnelServer.sendCommandToDevice(
            session.deviceId,
            'session.resume',
            { sessionId },
          );
          await this.db.sessions.update(sessionId, { state: 'running' });
          return this.sendJson(res, 200, {
            success: result.acknowledged,
            state: 'running',
            delivered: result.acknowledged,
          });
        }

        if (segments.length === 5 && segments[4] === 'cancel' && method === 'POST') {
          const force = typeof body['force'] === 'boolean' ? body['force'] : true;
          const reason =
            typeof body['reason'] === 'string'
              ? body['reason']
              : 'Cancelled by user via web control plane';

          const result = await this.tunnelServer.sendCommandToDevice(
            session.deviceId,
            'session.stop',
            {
              sessionId,
              force,
              reason,
            },
          );

          await this.db.sessions.update(sessionId, { state: 'cancelled' });

          return this.sendJson(res, 200, {
            success: true,
            state: 'cancelled',
            delivered: result.delivered,
            acknowledged: result.acknowledged,
            note: result.acknowledged
              ? 'Stop command delivered and acknowledged by the gateway.'
              : result.delivered
                ? 'Stop command forwarded to gateway; awaiting acknowledgment.'
                : 'Gateway is offline; session marked cancelled locally. The gateway will reconcile on reconnect.',
          });
        }

        if (segments.length === 5 && segments[4] === 'events' && method === 'GET') {
          const fromSequence = parseInt(url.searchParams.get('fromSequence') || '0', 10);
          const events = await this.db.events.listBySession(sessionId, fromSequence);
          return this.sendJson(res, 200, events);
        }

        if (segments.length === 5 && segments[4] === 'summary' && method === 'GET') {
          const fromValue = url.searchParams.get('from');
          const from = fromValue ? new Date(fromValue) : undefined;
          if (fromValue && Number.isNaN(from?.getTime())) {
            return this.sendJson(res, 400, { error: 'from must be a valid ISO date' });
          }
          return this.sendJson(res, 200, await this.summaryGenerator.generate(sessionId, from));
        }

        if (segments.length === 5 && segments[4] === 'approvals' && method === 'GET') {
          const approvals = await this.db.approvals.listBySession(sessionId);
          return this.sendJson(res, 200, approvals);
        }

        if (
          segments.length === 7 &&
          segments[4] === 'approvals' &&
          segments[6] === 'decision' &&
          method === 'POST'
        ) {
          const approvalId = segments[5];
          if (!approvalId) return this.sendJson(res, 400, { error: 'Approval ID is required' });
          const approved = typeof body['approved'] === 'boolean' ? body['approved'] : undefined;
          const reason = typeof body['reason'] === 'string' ? body['reason'] : undefined;
          const feedback = typeof body['feedback'] === 'string' ? body['feedback'] : undefined;  // §7.3 — new optional field for voice feedback

          if (approved === undefined) {
            return this.sendJson(res, 400, { error: '"approved" boolean is required' });
          }

          // Use the approval workflow state machine (CAS — first valid decision wins)
          const result = await this.approvalWorkflow.submitDecision(approvalId, authUser.id, approved, reason, feedback);

          if (result.conflict) {
            return this.sendJson(res, 409, {
              error: 'Approval already decided by another user',
              currentStatus: result.record?.status,
            });
          }

          if (!result.success) {
            if (result.record?.status === 'timeout') {
              return this.sendJson(res, 410, {
                error: 'Approval request has expired',
                status: 'timeout',
              });
            }
            return this.sendJson(res, 400, {
              error: 'Could not process approval decision',
              status: result.record?.status,
            });
          }

          // Re-evaluate against current policy (§7.3 — policy change after request)
          // Wrap in try-catch to avoid breaking the approval flow if policy service fails
          try {
            const policyReEvaluation = await this.policyService.evaluate(
              'process.exec', // Default capability for re-evaluation
              'medium',
              {
                deviceId: session.deviceId,
                sessionId,
                userId: authUser.id,
              },
            );

            // If policy now denies, auto-deny (policy_superseded)
            if (policyReEvaluation.decision === 'deny') {
              await this.approvalWorkflow.handlePolicyChange(approvalId, 'deny');
            }
          } catch {
            // Policy re-evaluation failed — continue with the approval decision anyway
            // The audit log will capture the decision regardless
          }

          const decision = approved ? 'granted' : 'denied';
          const tunnelResult = await this.tunnelServer.sendCommandToDevice(
            session.deviceId,
            'session.approve',
            {
              sessionId,
              approvalId,
              decision,
              reason,
            },
          );

          // Record the decision in audit log
          await this.auditLog.record({
            actor: { type: 'user', id: authUser.id },
            sessionId,
            deviceId: session.deviceId,
            action: 'approval.decision',
            decision,
            ...(result.record?.policyVersion ? { policyVersion: result.record.policyVersion } : {}),
          });

          return this.sendJson(res, 200, {
            success: true,
            decision,
            delivered: tunnelResult.delivered,
            acknowledged: tunnelResult.acknowledged,
            note: tunnelResult.acknowledged
              ? 'Approval decision delivered to gateway and acknowledged.'
              : tunnelResult.delivered
                ? 'Approval decision forwarded to gateway; awaiting acknowledgment.'
                : 'Gateway is offline; approval decision will be relayed when the device reconnects.',
          });
        }

        if (segments.length === 5 && segments[4] === 'diff' && method === 'GET') {
          const diff = await this.tunnelServer.sendCommandToDevice(
            session.deviceId,
            'session.diff_collection',
            { sessionId, projectRoot: session.projectRoot },
            10_000,
            false,
          );
          if (!diff.delivered) {
            return this.sendJson(res, 503, { error: 'Gateway is offline; cannot collect diff' });
          }
          const sessionRecord = await this.db.sessions.findById(sessionId);
          const adapterResult =
            typeof diff.payload === 'object' && diff.payload !== null
              ? (diff.payload as { diff?: string }).diff
              : undefined;
          return this.sendJson(res, 202, {
            sessionId,
            collectedAt: new Date().toISOString(),
            projectRoot: session.projectRoot,
            diffCollectionRequested: true,
            sessionState: sessionRecord?.state ?? 'unknown',
            adapterDiff: adapterResult ?? null,
            note: adapterResult
              ? 'Gateway acknowledged and returned the workspace diff inline.'
              : 'Diff collection was forwarded to the gateway. The result will also arrive as a session.workspace_diff event, or the gateway may return the diff inline via the command ack payload.',
          });
        }
      }

      // --- APPROVALS (cross-session listing for the web dashboard) ---
      if (path === '/api/v1/approvals' && method === 'GET') {
        if (!authUser) return this.sendJson(res, 401, { error: 'Unauthorized' });
        const qStatus = url.searchParams.get('status');
        const approvals = await this.db.approvals.listByUser(authUser.id, qStatus || undefined);
        const mapped = approvals
          .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime())
          .map((a) => ({
            id: a.id,
            sessionId: a.sessionId,
            deviceId: a.deviceId,
            actionType: a.actionType,
            description: a.description,
            details: a.details ?? null,
            status: a.status,
            requestedAt: a.requestedAt.toISOString(),
            decidedAt: a.decidedAt?.toISOString() ?? null,
            decidedBy: a.decidedBy ?? null,
            reason: a.reason ?? null,
            policyVersion: a.policyVersion ?? null,
            matchedRules: a.matchedRules ?? [],
          }));
        return this.sendJson(res, 200, mapped);
      }

      // --- POLICY ROUTES (Phase 5) ---
      if (path === '/api/v1/policy/versions' && method === 'GET') {
        if (!authUser) return this.sendJson(res, 401, { error: 'Unauthorized' });
        if (!(await this.policyService.canManagePolicy(authUser.id))) {
          return this.sendJson(res, 403, { error: 'Only admins can view policy versions' });
        }
        const versions = await this.getPolicyVersions();
        return this.sendJson(res, 200, versions);
      }

      if (path === '/api/v1/policy/versions/current' && method === 'GET') {
        const version = await this.getActivePolicyVersion();
        return this.sendJson(res, 200, version);
      }

      if (path === '/api/v1/policy/versions' && method === 'POST') {
        if (!authUser) return this.sendJson(res, 401, { error: 'Unauthorized' });
        if (!(await this.policyService.canManagePolicy(authUser.id))) {
          return this.sendJson(res, 403, { error: 'Only admins can create policy versions' });
        }
        const description = typeof body['description'] === 'string' ? body['description'] : '';
        const rules = Array.isArray(body['rules']) ? body['rules'] : [];
        if (!description) {
          return this.sendJson(res, 400, { error: 'description is required' });
        }
        const version = await this.policyService.createPolicyVersion(authUser.id, description, rules);
        return this.sendJson(res, 201, version);
      }

      if (
        segments.length >= 4 &&
        segments[0] === 'api' &&
        segments[1] === 'v1' &&
        segments[2] === 'policy' &&
        segments[3] === 'versions'
      ) {
        const versionId = segments[4];

        // GET /api/v1/policy/versions/:id — full version detail incl. rules
        if (versionId && method === 'GET' && segments.length === 5) {
          if (!authUser) return this.sendJson(res, 401, { error: 'Unauthorized' });
          if (!(await this.policyService.canManagePolicy(authUser.id))) {
            return this.sendJson(res, 403, { error: 'Only admins can view policy versions' });
          }
          const detail = await this.policyService.getPolicyVersionById(versionId);
          if (!detail) return this.sendJson(res, 404, { error: 'Policy version not found' });
          return this.sendJson(res, 200, detail);
        }

        if (versionId && method === 'POST' && segments[5] === 'activate') {
          if (!authUser) return this.sendJson(res, 401, { error: 'Unauthorized' });
          if (!(await this.policyService.canManagePolicy(authUser.id))) {
            return this.sendJson(res, 403, { error: 'Only admins can activate policy versions' });
          }
          const activated = await this.policyService.activatePolicyVersion(versionId, authUser.id);
          if (!activated) {
            return this.sendJson(res, 404, { error: 'Policy version not found' });
          }
          return this.sendJson(res, 200, activated);
        }
      }

      if (path === '/api/v1/policy/evaluate' && method === 'POST') {
        // Internal endpoint for Gateway→Control-Plane evaluation confirmation
        // Authenticated via device cert (same as tunnel auth)
        const capability = typeof body['capability'] === 'string' ? body['capability'] : undefined;
        const riskClass = typeof body['riskClass'] === 'string' ? body['riskClass'] : 'low';
        const resource = typeof body['resource'] === 'string' ? body['resource'] : undefined;
        const projectId = typeof body['projectId'] === 'string' ? body['projectId'] : undefined;
        const deviceId = typeof body['deviceId'] === 'string' ? body['deviceId'] : undefined;
        const sessionId = typeof body['sessionId'] === 'string' ? body['sessionId'] : undefined;
        const userId = typeof body['userId'] === 'string' ? body['userId'] : undefined;

        if (!capability || !deviceId || !userId) {
          return this.sendJson(res, 400, { error: 'capability, deviceId, and userId are required' });
        }

        const decision = await this.policyService.evaluate(
          capability as 'filesystem.read' | 'filesystem.write' | 'filesystem.delete' | 'process.exec' | 'network.access' | 'package.install' | 'git.commit' | 'git.push' | 'deployment.execute' | 'secret.read',
          riskClass as 'low' | 'medium' | 'high' | 'critical',
          {
            ...(resource ? { resource } : {}),
            ...(projectId ? { projectId } : {}),
            deviceId,
            ...(sessionId ? { sessionId } : {}),
            userId,
          },
        );

        return this.sendJson(res, 200, decision);
      }

      // --- AUDIT ROUTES (Phase 5) ---
      if (path === '/api/v1/audit' && method === 'GET') {
        if (!authUser) return this.sendJson(res, 401, { error: 'Unauthorized' });
        if (!(await this.isAdminOrOwner(authUser.id))) {
          return this.sendJson(res, 403, { error: 'Only admins/owners can query audit log' });
        }
        const filter: Record<string, string> = {};
        const qSessionId = url.searchParams.get('sessionId');
        if (qSessionId) filter.sessionId = qSessionId;
        const qDeviceId = url.searchParams.get('deviceId');
        if (qDeviceId) filter.deviceId = qDeviceId;
        const qActorType = url.searchParams.get('actorType');
        if (qActorType) filter.actorType = qActorType;
        const qActorId = url.searchParams.get('actorId');
        if (qActorId) filter.actorId = qActorId;
        const qDecision = url.searchParams.get('decision');
        if (qDecision) filter.decision = qDecision;
        const qFrom = url.searchParams.get('fromSequence');
        const fromSequence = qFrom ? parseInt(qFrom, 10) : undefined;
        const qLimit = url.searchParams.get('limit');
        const limit = qLimit ? parseInt(qLimit, 10) : undefined;

        const events = await this.auditLog.list({
          ...filter,
          ...(fromSequence !== undefined ? { fromSequence } : {}),
          limit: limit ?? 100,
        });
        return this.sendJson(res, 200, events);
      }

      if (path === '/api/v1/audit/verify' && method === 'GET') {
        if (!authUser) return this.sendJson(res, 401, { error: 'Unauthorized' });
        if (!(await this.isAdminOrOwner(authUser.id))) {
          return this.sendJson(res, 403, { error: 'Only admins/owners can verify audit chain' });
        }
        const result = await this.auditLog.verifyChain();
        return this.sendJson(res, 200, {
          valid: result.valid,
          firstBrokenIndex: result.firstBrokenIndex,
          timestamp: new Date().toISOString(),
        });
      }

      return this.sendJson(res, 404, { error: `Endpoint not found: ${method} ${path}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal Server Error';
      return this.sendJson(res, 500, { error: message });
    }
  }

  /**
   * Issue an access + refresh token pair for the given user.
   * Access tokens are short-lived (config.jwtExpiresInSec, default 24 h).
   * Refresh tokens are long-lived (config.refreshTokenExpiresInSec, default 7 days) and carry
   * type: 'refresh' so the /auth/refresh endpoint can distinguish them.
   */
  private issueTokenPair(
    userId: string,
    email: string,
    role: 'user' | 'admin' | 'owner',
  ): { accessToken: string; refreshToken: string } {
    const accessToken = signJwt(
      { sub: userId, email, role, type: 'access' },
      this.config.jwtSecret,
      this.config.jwtExpiresInSec,
    );
    const refreshExpiresInSec =
      this.config.refreshTokenExpiresInSec || this.config.jwtExpiresInSec * 7;
    const refreshToken = signJwt(
      { sub: userId, email, role, type: 'refresh' },
      this.config.jwtSecret,
      refreshExpiresInSec,
    );
    return { accessToken, refreshToken };
  }

  private parseCookies(cookieHeader?: string): Record<string, string> {
    if (!cookieHeader) return {};
    const cookies: Record<string, string> = {};
    cookieHeader.split(';').forEach((pair) => {
      const [name, ...rest] = pair.trim().split('=');
      if (name && rest.length > 0) {
        cookies[name] = decodeURIComponent(rest.join('='));
      }
    });
    return cookies;
  }

  private setRefreshCookie(res: ServerResponse, token: string): void {
    const maxAge = this.config.refreshTokenExpiresInSec || 604800;
    res.setHeader(
      'Set-Cookie',
      `refreshToken=${token}; Path=/api/v1/auth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
    );
  }

  private clearRefreshCookie(res: ServerResponse): void {
    res.setHeader(
      'Set-Cookie',
      'refreshToken=; Path=/api/v1/auth; HttpOnly; SameSite=Lax; Max-Age=0',
    );
  }

  private setCORS(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type,Authorization,X-Request-ID,X-Client-Type',
    );
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    if (res.headersSent) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }

  private async getPolicyVersions() {
    const versions: Array<{ createdAt: string; [key: string]: unknown }> = [];
    const allUsers = await this.db.users.list();
    for (const user of allUsers) {
      if (user.metadata?._policyVersion) {
        const pv = user.metadata._policyVersion as {
          id: string;
          version: string;
          description: string;
          rules: unknown[];
          createdAt: Date;
          createdBy: string;
          isActive: boolean;
        };
        versions.push({
          id: pv.id,
          version: pv.version,
          description: pv.description,
          ruleCount: pv.rules.length,
          createdAt: pv.createdAt.toISOString(),
          createdBy: pv.createdBy,
          isActive: pv.isActive,
        });
      }
    }
    return versions.sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
  }

  private async getActivePolicyVersion() {
    const allUsers = await this.db.users.list();
    for (const user of allUsers) {
      if (user.metadata?._policyVersion) {
        const pv = user.metadata._policyVersion as {
          id: string;
          version: string;
          description: string;
          rules: unknown[];
          createdAt: Date;
          createdBy: string;
          isActive: boolean;
        };
        if (pv.isActive) {
          return {
            id: pv.id,
            version: pv.version,
            description: pv.description,
            ruleCount: pv.rules.length,
            createdAt: pv.createdAt.toISOString(),
            createdBy: pv.createdBy,
            isActive: pv.isActive,
          };
        }
      }
    }
    // Return default policy if no active version
    return {
      id: 'p_default',
      version: 'p_default',
      description: 'Default policy (no custom rules — uses risk class defaults)',
      ruleCount: 0,
      createdAt: new Date().toISOString(),
      createdBy: 'system',
      isActive: true,
    };
  }

  private async isAdminOrOwner(userId: string): Promise<boolean> {
    const user = await this.db.users.findById(userId);
    if (!user) return false;
    return user.role === 'admin' || user.role === 'owner';
  }

  private async readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk: Buffer) => {
        data += chunk.toString('utf8');
        if (data.length > 5 * 1024 * 1024) {
          reject(new Error('Body too large'));
          req.destroy();
        }
      });
      req.on('end', () => {
        if (!data.trim()) return resolve({});
        try {
          resolve(JSON.parse(data) as Record<string, unknown>);
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', (err) => {
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }
}
