import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, resolve } from 'node:path';

import type {
  AgentCapabilities,
  Capability,
  RepositoryBinding,
  SessionConfig,
  TaskKind,
  TrustProfile,
} from '@odysseus/protocol';
import { CreatePolicyVersionSchema } from '@odysseus/schemas';

import { AdminActionError, AdminService } from '../admin/admin-service';
import { SummaryGenerator } from '../afk/summary-generator';
import { isUsablePublicKeyJwk } from '../auth/device-signature';
import { verifyFirebaseIdToken } from '../auth/firebase-admin';
import { signJwt, verifyJwt } from '../auth/jwt';
import { hashPassword, verifyPassword } from '../auth/password';
import {
  AuthRateLimiter,
  DEFAULT_ACCOUNT_LOGIN_RATE_LIMIT,
  DEFAULT_LOGIN_RATE_LIMIT,
  DEFAULT_PAIRING_RATE_LIMIT,
  DEFAULT_REGISTER_RATE_LIMIT,
} from '../auth/rate-limiter';
import { isAllowedOrigin } from '../config';
import { normalizePairingCode } from '../db/pairing-code';
import type { IDatabase } from '../db/types';
import {
  IntegrationAccessError,
  type IntegrationAccessService,
} from '../integrations/integration-access';
import { VcsOAuth } from '../integrations/vcs/oauth';
import { VcsCredentialStore } from '../integrations/vcs/token-store';
import {
  isVcsProvider,
  type StoredVcsCredential,
  type VcsProvider,
} from '../integrations/vcs/types';
import { VcsClient } from '../integrations/vcs/vcs-client';
import { type AgentRouter } from '../orchestration/agent-router';
import { type CostGovernor } from '../orchestration/cost-governor';
import { type MultiAgentOrchestrator } from '../orchestration/multi-agent-orchestrator';
import { RiskEngine } from '../orchestration/risk-engine';
import { type PolicyEngineService, type ApprovalWorkflow, type AuditLog } from '../policy/index';
import { ReviewOrchestrator } from '../review/review-orchestrator';
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

function parseRepositoryBinding(value: unknown): RepositoryBinding | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (!isVcsProvider(raw['provider']) || typeof raw['fullName'] !== 'string') return null;
  const fullName = raw['fullName'].trim();
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/.test(fullName)) return null;
  const defaultBranch =
    typeof raw['defaultBranch'] === 'string' && raw['defaultBranch'].trim()
      ? raw['defaultBranch'].trim()
      : undefined;
  const webUrl =
    typeof raw['webUrl'] === 'string' && raw['webUrl'].startsWith('https://')
      ? raw['webUrl']
      : undefined;
  return {
    provider: raw['provider'],
    fullName,
    ...(defaultBranch ? { defaultBranch } : {}),
    ...(webUrl ? { webUrl } : {}),
  };
}

export class HttpRouter {
  private db: IDatabase;
  private registry: ConnectionRegistry;
  private tunnelServer: TunnelServer;
  private config: ControlPlaneConfig;
  private policyService: PolicyEngineService;
  private approvalWorkflow: ApprovalWorkflow;
  private auditLog: AuditLog;
  private summaryGenerator: SummaryGenerator;
  private reviewOrchestrator: ReviewOrchestrator;
  private agentRouter?: AgentRouter | undefined;
  private riskEngine: RiskEngine;
  private costGovernor?: CostGovernor | undefined;
  private multiAgentOrchestrator?: MultiAgentOrchestrator | undefined;
  private readonly vcsOAuth: VcsOAuth;
  private readonly vcsCredentials: VcsCredentialStore;
  // §4.4 of the pre-deployment audit: neither endpoint had any attempt
  // limiting at all. Keyed by IP+email for login (so a distributed attacker
  // guessing one account, or one IP spraying many accounts, both get
  // limited) and by IP alone for register (an email doesn't exist yet to
  // key on when the abuse is account-creation spam itself).
  private readonly loginRateLimiter = new AuthRateLimiter(DEFAULT_LOGIN_RATE_LIMIT);
  /** Keyed on the account alone, so a spoofed address cannot reset it. */
  private readonly accountLoginRateLimiter = new AuthRateLimiter(DEFAULT_ACCOUNT_LOGIN_RATE_LIMIT);
  private readonly registerRateLimiter = new AuthRateLimiter(DEFAULT_REGISTER_RATE_LIMIT);
  private readonly pairingRateLimiter = new AuthRateLimiter(DEFAULT_PAIRING_RATE_LIMIT);
  private integrationAccess: IntegrationAccessService | undefined;
  private adminService: AdminService;

  setIntegrationAccess(service: IntegrationAccessService): void {
    this.integrationAccess = service;
  }

  constructor(
    db: IDatabase,
    registry: ConnectionRegistry,
    tunnelServer: TunnelServer,
    config: ControlPlaneConfig,
    policyService: PolicyEngineService,
    approvalWorkflow: ApprovalWorkflow,
    auditLog: AuditLog,
    reviewOrchestrator?: ReviewOrchestrator,
    agentRouter?: AgentRouter,
    riskEngine = new RiskEngine(),
    costGovernor?: CostGovernor,
    multiAgentOrchestrator?: MultiAgentOrchestrator,
  ) {
    this.db = db;
    this.registry = registry;
    this.tunnelServer = tunnelServer;
    this.config = config;
    this.policyService = policyService;
    this.approvalWorkflow = approvalWorkflow;
    this.auditLog = auditLog;
    this.summaryGenerator = new SummaryGenerator(db);
    this.reviewOrchestrator =
      reviewOrchestrator ?? new ReviewOrchestrator(db, tunnelServer, policyService);
    this.agentRouter = agentRouter;
    this.riskEngine = riskEngine;
    this.costGovernor = costGovernor;
    this.multiAgentOrchestrator = multiAgentOrchestrator;
    this.vcsCredentials = new VcsCredentialStore(
      db,
      config.credentialEncryptionSecret ?? config.jwtSecret,
    );
    this.adminService = new AdminService(db, registry, tunnelServer, auditLog, '0.1.0');
    this.vcsOAuth = new VcsOAuth({
      ...(config.githubClientId && config.githubClientSecret && config.githubCallbackUrl
        ? {
            github: {
              clientId: config.githubClientId,
              clientSecret: config.githubClientSecret,
              callbackUrl: config.githubCallbackUrl,
            },
          }
        : {}),
      ...(config.gitlabClientId && config.gitlabClientSecret && config.gitlabCallbackUrl
        ? {
            gitlab: {
              clientId: config.gitlabClientId,
              clientSecret: config.gitlabClientSecret,
              callbackUrl: config.gitlabCallbackUrl,
            },
          }
        : {}),
      ...(config.bitbucketClientId && config.bitbucketClientSecret && config.bitbucketCallbackUrl
        ? {
            bitbucket: {
              clientId: config.bitbucketClientId,
              clientSecret: config.bitbucketClientSecret,
              callbackUrl: config.bitbucketCallbackUrl,
            },
          }
        : {}),
    });
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
          // SECURITY FIX: `role` used to be read directly from the Firebase
          // ID token's custom claim (`decoded['role']`) and trusted for
          // every authorization decision in this handler, while a
          // newly-created user record was unconditionally given `role:
          // 'user'` — so the database (source of truth) and the per-request
          // authUser.role could diverge, and every check downstream trusted
          // the token over the database. Custom claims can currently only be
          // set server-side via the Admin SDK, so this wasn't yet reachable
          // by a client — but it's exactly the kind of latent seam that
          // becomes exploitable the moment an unrelated feature (an "invite
          // a teammate" flow, a claims-sync endpoint) is added without
          // realizing this handler already trusts that claim. Role is now
          // always read from the database record.
          const existing = await this.db.users.findById(decoded.uid);
          authUser = {
            id: decoded.uid,
            email: decoded.email,
            role: existing?.role ?? 'user',
          };
          // Ensure user exists in our repository
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
          service: 'odysseus-control-plane',
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
        const clientIp = this.getClientIp(req);
        if (!this.registerRateLimiter.isAllowed(clientIp)) {
          return this.sendJson(res, 429, {
            error: 'Too many registration attempts. Please try again later.',
            retryAfterSeconds: this.registerRateLimiter.retryAfterSeconds(clientIp),
          });
        }
        this.registerRateLimiter.recordAttempt(clientIp);

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

        // Keyed by IP+email: bounds both "one attacker guessing one
        // account's password" and "one IP spraying many accounts", without
        // letting an attacker who rotates IPs bypass a per-email-only limit
        // or an attacker sharing an IP (e.g. behind NAT/a proxy) lock out
        // every other user on that IP via a per-IP-only limit.
        const loginKey = `${this.getClientIp(req)}:${email.toLowerCase()}`;
        const accountKey = email.toLowerCase();
        if (!this.loginRateLimiter.isAllowed(loginKey)) {
          return this.sendJson(res, 429, {
            error: 'Too many login attempts. Please try again later.',
            retryAfterSeconds: this.loginRateLimiter.retryAfterSeconds(loginKey),
          });
        }
        // The address above is caller-supplied, so on its own it bounded
        // nothing: rotating X-Forwarded-For gave each guess a new key. This
        // one counts failures against the account wherever they come from.
        if (!this.accountLoginRateLimiter.isAllowed(accountKey)) {
          return this.sendJson(res, 429, {
            error: 'Too many failed sign-in attempts for this account. Please try again later.',
            retryAfterSeconds: this.accountLoginRateLimiter.retryAfterSeconds(accountKey),
          });
        }

        const user = await this.db.users.findByEmail(email);
        if (!user || !verifyPassword(password, user.passwordHash)) {
          // Record only failed attempts — a legitimate user who succeeds on
          // their first try should never be throttled by their own history.
          this.loginRateLimiter.recordAttempt(loginKey);
          this.accountLoginRateLimiter.recordAttempt(accountKey);
          return this.sendJson(res, 401, { error: 'Invalid email or password' });
        }
        // Suspended accounts are refused at the front door, not just in the
        // admin console: a suspension that still lets you mint tokens would
        // only be a UI label.
        if (user.status === 'suspended') {
          this.loginRateLimiter.recordAttempt(loginKey);
          this.accountLoginRateLimiter.recordAttempt(accountKey);
          return this.sendJson(res, 403, {
            error:
              'This account has been suspended by an administrator. Contact support if you believe this is a mistake.',
          });
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
        // Same rule as login: a suspended account cannot silently ride an
        // existing refresh token past its suspension.
        if (user.status === 'suspended') {
          this.clearRefreshCookie(res);
          return this.sendJson(res, 403, { error: 'This account has been suspended' });
        }
        const tokens = this.issueTokenPair(user.id, user.email, user.role);
        const isWeb = req.headers['x-client-type'] === 'web' || Boolean(cookies['refreshToken']);
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
        const reportedName =
          typeof body['deviceName'] === 'string'
            ? body['deviceName']
                // Removing control characters is the intent here: left in, they
                // would corrupt the audit log and the device list in the UI.
                // eslint-disable-next-line no-control-regex
                .replace(/[\u0000-\u001f\u007f]/g, '')
                .trim()
                .slice(0, 120)
            : '';
        const reportedPlatform = body['platform'];
        const platform =
          reportedPlatform === 'windows' ||
          reportedPlatform === 'linux' ||
          reportedPlatform === 'darwin' ||
          reportedPlatform === 'unknown'
            ? reportedPlatform
            : undefined;
        const fingerprintHex =
          typeof body['fingerprintHex'] === 'string' ? body['fingerprintHex'] : '';
        const fingerprintWords = Array.isArray(body['fingerprintWords'])
          ? (body['fingerprintWords'] as string[])
          : [];

        // The device public key is captured here, at pairing time, because the
        // tunnel handshake verifies gateway signatures against it. A pairing
        // without a key produces a device that can never authenticate, so it is
        // rejected up front rather than discovered at the first connection.
        const publicKeyJwk = body['publicKeyJwk'];
        const publicKeyPem =
          typeof body['publicKeyPem'] === 'string' ? body['publicKeyPem'] : undefined;

        if (!code || !deviceId || !gatewayId) {
          return this.sendJson(res, 400, { error: 'Missing pairing initiation fields' });
        }
        if (!isUsablePublicKeyJwk(publicKeyJwk)) {
          return this.sendJson(res, 400, {
            error:
              'publicKeyJwk is required and must be a public JWK. Update the gateway: ' +
              'pairing now registers the device key used to verify its tunnel signatures.',
          });
        }
        const pairing = await this.db.pairings.create({
          code,
          deviceId,
          gatewayId,
          ...(reportedName ? { deviceName: reportedName } : {}),
          ...(platform ? { platform } : {}),
          fingerprintHex,
          fingerprintWords,
          publicKeyJwk,
          ...(publicKeyPem ? { publicKeyPem } : {}),
          status: 'pending',
          expiresAt: new Date(Date.now() + this.config.pairingCodeTtlSec * 1000),
        });
        return this.sendJson(res, 201, { pairingId: pairing.id, status: pairing.status });
      }

      // Gateway polls this to check if a user has confirmed the pairing in the web UI
      if (path === '/api/v1/internal/pairing/status' && method === 'GET') {
        const code = url.searchParams.get('code');
        if (!code) {
          return this.sendJson(res, 400, { error: 'code query parameter required' });
        }
        const pairing = await this.db.pairings.findByCode(code);
        if (!pairing) {
          return this.sendJson(res, 404, { error: 'Pairing not found' });
        }
        return this.sendJson(res, 200, {
          status: pairing.status,
          pairingId: pairing.id,
          deviceId: pairing.deviceId,
          expiresAt: pairing.expiresAt.toISOString(),
        });
      }

      // --- INTEGRATIONS ---
      // The web app can list, request and revoke. It cannot grant: approval
      // happens only at the workstation, and the gateway enforces it.
      if (path === '/api/v1/integrations/catalog' && method === 'GET') {
        if (!authUser) return this.sendJson(res, 401, { error: 'Unauthorized' });
        if (!this.integrationAccess) {
          return this.sendJson(res, 503, { error: 'Integrations are not enabled' });
        }
        return this.sendJson(res, 200, this.integrationAccess.catalog());
      }

      if (
        segments[0] === 'api' &&
        segments[1] === 'v1' &&
        segments[2] === 'devices' &&
        segments[4] === 'integrations' &&
        segments.length >= 5 &&
        segments.length <= 7
      ) {
        if (!authUser) return this.sendJson(res, 401, { error: 'Unauthorized' });
        if (!this.integrationAccess) {
          return this.sendJson(res, 503, { error: 'Integrations are not enabled' });
        }
        const device = await this.db.devices.findById(segments[3] ?? '');
        // Another user's device answers exactly like a missing one.
        if (!device || device.userId !== authUser.id) {
          return this.sendJson(res, 404, { error: 'Device not found' });
        }
        try {
          if (segments.length === 5 && method === 'GET') {
            return this.sendJson(res, 200, await this.integrationAccess.listForDevice(device));
          }
          if (segments.length === 7 && segments[6] === 'requests' && method === 'POST') {
            const created = await this.integrationAccess.requestAccess(
              authUser,
              device,
              segments[5],
              body['scopes'],
            );
            return this.sendJson(res, 201, created);
          }
          if (segments.length === 7 && segments[6] === 'sync' && method === 'POST') {
            return this.sendJson(
              res,
              202,
              await this.integrationAccess.requestSync(device, segments[5]),
            );
          }
          if (segments.length === 6 && method === 'DELETE') {
            return this.sendJson(
              res,
              200,
              await this.integrationAccess.revoke(authUser, device, segments[5]),
            );
          }
          return this.sendJson(res, 405, { error: 'Method not allowed' });
        } catch (error) {
          if (error instanceof IntegrationAccessError) {
            return this.sendJson(res, error.status, { error: error.message });
          }
          throw error;
        }
      }

      // --- IMPORTED HISTORY & PROVIDER USAGE ---
      // Everything is scoped to the signed-in user; another user's
      // conversation answers exactly like a missing one.
      if (segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'history') {
        if (!authUser) return this.sendJson(res, 401, { error: 'Unauthorized' });
        if (!this.integrationAccess) {
          return this.sendJson(res, 503, { error: 'Integrations are not enabled' });
        }
        try {
          if (segments.length === 3 && method === 'GET') {
            return this.sendJson(
              res,
              200,
              await this.integrationAccess.listHistory(authUser, {
                integration: url.searchParams.get('integration') ?? undefined,
                deviceId: url.searchParams.get('deviceId') ?? undefined,
                // Bounded before it reaches the matcher: the query is used as
                // a plain substring, never as a pattern, and a huge one would
                // only waste work.
                query: (url.searchParams.get('q') ?? '').slice(0, 200) || undefined,
              }),
            );
          }
          if (segments.length === 4 && method === 'GET') {
            return this.sendJson(
              res,
              200,
              await this.integrationAccess.getConversation(authUser, segments[3] ?? ''),
            );
          }
          if (segments.length === 5 && segments[4] === 'content' && method === 'POST') {
            return this.sendJson(
              res,
              202,
              await this.integrationAccess.requestContent(authUser, segments[3] ?? ''),
            );
          }
          return this.sendJson(res, 405, { error: 'Method not allowed' });
        } catch (error) {
          if (error instanceof IntegrationAccessError) {
            return this.sendJson(res, error.status, { error: error.message });
          }
          throw error;
        }
      }

      if (path === '/api/v1/usage/providers' && method === 'GET') {
        if (!authUser) return this.sendJson(res, 401, { error: 'Unauthorized' });
        if (!this.integrationAccess) {
          return this.sendJson(res, 503, { error: 'Integrations are not enabled' });
        }
        return this.sendJson(res, 200, await this.integrationAccess.listUsage(authUser));
      }

      // --- DEVICE PAIRING & MANAGEMENT ---
      if (path === '/api/v1/devices/pair' && method === 'POST') {
        if (!authUser) {
          return this.sendJson(res, 401, { error: 'Unauthorized: log in to pair a device' });
        }
        // Codes are short and typed by hand, so unlimited guesses would make
        // them enumerable. Limited per user rather than per IP: the attacker
        // controls their IP, and an authenticated account is the thing a
        // stolen pairing would actually attach a device to.
        if (!this.pairingRateLimiter.isAllowed(authUser.id)) {
          return this.sendJson(res, 429, {
            error: 'Too many pairing attempts. Please try again later.',
            retryAfterSeconds: this.pairingRateLimiter.retryAfterSeconds(authUser.id),
          });
        }
        this.pairingRateLimiter.recordAttempt(authUser.id);

        const code =
          typeof body['code'] === 'string' ? normalizePairingCode(body['code']) : undefined;
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
          deviceName: pairing.deviceName || `Workstation (${pairing.deviceId.slice(-6)})`,
          platform: pairing.platform ?? 'unknown',
          fingerprintHex: pairing.fingerprintHex,
          fingerprintWords: pairing.fingerprintWords,
          expiresAt: pairing.expiresAt.toISOString(),
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
          typeof body['friendlyName'] === 'string'
            ? body['friendlyName']
                // Removing control characters is the intent here: left in, they
                // would corrupt the audit log and the device list in the UI.
                // eslint-disable-next-line no-control-regex
                .replace(/[\u0000-\u001f\u007f]/g, '')
                .trim()
                .slice(0, 120)
            : '';

        const pairing = pairingId
          ? await this.db.pairings.findById(pairingId)
          : code
            ? await this.db.pairings.findByCode(code)
            : null;

        if (!pairing) {
          return this.sendJson(res, 404, { error: 'Pairing session not found' });
        }
        if (pairing.userId !== authUser.id) {
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
          if (!isUsablePublicKeyJwk(pairing.publicKeyJwk)) {
            // Refusing here keeps a device that cannot authenticate out of the
            // database entirely, so the user gets one clear error now instead of
            // a gateway that connects and is rejected forever.
            return this.sendJson(res, 409, {
              error:
                'This pairing recorded no device public key, so the device cannot be trusted. ' +
                'Re-run pairing with an up-to-date gateway.',
            });
          }
          device = await this.db.devices.create({
            id: pairing.deviceId,
            gatewayId: pairing.gatewayId,
            userId: authUser.id,
            friendlyName:
              friendlyName || pairing.deviceName || `Workstation (${pairing.deviceId.slice(-6)})`,
            platform: pairing.platform ?? 'unknown',
            publicKeyPem: pairing.publicKeyPem ?? '',
            publicKeyJwk: pairing.publicKeyJwk,
            fingerprintHex: pairing.fingerprintHex,
            fingerprintWords: pairing.fingerprintWords,
            status: 'trusted',
          });
        } else {
          device =
            (await this.db.devices.update(device.id, {
              status: 'trusted',
              ...(friendlyName ? { friendlyName } : {}),
              ...(pairing.platform ? { platform: pairing.platform } : {}),
            })) ?? device;
        }

        return this.sendJson(res, 200, {
          status: 'confirmed',
          device: {
            id: device.id,
            friendlyName: device.friendlyName,
            platform: device.platform,
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
            const connection = this.registry.getGateway(d.id);
            const activeSessionCount = sessions.filter(
              (s) => s.state === 'running' || s.state === 'waiting_for_approval',
            ).length;
            return {
              id: d.id,
              friendlyName: d.friendlyName,
              platform: d.platform,
              systemInfo: d.systemInfo ?? null,
              status: d.status,
              online: this.registry.isDeviceOnline(d.id),
              connectedAt: connection?.connectedAt.toISOString() ?? null,
              lastHeartbeatAt: connection?.lastHeartbeatAt.toISOString() ?? null,
              tunnelConnectionCount: this.registry.countConnections(d.id),
              activeWebClients: this.registry.getClientsForUser(d.userId).length,
              fingerprintShort: d.fingerprintHex
                ? d.fingerprintHex.replace(/:/g, '').slice(0, 12).toUpperCase()
                : null,
              fingerprintWords: (d.fingerprintWords ?? []).slice(0, 4),
              lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
              activeSessionCount,
              resourceUsage: d.resourceUsage ?? null,
              availableAgents: d.availableAgents ?? [],
              defaultTrustProfile: d.defaultTrustProfile,
              createdAt: d.createdAt.toISOString(),
            };
          }),
        );
        return this.sendJson(res, 200, mapped);
      }

      if (
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'v1' &&
        segments[2] === 'devices' &&
        segments[4] === 'agents' &&
        method === 'GET'
      ) {
        if (!authUser) return this.sendJson(res, 401, { error: 'Unauthorized' });
        const deviceId = segments[3]!;
        const device = await this.db.devices.findById(deviceId);
        if (!device || device.userId !== authUser.id)
          return this.sendJson(res, 404, { error: 'Device not found' });

        let availableAgents = device.availableAgents ?? [];
        if (this.registry.isDeviceOnline(deviceId)) {
          const inventory = await this.tunnelServer
            .sendCommandToDevice(deviceId, 'system.inventory', {}, 5_000)
            .catch(() => ({ delivered: false, acknowledged: false, payload: undefined }));
          const outer = inventory.payload as { result?: { agents?: unknown[] } } | undefined;
          if (Array.isArray(outer?.result?.agents)) {
            availableAgents = outer.result.agents.flatMap((value) => {
              const agent = value as {
                installed?: unknown;
                health?: { status?: unknown };
                metadata?: { id?: unknown; capabilities?: unknown };
              };
              return agent.installed === true &&
                agent.health?.status !== 'unhealthy' &&
                typeof agent.metadata?.id === 'string'
                ? [
                    {
                      id: agent.metadata.id,
                      capabilities: (agent.metadata.capabilities ??
                        {}) as Partial<AgentCapabilities>,
                    },
                  ]
                : [];
            });
            await this.db.devices.update(deviceId, { availableAgents });
          }
        }
        return this.sendJson(res, 200, availableAgents);
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

        const ACTIVE_STATES = new Set([
          'running',
          'waiting_for_approval',
          'initializing',
          'paused',
        ]);
        const sessions = await this.db.sessions.listByDevice(deviceId);
        const active = sessions.filter((s) => ACTIVE_STATES.has(s.state));

        const reason =
          typeof body['reason'] === 'string'
            ? body['reason']
            : action === 'kill-switch'
              ? 'Kill switch activated by user'
              : 'Session locked by user';

        const results: Array<{
          sessionId: string;
          state: string;
          delivered: boolean;
          acknowledged: boolean;
        }> = [];
        for (const session of active) {
          if (action === 'kill-switch') {
            // Same command POST /sessions/:id/cancel already uses, looped (§2.5).
            const result = await this.tunnelServer.sendCommandToDevice(deviceId, 'session.stop', {
              sessionId: session.id,
              force: true,
              reason,
            });
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
        const target =
          typeof body['endpoint'] === 'string'
            ? body['endpoint']
            : typeof body['fcmToken'] === 'string'
              ? body['fcmToken']
              : undefined;
        if (!target) return this.sendJson(res, 400, { error: 'endpoint or fcmToken is required' });
        const deleted = await this.db.pushSubscriptions.delete(authUser.id, target);
        return this.sendJson(res, deleted ? 200 : 404, { success: deleted });
      }

      // --- VERSION CONTROL OAUTH AND PROJECT PIPELINE ---
      // Start is authenticated by the Odysseus session. The callback is bound
      // to that user through opaque, single-use server state.
      if (path === '/api/v1/integrations' && method === 'GET') {
        if (!authUser) return this.sendJson(res, 401, { error: 'Unauthorized' });
        const providers: VcsProvider[] = ['github', 'gitlab', 'bitbucket'];
        const integrations = await Promise.all(
          providers.map(async (provider) => {
            const credential = await this.getVcsCredential(authUser.id, provider);
            return {
              id: provider,
              provider,
              configured: this.vcsOAuth.isConfigured(provider),
              connected: credential !== null,
              ...(credential
                ? {
                    username: credential.account.username,
                    displayName: credential.account.displayName,
                    avatarUrl: credential.account.avatarUrl,
                    scopes: credential.scope?.split(/[\s,]+/).filter(Boolean) ?? [],
                    connectedAt: credential.connectedAt,
                  }
                : {}),
            };
          }),
        );
        return this.sendJson(res, 200, { integrations });
      }
      if (
        segments.length === 6 &&
        segments[0] === 'api' &&
        segments[1] === 'v1' &&
        segments[2] === 'integrations' &&
        isVcsProvider(segments[3]) &&
        segments[4] === 'oauth' &&
        segments[5] === 'start' &&
        method === 'GET'
      ) {
        if (!authUser) return this.sendJson(res, 401, { error: 'Unauthorized' });
        const provider = segments[3];
        if (!this.vcsOAuth.isConfigured(provider)) {
          return this.sendJson(res, 503, {
            error: provider + ' OAuth is not configured for this Odysseus deployment',
          });
        }
        return this.sendJson(res, 200, this.vcsOAuth.authorizationUrl(provider, authUser.id));
      }
      if (
        segments.length === 6 &&
        segments[0] === 'api' &&
        segments[1] === 'v1' &&
        segments[2] === 'integrations' &&
        isVcsProvider(segments[3]) &&
        segments[4] === 'oauth' &&
        segments[5] === 'callback' &&
        method === 'GET'
      ) {
        const provider = segments[3];
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (!code || !state) {
          return this.redirectOAuthResult(res, provider, 'failed', 'missing_callback_parameters');
        }
        try {
          const exchanged = await this.vcsOAuth.exchangeCode(provider, state, code);
          // A token is stored only after a live profile request succeeds.
          const account = await new VcsClient(
            provider,
            exchanged.token.accessToken,
          ).getCurrentUser();
          await this.vcsCredentials.set(exchanged.userId, provider, {
            ...exchanged.token,
            account,
            connectedAt: new Date().toISOString(),
          });
          return this.redirectOAuthResult(res, provider, 'connected');
        } catch (error) {
          console.warn('[Odysseus Control Plane] OAuth callback failed:', provider, error);
          return this.redirectOAuthResult(res, provider, 'failed', 'verification_failed');
        }
      }
      if (
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'v1' &&
        segments[2] === 'integrations' &&
        isVcsProvider(segments[3]) &&
        segments[4] === 'repositories' &&
        method === 'GET'
      ) {
        if (!authUser) return this.sendJson(res, 401, { error: 'Unauthorized' });
        const provider = segments[3];
        const credential = await this.getVcsCredential(authUser.id, provider);
        if (!credential) return this.sendJson(res, 409, { error: provider + ' is not connected' });
        try {
          return this.sendJson(res, 200, {
            repositories: await new VcsClient(provider, credential.accessToken).listRepositories(),
          });
        } catch {
          return this.sendJson(res, 502, {
            error:
              'Could not retrieve repositories from ' +
              provider +
              '. Reconnect it if access was revoked.',
          });
        }
      }
      if (
        segments.length === 4 &&
        segments[0] === 'api' &&
        segments[1] === 'v1' &&
        segments[2] === 'integrations' &&
        isVcsProvider(segments[3]) &&
        method === 'DELETE'
      ) {
        if (!authUser) return this.sendJson(res, 401, { error: 'Unauthorized' });
        return this.sendJson(res, 200, {
          disconnected: await this.vcsCredentials.delete(authUser.id, segments[3]),
        });
      }

      // --- ORGANIZATIONS, ROUTING, AND ORCHESTRATION (Phases 10-11) ---
      if (path === '/api/v1/organizations' && method === 'GET') {
        if (!authUser) return this.sendJson(res, 401, { error: 'Unauthorized' });
        return this.sendJson(res, 200, await this.db.organizations.listByUser(authUser.id));
      }
      if (path === '/api/v1/organizations' && method === 'POST') {
        if (!authUser) return this.sendJson(res, 401, { error: 'Unauthorized' });
        const name = typeof body['name'] === 'string' ? body['name'].trim() : '';
        if (!name) return this.sendJson(res, 400, { error: 'name is required' });
        return this.sendJson(
          res,
          201,
          await this.db.organizations.create({
            id: `org_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
            name,
            ownerId: authUser.id,
          }),
        );
      }
      if (
        segments.length >= 4 &&
        segments[0] === 'api' &&
        segments[1] === 'v1' &&
        segments[2] === 'organizations'
      ) {
        if (!authUser) return this.sendJson(res, 401, { error: 'Unauthorized' });
        const organizationId = segments[3]!;
        const organization = await this.db.organizations.findById(organizationId);
        const membership =
          organization && (await this.db.organizations.getMembership(organizationId, authUser.id));
        if (!organization || !membership)
          return this.sendJson(res, 404, { error: 'Organization not found' });
        if (segments.length === 4 && method === 'GET') return this.sendJson(res, 200, organization);
        if (segments.length === 5 && segments[4] === 'members' && method === 'GET')
          return this.sendJson(res, 200, await this.db.organizations.listMembers(organizationId));
        if (segments.length === 5 && segments[4] === 'members' && method === 'POST') {
          if (!['owner', 'admin'].includes(membership.role))
            return this.sendJson(res, 403, { error: 'Organization owner or admin role required' });
          const userId = typeof body['userId'] === 'string' ? body['userId'] : '';
          const role =
            body['role'] === 'admin' || body['role'] === 'member' ? body['role'] : 'member';
          if (!userId || !(await this.db.users.findById(userId)))
            return this.sendJson(res, 400, { error: 'A valid userId is required' });
          return this.sendJson(
            res,
            201,
            await this.db.organizations.addMember({ organizationId, userId, role }),
          );
        }
        if (segments.length === 5 && segments[4] === 'dashboard' && method === 'GET') {
          const members = await this.db.organizations.listMembers(organizationId);
          const projects = (
            await Promise.all(members.map((item) => this.db.projects.listByUser(item.userId)))
          )
            .flat()
            .filter(
              (project, index, values) =>
                project.organizationId === organizationId &&
                values.findIndex((other) => other.id === project.id) === index,
            );
          const projectIds = new Set(projects.map((project) => project.id));
          const sessions = (
            await Promise.all(members.map((item) => this.db.sessions.listByUser(item.userId)))
          )
            .flat()
            .filter((session) => session.projectId && projectIds.has(session.projectId));
          const devices = (
            await Promise.all(members.map((item) => this.db.devices.listByUser(item.userId)))
          ).flat();
          const activeStates = new Set([
            'initializing',
            'running',
            'waiting_for_approval',
            'paused',
          ]);
          const costs = this.costGovernor
            ? await this.costGovernor.usage('organization', organizationId)
            : [];
          return this.sendJson(res, 200, {
            organization,
            projects,
            sessions,
            activeSessions: sessions.filter((session) => activeStates.has(session.state)),
            devices: devices.map((device) => ({
              ...device,
              online: this.registry.isDeviceOnline(device.id),
            })),
            routing: (
              await Promise.all(
                projects.map((project) =>
                  this.db.orchestration.listRoutingDecisions(project.id, 20),
                ),
              )
            ).flat(),
            runs: (
              await Promise.all(
                projects.map((project) =>
                  this.db.orchestration.listRuns(organizationId, project.id),
                ),
              )
            ).flat(),
            budgets: costs,
          });
        }
      }
      if (path === '/api/v1/routing/preview' && method === 'POST') {
        if (!authUser || !this.agentRouter)
          return this.sendJson(res, authUser ? 503 : 401, {
            error: authUser ? 'Routing service unavailable' : 'Unauthorized',
          });
        const projectId = typeof body['projectId'] === 'string' ? body['projectId'] : '';
        const taskKind = typeof body['taskKind'] === 'string' ? body['taskKind'] : 'general';
        if (
          !projectId ||
          !['implementation', 'test', 'security_review', 'planning', 'general'].includes(taskKind)
        )
          return this.sendJson(res, 400, { error: 'A projectId and valid taskKind are required' });
        try {
          return this.sendJson(
            res,
            200,
            await this.agentRouter.route(authUser.id, {
              projectId,
              taskKind: taskKind as TaskKind,
              ...(typeof body['requiredAgentId'] === 'string'
                ? { requiredAgentId: body['requiredAgentId'] }
                : {}),
              ...(body['strategy'] === 'least_loaded' ||
              body['strategy'] === 'capability_first' ||
              body['strategy'] === 'lowest_risk' ||
              body['strategy'] === 'lowest_cost'
                ? { strategy: body['strategy'] }
                : {}),
            }),
          );
        } catch (error) {
          return this.sendJson(res, 404, {
            error: error instanceof Error ? error.message : 'Unable to route task',
          });
        }
      }
      if (path === '/api/v1/risk/assess' && method === 'POST') {
        if (!authUser) return this.sendJson(res, 401, { error: 'Unauthorized' });
        const projectId = typeof body['projectId'] === 'string' ? body['projectId'] : '';
        const project = projectId ? await this.db.projects.findById(projectId) : null;
        if (!project || project.userId !== authUser.id)
          return this.sendJson(res, 404, { error: 'Project not found' });
        const taskKind = typeof body['taskKind'] === 'string' ? body['taskKind'] : 'general';
        if (
          !['implementation', 'test', 'security_review', 'planning', 'general'].includes(taskKind)
        )
          return this.sendJson(res, 400, { error: 'Invalid taskKind' });
        return this.sendJson(
          res,
          200,
          this.riskEngine.assess({
            taskKind: taskKind as TaskKind,
            prompt: typeof body['prompt'] === 'string' ? body['prompt'] : '',
            protectedProject: Boolean(project.preferences.protectedBranches.length),
          }),
        );
      }
      if (path === '/api/v1/budgets' && method === 'POST') {
        if (!authUser || !this.costGovernor)
          return this.sendJson(res, authUser ? 503 : 401, {
            error: authUser ? 'Cost service unavailable' : 'Unauthorized',
          });
        const scope = body['scope'];
        const scopeId = typeof body['scopeId'] === 'string' ? body['scopeId'] : '';
        if ((scope !== 'session' && scope !== 'project' && scope !== 'organization') || !scopeId)
          return this.sendJson(res, 400, { error: 'Valid scope and scopeId are required' });
        if (scope === 'organization') {
          const membership = await this.db.organizations.getMembership(scopeId, authUser.id);
          if (!membership || !['owner', 'admin'].includes(membership.role))
            return this.sendJson(res, 403, { error: 'Organization owner or admin role required' });
        }
        if (scope === 'project') {
          const project = await this.db.projects.findById(scopeId);
          if (!project || project.userId !== authUser.id)
            return this.sendJson(res, 404, { error: 'Project not found' });
        }
        if (scope === 'session') {
          const session = await this.db.sessions.findById(scopeId);
          if (!session || session.userId !== authUser.id)
            return this.sendJson(res, 404, { error: 'Session not found' });
        }
        return this.sendJson(
          res,
          201,
          await this.costGovernor.setBudget({
            scope,
            scopeId,
            ...(typeof body['tokenLimit'] === 'number' ? { tokenLimit: body['tokenLimit'] } : {}),
            ...(typeof body['costLimitUsd'] === 'number'
              ? { costLimitUsd: body['costLimitUsd'] }
              : {}),
            alertPercent: typeof body['alertPercent'] === 'number' ? body['alertPercent'] : 80,
          }),
        );
      }
      if (path === '/api/v1/budgets' && method === 'GET') {
        if (!authUser || !this.costGovernor)
          return this.sendJson(res, authUser ? 503 : 401, {
            error: authUser ? 'Cost service unavailable' : 'Unauthorized',
          });
        const scope = url.searchParams.get('scope');
        const scopeId = url.searchParams.get('scopeId');
        if ((scope !== 'session' && scope !== 'project' && scope !== 'organization') || !scopeId)
          return this.sendJson(res, 400, { error: 'scope and scopeId are required' });
        if (
          scope === 'organization' &&
          !(await this.db.organizations.getMembership(scopeId, authUser.id))
        )
          return this.sendJson(res, 404, { error: 'Organization not found' });
        if (scope === 'project') {
          const project = await this.db.projects.findById(scopeId);
          if (!project || project.userId !== authUser.id)
            return this.sendJson(res, 404, { error: 'Project not found' });
        }
        if (scope === 'session') {
          const session = await this.db.sessions.findById(scopeId);
          if (!session || session.userId !== authUser.id)
            return this.sendJson(res, 404, { error: 'Session not found' });
        }
        return this.sendJson(res, 200, await this.costGovernor.usage(scope, scopeId));
      }
      if (path === '/api/v1/orchestrations' && method === 'POST') {
        if (!authUser || !this.multiAgentOrchestrator)
          return this.sendJson(res, authUser ? 503 : 401, {
            error: authUser ? 'Orchestration service unavailable' : 'Unauthorized',
          });
        const organizationId =
          typeof body['organizationId'] === 'string' ? body['organizationId'] : '';
        const projectId = typeof body['projectId'] === 'string' ? body['projectId'] : '';
        const title = typeof body['title'] === 'string' ? body['title'] : '';
        const steps = Array.isArray(body['steps']) ? body['steps'] : [];
        if (
          !organizationId ||
          !projectId ||
          !title ||
          !steps.every((step) => typeof step === 'object' && step !== null)
        )
          return this.sendJson(res, 400, {
            error: 'organizationId, projectId, title, and valid steps are required',
          });
        try {
          return this.sendJson(
            res,
            201,
            await this.multiAgentOrchestrator.createRun({
              organizationId,
              userId: authUser.id,
              projectId,
              title,
              steps: steps as never,
            }),
          );
        } catch (error) {
          return this.sendJson(res, 400, {
            error: error instanceof Error ? error.message : 'Unable to create orchestration',
          });
        }
      }
      if (
        segments.length >= 4 &&
        segments[0] === 'api' &&
        segments[1] === 'v1' &&
        segments[2] === 'orchestrations'
      ) {
        if (!authUser || !this.multiAgentOrchestrator)
          return this.sendJson(res, authUser ? 503 : 401, {
            error: authUser ? 'Orchestration service unavailable' : 'Unauthorized',
          });
        const run = await this.db.orchestration.findRun(segments[3]!);
        if (!run || !(await this.db.organizations.getMembership(run.organizationId, authUser.id)))
          return this.sendJson(res, 404, { error: 'Orchestration not found' });
        if (segments.length === 4 && method === 'GET') return this.sendJson(res, 200, run);
        if (segments[4] === 'advance' && method === 'POST')
          return this.sendJson(res, 200, await this.multiAgentOrchestrator.advance(run.id));
      }
      if (path === '/api/v1/projects' && method === 'GET') {
        if (!authUser) return this.sendJson(res, 401, { error: 'Unauthorized' });
        return this.sendJson(res, 200, await this.db.projects.listByUser(authUser.id));
      }
      if (path === '/api/v1/projects' && method === 'POST') {
        if (!authUser) return this.sendJson(res, 401, { error: 'Unauthorized' });
        if (typeof body['root'] !== 'string' || !body['root'])
          return this.sendJson(res, 400, { error: 'root is required' });
        const root = resolve(body['root']);
        const existing = await this.db.projects.findByRoot(authUser.id, root);
        if (existing) return this.sendJson(res, 200, existing);
        const project = await this.db.projects.create({
          id: `proj_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          userId: authUser.id,
          name: typeof body['name'] === 'string' ? body['name'] : basename(root),
          root,
          preferences: { protectedBranches: ['main', 'master'] },
        });
        return this.sendJson(res, 201, project);
      }
      if (
        segments.length >= 4 &&
        segments[0] === 'api' &&
        segments[1] === 'v1' &&
        segments[2] === 'projects'
      ) {
        if (!authUser) return this.sendJson(res, 401, { error: 'Unauthorized' });
        const projectId = segments[3];
        if (!projectId) return this.sendJson(res, 400, { error: 'Project ID is required' });
        const project = await this.db.projects.findById(projectId);
        if (!project || project.userId !== authUser.id)
          return this.sendJson(res, 404, { error: 'Project not found' });
        if (segments.length === 4 && method === 'GET') return this.sendJson(res, 200, project);
        if (segments.length === 5 && segments[4] === 'organization' && method === 'PATCH') {
          const organizationId =
            typeof body['organizationId'] === 'string' ? body['organizationId'] : undefined;
          if (
            organizationId &&
            !(await this.db.organizations.getMembership(organizationId, authUser.id))
          )
            return this.sendJson(res, 404, { error: 'Organization not found' });
          return this.sendJson(
            res,
            200,
            await this.db.projects.update(
              projectId,
              organizationId ? { organizationId } : { organizationId: undefined },
            ),
          );
        }
        if (segments.length === 5 && segments[4] === 'preferences' && method === 'PATCH') {
          const preferences = { ...project.preferences };
          if (body['defaultTrustProfile'] !== undefined) {
            if (!isTrustProfile(body['defaultTrustProfile']))
              return this.sendJson(res, 400, { error: 'Invalid defaultTrustProfile' });
            preferences.defaultTrustProfile = body['defaultTrustProfile'];
          }
          if (typeof body['defaultBranch'] === 'string')
            preferences.defaultBranch = body['defaultBranch'];
          if (body['repository'] !== undefined) {
            const repository = parseRepositoryBinding(body['repository']);
            if (!repository) {
              return this.sendJson(res, 400, {
                error: 'repository must include a supported provider and a valid repository path',
              });
            }
            const credential = await this.getVcsCredential(authUser.id, repository.provider);
            if (!credential) {
              return this.sendJson(res, 409, {
                error: repository.provider + ' is not connected for this account',
              });
            }
            let verifiedRepository: RepositoryBinding;
            try {
              const verified = await new VcsClient(
                repository.provider,
                credential.accessToken,
              ).getRepository(repository.fullName);
              verifiedRepository = {
                provider: verified.provider,
                fullName: verified.fullName,
                ...(verified.defaultBranch ? { defaultBranch: verified.defaultBranch } : {}),
                ...(verified.webUrl ? { webUrl: verified.webUrl } : {}),
              };
            } catch {
              return this.sendJson(res, 422, {
                error:
                  'The connected ' + repository.provider + ' account cannot access that repository',
              });
            }
            preferences.repository = verifiedRepository;
            if (verifiedRepository.defaultBranch)
              preferences.defaultBranch = verifiedRepository.defaultBranch;
            if (verifiedRepository.provider === 'github')
              preferences.githubRepository = verifiedRepository.fullName;
            else delete preferences.githubRepository;
          }
          if (typeof body['githubRepository'] === 'string') {
            const legacyRepository = parseRepositoryBinding({
              provider: 'github',
              fullName: body['githubRepository'],
            });
            if (!legacyRepository)
              return this.sendJson(res, 400, { error: 'Invalid GitHub repository' });
            const credential = await this.getVcsCredential(authUser.id, 'github');
            if (!credential) {
              return this.sendJson(res, 409, { error: 'github is not connected for this account' });
            }
            try {
              const verified = await new VcsClient('github', credential.accessToken).getRepository(
                legacyRepository.fullName,
              );
              preferences.repository = {
                provider: verified.provider,
                fullName: verified.fullName,
                ...(verified.defaultBranch ? { defaultBranch: verified.defaultBranch } : {}),
                ...(verified.webUrl ? { webUrl: verified.webUrl } : {}),
              };
              preferences.githubRepository = verified.fullName;
              if (verified.defaultBranch) preferences.defaultBranch = verified.defaultBranch;
            } catch {
              return this.sendJson(res, 422, {
                error: 'The connected github account cannot access that repository',
              });
            }
          }
          if (typeof body['preferredAdapter'] === 'string')
            preferences.preferredAdapter = body['preferredAdapter'];
          if (
            Array.isArray(body['protectedBranches']) &&
            body['protectedBranches'].every((item) => typeof item === 'string')
          ) {
            preferences.protectedBranches = body['protectedBranches'];
          }
          return this.sendJson(res, 200, await this.db.projects.update(projectId, { preferences }));
        }
        if (segments.length === 5 && segments[4] === 'dashboard' && method === 'GET') {
          const allSessions = await this.db.sessions.listByUser(authUser.id);
          const sessions = allSessions.filter(
            (item) =>
              item.projectId === projectId ||
              (!item.projectId && resolve(item.projectRoot) === project.root),
          );
          const activeStates = new Set([
            'initializing',
            'running',
            'waiting_for_approval',
            'paused',
          ]);
          const eventGroups = await Promise.all(
            sessions.map((item) => this.db.events.listBySession(item.id, 0, 100)),
          );
          const approvalGroups = await Promise.all(
            sessions.map((item) => this.db.approvals.listBySession(item.id)),
          );
          const sessionIds = new Set(sessions.map((item) => item.id));
          const gitActivity = (await this.db.audit.list({ limit: 1000 })).filter(
            (item) =>
              item.sessionId && sessionIds.has(item.sessionId) && item.action.startsWith('git.'),
          );
          const policyVersion = await this.policyService.getActivePolicyVersion();
          const policies = (policyVersion?.rules ?? []).filter(
            (rule) => rule.match.projectId === projectId,
          );
          const activeSessions = sessions.filter((item) => activeStates.has(item.state));
          const statusSession = activeSessions[0] ?? sessions[0];
          let gitStatus: unknown = null;
          if (statusSession) {
            const statusAck = await this.tunnelServer.sendCommandToDevice(
              statusSession.deviceId,
              'git.status',
              { sessionId: statusSession.id, projectRoot: project.root },
            );
            const ackPayload =
              typeof statusAck.payload === 'object' && statusAck.payload !== null
                ? (statusAck.payload as { result?: unknown })
                : null;
            gitStatus = ackPayload?.result ?? null;
          }
          const historyLimit = Math.min(
            Math.max(Number(url.searchParams.get('limit') ?? 50), 1),
            200,
          );
          const historyOffset = Math.max(Number(url.searchParams.get('offset') ?? 0), 0);
          const history = [
            ...sessions.map((item) => ({ type: 'session', timestamp: item.startedAt, item })),
            ...gitActivity.map((item) => ({ type: 'audit', timestamp: item.timestamp, item })),
          ]
            .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
            .slice(historyOffset, historyOffset + historyLimit);
          return this.sendJson(res, 200, {
            project,
            preferences: project.preferences,
            repository: {
              id: project.id,
              name: project.name,
              binding:
                project.preferences.repository ??
                (project.preferences.githubRepository
                  ? { provider: 'github', fullName: project.preferences.githubRepository }
                  : null),
              githubRepository: project.preferences.githubRepository ?? null,
              status: gitStatus,
            },
            workspace: { root: project.root },
            defaultBranch: project.preferences.defaultBranch ?? 'main',
            policies,
            agentPreferences: {
              preferredAdapter: project.preferences.preferredAdapter ?? null,
              defaultTrustProfile: project.preferences.defaultTrustProfile ?? null,
            },
            activeSessions,
            history,
            activeAgents: sessions
              .filter((item) => activeStates.has(item.state))
              .map((item) => ({ sessionId: item.id, agentId: item.agentId, state: item.state })),
            tasks: sessions.map((item) => ({
              sessionId: item.id,
              state: item.state,
              startedAt: item.startedAt,
              completedAt: item.completedAt,
            })),
            gitActivity,
            pendingApprovals: approvalGroups.flat().filter((item) => item.status === 'pending'),
            recentEvents: eventGroups
              .flat()
              .sort((a, b) => b.storedAt.getTime() - a.storedAt.getTime())
              .slice(0, 100),
            reviews: sessions.filter((item) => item.reviewBundle).map((item) => item.reviewBundle),
          });
        }
        if (
          method === 'POST' &&
          ((segments.length === 6 && segments[4] === 'github' && segments[5] === 'pull-request') ||
            (segments.length === 5 && segments[4] === 'pull-requests'))
        ) {
          const binding =
            project.preferences.repository ??
            (project.preferences.githubRepository
              ? { provider: 'github' as const, fullName: project.preferences.githubRepository }
              : undefined);
          if (!binding || !binding.fullName.includes('/'))
            return this.sendJson(res, 409, {
              error: 'Project has no connected source-control repository configured',
            });
          if (segments[4] === 'github' && binding.provider !== 'github') {
            return this.sendJson(res, 409, {
              error: 'This project is connected to ' + binding.provider + ', not GitHub',
            });
          }
          const repository = binding.fullName;
          const title = typeof body['title'] === 'string' ? body['title'] : undefined;
          const head = typeof body['head'] === 'string' ? body['head'] : undefined;
          const base =
            typeof body['base'] === 'string'
              ? body['base']
              : (project.preferences.defaultBranch ?? 'main');
          if (!title || !head)
            return this.sendJson(res, 400, { error: 'title and head are required' });
          const sessions = (await this.db.sessions.listByUser(authUser.id)).filter(
            (item) => item.projectId === projectId,
          );
          const policySession = sessions.at(-1);
          if (!policySession)
            return this.sendJson(res, 409, {
              error: 'A project session is required for policy evaluation',
            });
          const decision = await this.policyService.evaluate('git.pull_request_create', 'medium', {
            resource: `${repository}:${head}->${base}`,
            projectId,
            deviceId: policySession.deviceId,
            sessionId: policySession.id,
            userId: authUser.id,
          });
          if (decision.decision === 'deny') return this.sendJson(res, 403, { decision });
          if (decision.decision === 'require_approval') {
            const approval = await this.approvalWorkflow.createApproval({
              sessionId: policySession.id,
              deviceId: policySession.deviceId,
              userId: authUser.id,
              actionType: 'git.pull_request_create',
              description: `Create pull request ${repository}:${head}->${base}`,
              details: {
                riskClass: 'medium',
                resource: `${repository}:${head}->${base}`,
                pendingControlAction: {
                  type: 'vcs.pull_request_create',
                  provider: binding.provider,
                  projectId,
                  repository,
                  title,
                  head,
                  base,
                  ...(typeof body['description'] === 'string'
                    ? { description: body['description'] }
                    : {}),
                },
              },
              policyVersion: decision.policyVersion,
              matchedRules: decision.matchedRules,
              ...(decision.requiredRole ? { requiredRole: decision.requiredRole } : {}),
              expiresAt: decision.expiresAt,
            });
            return this.sendJson(res, 202, { decision: 'require_approval', approval });
          }
          const credential = await this.getVcsCredential(authUser.id, binding.provider);
          if (!credential) {
            return this.sendJson(res, 409, { error: binding.provider + ' is not connected' });
          }
          const pullRequest = await new VcsClient(
            binding.provider,
            credential.accessToken,
          ).createPullRequest({
            repository,
            title,
            head,
            base,
            ...(typeof body['description'] === 'string'
              ? { description: body['description'] }
              : {}),
          });
          await this.auditLog.record({
            actor: { type: 'user', id: authUser.id },
            sessionId: policySession.id,
            deviceId: policySession.deviceId,
            action: 'git.pull_request_create',
            decision: 'allow',
            policyVersion: decision.policyVersion,
          });
          return this.sendJson(res, 201, pullRequest);
        }
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
        let deviceId = typeof body['deviceId'] === 'string' ? body['deviceId'] : undefined;
        let agentId = typeof body['agentId'] === 'string' ? body['agentId'] : 'mock';
        const projectRoot =
          typeof body['projectRoot'] === 'string' ? body['projectRoot'] : process.cwd();
        const prompt = typeof body['prompt'] === 'string' ? body['prompt'] : undefined;
        const requestedProjectId =
          typeof body['projectId'] === 'string' ? body['projectId'] : undefined;
        const rawConfig =
          typeof body['config'] === 'object' && body['config'] !== null
            ? body['config']
            : undefined;

        let project = requestedProjectId
          ? await this.db.projects.findById(requestedProjectId)
          : await this.db.projects.findByRoot(authUser.id, resolve(projectRoot));
        if (project && project.userId !== authUser.id)
          return this.sendJson(res, 404, { error: 'Project not found' });
        if (!project) {
          const root = resolve(projectRoot);
          project = await this.db.projects.create({
            id: `proj_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
            userId: authUser.id,
            name: basename(root),
            root,
            preferences: { protectedBranches: ['main', 'master'] },
          });
        }

        let device = deviceId ? await this.db.devices.findById(deviceId) : null;
        if (deviceId && (!device || device.userId !== authUser.id)) {
          return this.sendJson(res, 404, { error: 'Device not found or not owned by you' });
        }
        if (!deviceId) {
          if (!this.agentRouter)
            return this.sendJson(res, 503, { error: 'Routing service unavailable' });
          const taskKind = typeof body['taskKind'] === 'string' ? body['taskKind'] : 'general';
          if (
            !['implementation', 'test', 'security_review', 'planning', 'general'].includes(taskKind)
          )
            return this.sendJson(res, 400, { error: 'Invalid taskKind' });
          const route = await this.agentRouter.route(authUser.id, {
            projectId: project.id,
            taskKind: taskKind as TaskKind,
            ...(typeof body['agentId'] === 'string' ? { requiredAgentId: body['agentId'] } : {}),
            ...(body['routingStrategy'] === 'least_loaded' ||
            body['routingStrategy'] === 'capability_first' ||
            body['routingStrategy'] === 'lowest_risk' ||
            body['routingStrategy'] === 'lowest_cost'
              ? { strategy: body['routingStrategy'] }
              : {}),
          });
          if (!route.selected)
            return this.sendJson(res, 409, { error: 'No eligible online gateway', routing: route });
          deviceId = route.selected.deviceId;
          agentId = route.selected.agentId;
          device = await this.db.devices.findById(deviceId);
        }
        if (!device || !deviceId)
          return this.sendJson(res, 409, { error: 'No eligible online gateway' });

        // A device the caller named explicitly bypasses the router, so the
        // drain check has to happen here too. 503 + Retry-After (not 409)
        // because this is temporary and the client should come back.
        if (
          this.registry.isDeviceOnline(deviceId) &&
          !this.registry.isDeviceAcceptingSessions(deviceId)
        ) {
          const phase = this.registry.getAdmissionPhase(deviceId);
          res.setHeader('Retry-After', '30');
          return this.sendJson(res, 503, {
            error: `Gateway is ${phase} and is not accepting new sessions`,
            code: 'GATEWAY_NOT_ACCEPTING_SESSIONS',
            deviceId,
            admissionPhase: phase,
            retryAfterSeconds: 30,
          });
        }

        const sessionId = `sess_${randomUUID().replace(/-/g, '')}`;
        // The gateway resolves adapters by SessionConfig.adapter (see
        // GatewayImpl.createSession). This previously emitted `agent`, which
        // the gateway silently read as undefined and rejected with
        // "Unknown adapter: undefined" — after the session had already been
        // recorded. `agent` is still accepted from callers as an alias.
        const providedConfig = rawConfig as unknown as
          (Partial<SessionConfig> & { agent?: string; projectId?: string }) | undefined;
        const resolvedPrompt = providedConfig?.prompt ?? prompt;
        const sessionConfig: SessionConfig = {
          ...(providedConfig ?? {}),
          adapter: providedConfig?.adapter ?? providedConfig?.agent ?? agentId,
          projectRoot: providedConfig?.projectRoot ?? projectRoot,
          ...(resolvedPrompt !== undefined ? { prompt: resolvedPrompt } : {}),
          metadata: {
            ...(providedConfig?.metadata ?? {}),
            // The gateway adopts this id instead of minting its own, so events
            // come back keyed by the id this record is stored under.
            sessionId,
            projectId: project.id,
            agentId,
          },
        };

        const sessionRecord = await this.db.sessions.create({
          id: sessionId,
          userId: authUser.id,
          deviceId,
          gatewayId: device.gatewayId,
          agentId,
          projectId: project.id,
          ...(project.organizationId ? { organizationId: project.organizationId } : {}),
          projectRoot,
          state: 'initializing',
          trustProfile: project.preferences.defaultTrustProfile ?? device.defaultTrustProfile,
          config: sessionConfig,
          startedAt: new Date(),
        });

        try {
          if (this.registry.isDeviceOnline(deviceId)) {
            const result = await this.tunnelServer.sendCommandToDevice(deviceId, 'session.start', {
              sessionId,
              config: sessionRecord.config,
            });
            // An ack only means the gateway received the command. The gateway
            // reports the *outcome* in the ack payload: treating any ack as
            // success marks a session "running" even when the adapter refused
            // to start, leaving a live-looking session that emits nothing.
            const ackPayload = (result.payload ?? {}) as { success?: boolean; error?: string };
            const startedOk = ackPayload.success !== false;

            if (result.acknowledged && startedOk) {
              // The ack only says the gateway took the command. Wait for the
              // gateway to report that the adapter actually started before
              // calling this session running — otherwise a session that failed
              // to launch is indistinguishable from one that is working.
              const startOutcome = await this.tunnelServer.waitForSessionStart(sessionId);
              if (startOutcome.started) {
                await this.db.sessions.update(sessionId, { state: 'running' });
                sessionRecord.state = 'running';
              } else {
                const errMsg = startOutcome.error ?? 'Session did not start';
                await this.db.sessions.update(sessionId, { state: 'failed', error: errMsg });
                sessionRecord.state = 'failed';
                sessionRecord.error = errMsg;
              }
            } else if (result.acknowledged) {
              const errMsg = ackPayload.error ?? 'Gateway rejected the session start command';
              await this.db.sessions.update(sessionId, { state: 'failed', error: errMsg });
              sessionRecord.state = 'failed';
              sessionRecord.error = errMsg;

              // The gateway can begin draining between our admission check and
              // this command landing. That refusal is temporary, so answer 503
              // rather than handing back a failed session the client will
              // treat as broken.
              if (errMsg.includes('not accepting new sessions')) {
                res.setHeader('Retry-After', '30');
                return this.sendJson(res, 503, {
                  error: errMsg,
                  code: 'GATEWAY_NOT_ACCEPTING_SESSIONS',
                  deviceId,
                  retryAfterSeconds: 30,
                });
              }
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

        if (segments.length === 6 && segments[4] === 'git') {
          const operation = segments[5];
          if (!operation) return this.sendJson(res, 404, { error: 'Git operation is required' });
          if (!['branch', 'commit', 'push', 'status'].includes(operation)) {
            return this.sendJson(res, 404, { error: 'Unknown Git operation' });
          }
          if (
            (operation === 'status' && method !== 'GET') ||
            (operation !== 'status' && method !== 'POST')
          ) {
            return this.sendJson(res, 405, { error: 'Method not allowed' });
          }

          const branch =
            typeof body['branch'] === 'string'
              ? body['branch']
              : operation === 'branch' && typeof body['name'] === 'string'
                ? body['name']
                : undefined;
          const remote = typeof body['remote'] === 'string' ? body['remote'] : 'origin';
          const force = body['force'] === true;
          const capability =
            operation === 'branch'
              ? 'git.branch_create'
              : operation === 'commit'
                ? 'git.commit'
                : operation === 'push'
                  ? 'git.push'
                  : 'filesystem.read';
          const sessionProject = session.projectId
            ? await this.db.projects.findById(session.projectId)
            : null;
          const protectedBranch =
            body['protected'] === true ||
            Boolean(
              branch &&
              (sessionProject?.preferences.protectedBranches.includes(branch) ||
                branch === 'main' ||
                branch === 'master'),
            );
          const riskClass =
            operation === 'status'
              ? 'low'
              : operation === 'branch'
                ? protectedBranch
                  ? 'medium'
                  : 'low'
                : operation === 'commit'
                  ? 'medium'
                  : 'high';
          const resource = branch ?? session.projectRoot;
          const decision = await this.policyService.evaluate(capability, riskClass, {
            resource,
            ...(operation === 'push' ? { force } : {}),
            ...(session.projectId ? { projectId: session.projectId } : {}),
            deviceId: session.deviceId,
            sessionId,
            userId: authUser.id,
          });

          if (decision.decision === 'deny') {
            return this.sendJson(res, 403, { decision: 'deny', reason: decision.reason });
          }

          const commandType = operation === 'branch' ? 'git.branch_create' : `git.${operation}`;
          const commandPayload: Record<string, unknown> = {
            sessionId,
            projectRoot: session.projectRoot,
            ...(branch ? { branch } : {}),
            ...(operation === 'branch' && typeof body['fromRef'] === 'string'
              ? { fromRef: body['fromRef'] }
              : {}),
            ...(operation === 'commit' && typeof body['message'] === 'string'
              ? { message: body['message'] }
              : {}),
            ...(operation === 'commit' && Array.isArray(body['files'])
              ? { files: body['files'] }
              : {}),
            ...(operation === 'push' ? { remote, force } : {}),
          };
          if (operation === 'branch' && !branch)
            return this.sendJson(res, 400, { error: 'branch is required' });
          if (
            operation === 'commit' &&
            (typeof body['message'] !== 'string' || !body['message'].trim())
          )
            return this.sendJson(res, 400, { error: 'message is required' });
          if (operation === 'push' && !branch)
            return this.sendJson(res, 400, { error: 'branch is required' });

          if (decision.decision === 'require_approval') {
            const approval = await this.approvalWorkflow.createApproval({
              sessionId,
              deviceId: session.deviceId,
              userId: authUser.id,
              actionType: capability,
              description: `${operation} ${branch ?? ''}`.trim(),
              details: {
                pendingCommand: { commandType, payload: commandPayload },
                riskClass,
                resource,
              },
              policyVersion: decision.policyVersion,
              matchedRules: decision.matchedRules,
              ...(decision.requiredRole ? { requiredRole: decision.requiredRole } : {}),
              expiresAt: decision.expiresAt,
            });
            return this.sendJson(res, 202, { decision: 'require_approval', approval });
          }

          const commandResult = await this.tunnelServer.sendCommandToDevice(
            session.deviceId,
            commandType,
            commandPayload,
          );
          const commandAck =
            typeof commandResult.payload === 'object' && commandResult.payload !== null
              ? (commandResult.payload as { result?: unknown })
              : null;
          return this.sendJson(res, commandResult.delivered ? 200 : 503, {
            decision: 'allow',
            delivered: commandResult.delivered,
            acknowledged: commandResult.acknowledged,
            result:
              commandAck && 'result' in commandAck
                ? commandAck.result
                : (commandResult.payload ?? null),
          });
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

        if (segments.length === 5 && segments[4] === 'review' && method === 'GET') {
          return this.sendJson(
            res,
            200,
            await this.reviewOrchestrator.get(
              sessionId,
              url.searchParams.get('refresh') === 'true',
            ),
          );
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
          const feedback = typeof body['feedback'] === 'string' ? body['feedback'] : undefined; // §7.3 — new optional field for voice feedback

          if (approved === undefined) {
            return this.sendJson(res, 400, { error: '"approved" boolean is required' });
          }

          const currentApproval = await this.approvalWorkflow.getApproval(approvalId);
          if (
            !currentApproval ||
            currentApproval.sessionId !== sessionId ||
            currentApproval.userId !== authUser.id
          ) {
            return this.sendJson(res, 404, { error: 'Approval not found' });
          }
          if (
            currentApproval.requiredRole &&
            authUser.role !== 'owner' &&
            authUser.role !== currentApproval.requiredRole
          ) {
            return this.sendJson(res, 403, {
              error: `${currentApproval.requiredRole} role is required`,
            });
          }
          if (approved && currentApproval.actionType.startsWith('git.')) {
            const details = currentApproval.details ?? {};
            const pending =
              typeof details['pendingCommand'] === 'object' && details['pendingCommand'] !== null
                ? (details['pendingCommand'] as { payload?: Record<string, unknown> })
                : undefined;
            const reEvaluation = await this.policyService.evaluate(
              currentApproval.actionType as Capability,
              (details['riskClass'] as 'low' | 'medium' | 'high' | 'critical') ?? 'high',
              {
                ...(typeof details['resource'] === 'string'
                  ? { resource: details['resource'] }
                  : {}),
                ...(session.projectId ? { projectId: session.projectId } : {}),
                ...(typeof pending?.payload?.['force'] === 'boolean'
                  ? { force: pending.payload['force'] }
                  : {}),
                deviceId: session.deviceId,
                sessionId,
                userId: authUser.id,
              },
            );
            if (reEvaluation.decision === 'deny') {
              await this.approvalWorkflow.handlePolicyChange(approvalId, 'deny');
              return this.sendJson(res, 409, {
                error: 'Approval superseded by current policy',
                decision: reEvaluation,
              });
            }
          }

          // Use the approval workflow state machine (CAS — first valid decision wins)
          const result = await this.approvalWorkflow.submitDecision(
            approvalId,
            authUser.id,
            approved,
            reason,
            feedback,
          );

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

          const decision = approved ? 'granted' : 'denied';
          const pendingCommand = approved && result.record?.details?.['pendingCommand'];
          const pendingControlAction = approved && result.record?.details?.['pendingControlAction'];
          const executable =
            typeof pendingCommand === 'object' && pendingCommand !== null
              ? (pendingCommand as { commandType?: unknown; payload?: unknown })
              : null;
          const controlAction =
            typeof pendingControlAction === 'object' && pendingControlAction !== null
              ? (pendingControlAction as Record<string, unknown>)
              : null;
          const tunnelResult =
            controlAction?.['type'] === 'vcs.pull_request_create' ||
            controlAction?.['type'] === 'github.pull_request_create'
              ? await this.executeApprovedVcsPullRequest(authUser.id, controlAction)
              : executable && typeof executable.commandType === 'string'
                ? await this.tunnelServer.sendCommandToDevice(
                    session.deviceId,
                    executable.commandType,
                    executable.payload ?? {},
                  )
                : await this.tunnelServer.sendCommandToDevice(session.deviceId, 'session.approve', {
                    sessionId,
                    approvalId,
                    decision,
                    reason,
                  });

          // An orchestration approval deliberately carries the deferred session.start
          // command. Keep the durable session state aligned before advancing its DAG.
          if (approved && executable?.commandType === 'session.start' && tunnelResult.delivered) {
            await this.db.sessions.update(sessionId, { state: 'running' });
            const runId = result.record?.details?.['orchestrationRunId'];
            if (typeof runId === 'string' && this.multiAgentOrchestrator) {
              void this.multiAgentOrchestrator
                .advance(runId)
                .catch((error: unknown) =>
                  console.warn(
                    '[Odysseus Control Plane] Could not advance approved orchestration:',
                    error,
                  ),
                );
            }
          }

          // Record the decision in audit log
          await this.auditLog.record({
            actor: { type: 'user', id: authUser.id },
            sessionId,
            deviceId: session.deviceId,
            action:
              controlAction?.['type'] === 'vcs.pull_request_create' ||
              controlAction?.['type'] === 'github.pull_request_create'
                ? 'git.pull_request_create.approval_granted'
                : executable && typeof executable.commandType === 'string'
                  ? `${executable.commandType}.approval_${decision}`
                  : 'approval.decision',
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
              ? ((diff.payload as { result?: { diff?: string }; diff?: string }).result?.diff ??
                (diff.payload as { diff?: string }).diff)
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
        // Was: `const rules = Array.isArray(body['rules']) ? body['rules'] : []`
        // — an unvalidated `any[]` handed straight to the Policy Engine's
        // rule set. A malformed rule (a typo'd `effect`, a missing
        // `priority`, an invalid `capability` enum value) would have
        // silently become part of the security-critical policy
        // configuration rather than being rejected at authoring time. The
        // matching zod schema already existed in @odysseus/schemas; it was
        // just never called from this endpoint.
        const parsed = CreatePolicyVersionSchema.safeParse(body);
        if (!parsed.success) {
          return this.sendJson(res, 400, {
            error: 'Invalid policy version payload',
            details: parsed.error.flatten(),
          });
        }
        const version = await this.policyService.createPolicyVersion(
          authUser.id,
          parsed.data.description,
          parsed.data.rules,
        );
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
        const force = typeof body['force'] === 'boolean' ? body['force'] : undefined;

        if (!capability || !deviceId || !userId) {
          return this.sendJson(res, 400, {
            error: 'capability, deviceId, and userId are required',
          });
        }

        const decision = await this.policyService.evaluate(
          capability as Capability,
          riskClass as 'low' | 'medium' | 'high' | 'critical',
          {
            ...(resource ? { resource } : {}),
            ...(projectId ? { projectId } : {}),
            ...(force !== undefined ? { force } : {}),
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

      // --- ADMIN CONSOLE API ---
      // Every route here requires a live database lookup proving the caller
      // holds admin/owner role — the same invariant the auth audit applied
      // to the rest of the router — and every state-changing action is
      // written to the hash-chained audit log by AdminService.
      if (segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'admin') {
        if (!authUser) return this.sendJson(res, 401, { error: 'Unauthorized' });
        if (!(await this.adminService.isAdmin(authUser.id))) {
          return this.sendJson(res, 403, { error: 'Admin or owner role required' });
        }

        try {
          // GET /api/v1/admin/stats — overview: users, devices, sessions,
          // approvals, integration grants, audit-chain health, uptime.
          if (path === '/api/v1/admin/stats' && method === 'GET') {
            return this.sendJson(res, 200, await this.adminService.getStats());
          }

          // GET /api/v1/admin/users — every user with live status + per-device
          // integration grant matrix + connected providers (GitHub OAuth).
          if (path === '/api/v1/admin/users' && method === 'GET') {
            return this.sendJson(res, 200, await this.adminService.listUsers());
          }

          // GET /api/v1/admin/users/:id — one user's full admin summary
          if (segments.length === 5 && segments[3] === 'users' && method === 'GET') {
            return this.sendJson(res, 200, await this.adminService.getUser(segments[4] ?? ''));
          }

          // POST /api/v1/admin/users/:id/status — suspend or restore an account
          if (
            segments.length === 6 &&
            segments[3] === 'users' &&
            segments[5] === 'status' &&
            method === 'POST'
          ) {
            const status =
              body['status'] === 'suspended' || body['status'] === 'active'
                ? body['status']
                : undefined;
            if (!status) {
              return this.sendJson(res, 400, { error: "status must be 'active' or 'suspended'" });
            }
            const reason = typeof body['reason'] === 'string' ? body['reason'] : undefined;
            return this.sendJson(
              res,
              200,
              await this.adminService.setUserStatus(authUser.id, segments[4] ?? '', status, reason),
            );
          }

          // POST /api/v1/admin/users/:id/terminate — disconnect devices, cancel
          // active sessions, supersede pending approvals. Account stays intact.
          if (
            segments.length === 6 &&
            segments[3] === 'users' &&
            segments[5] === 'terminate' &&
            method === 'POST'
          ) {
            const reason = typeof body['reason'] === 'string' ? body['reason'] : undefined;
            return this.sendJson(
              res,
              200,
              await this.adminService.terminateUser(authUser.id, segments[4] ?? '', reason),
            );
          }

          // DELETE /api/v1/admin/users/:id — hard-delete the account. Requires
          // the user's email in the body as a two-step confirmation.
          if (segments.length === 5 && segments[3] === 'users' && method === 'DELETE') {
            const confirmEmail =
              typeof body['confirmEmail'] === 'string' ? body['confirmEmail'] : '';
            return this.sendJson(
              res,
              200,
              await this.adminService.destroyUser(authUser.id, segments[4] ?? '', confirmEmail),
            );
          }

          // POST /api/v1/admin/users/:id/role — change a platform role (owner-only)
          if (
            segments.length === 6 &&
            segments[3] === 'users' &&
            segments[5] === 'role' &&
            method === 'POST'
          ) {
            const role =
              body['role'] === 'user' || body['role'] === 'admin' || body['role'] === 'owner'
                ? body['role']
                : undefined;
            if (!role) {
              return this.sendJson(res, 400, { error: "role must be 'user', 'admin', or 'owner'" });
            }
            return this.sendJson(
              res,
              200,
              await this.adminService.setUserRole(authUser.id, segments[4] ?? '', role),
            );
          }

          // POST /api/v1/admin/sessions/:id/cancel — kill any session by id
          if (
            segments.length === 6 &&
            segments[3] === 'sessions' &&
            segments[5] === 'cancel' &&
            method === 'POST'
          ) {
            const reason = typeof body['reason'] === 'string' ? body['reason'] : undefined;
            return this.sendJson(
              res,
              200,
              await this.adminService.cancelSession(authUser.id, segments[4] ?? '', reason),
            );
          }

          // GET /api/v1/admin/devices — every paired device across all users
          if (path === '/api/v1/admin/devices' && method === 'GET') {
            const devices = await this.adminService.listAllDevicesForAdmin();
            return this.sendJson(
              res,
              200,
              devices.map((d) => ({
                id: d.id,
                userId: d.userId,
                friendlyName: d.friendlyName,
                platform: d.platform,
                status: d.status,
                online: this.registry.isDeviceOnline(d.id),
                defaultTrustProfile: d.defaultTrustProfile,
                lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
                createdAt: d.createdAt.toISOString(),
              })),
            );
          }

          // GET /api/v1/admin/sessions — every session across all users
          if (path === '/api/v1/admin/sessions' && method === 'GET') {
            const sessions = await this.adminService.listAllSessionsForAdmin();
            const limit = parseInt(url.searchParams.get('limit') ?? '200', 10);
            return this.sendJson(
              res,
              200,
              sessions.slice(0, Number.isFinite(limit) ? Math.max(1, Math.min(limit, 1000)) : 200),
            );
          }

          return this.sendJson(res, 404, { error: `Admin endpoint not found: ${method} ${path}` });
        } catch (error) {
          if (error instanceof AdminActionError) {
            return this.sendJson(res, error.status, { error: error.message });
          }
          throw error;
        }
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

  /**
   * Best-effort client IP for rate-limiting purposes: X-Forwarded-For's first
   * entry, else the socket address.
   *
   * This is caller-controlled and must never be the only thing standing
   * between an attacker and unlimited attempts — a direct request can put
   * anything in the header. Web traffic reaches this server through Vercel,
   * which sets the header from the real client address, and direct traffic
   * does not, so no single proxy-hop count is right for both paths. Anything
   * that needs a hard bound (password guessing) is therefore also limited by a
   * key the caller cannot change: the account itself.
   */
  private getClientIp(req: IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0]!.trim();
    }
    if (Array.isArray(forwarded) && forwarded.length > 0) {
      return forwarded[0]!.trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  private setRefreshCookie(res: ServerResponse, token: string): void {
    const maxAge = this.config.refreshTokenExpiresInSec || 604800;
    // §4.5 of the pre-deployment audit: `Secure` was missing entirely, so
    // this cookie could be transmitted in the clear over a misconfigured or
    // non-TLS connection. Gated on config rather than inspecting the
    // request's own TLS state, since a proxy-terminated connection often
    // makes that detection unreliable (see `handleRequest`'s own
    // `socketEncrypted` guess for the same underlying problem).
    const secure = this.config.secureCookies ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `refreshToken=${token}; Path=/api/v1/auth; HttpOnly; SameSite=Lax${secure}; Max-Age=${maxAge}`,
    );
  }

  private clearRefreshCookie(res: ServerResponse): void {
    const secure = this.config.secureCookies ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `refreshToken=; Path=/api/v1/auth; HttpOnly; SameSite=Lax${secure}; Max-Age=0`,
    );
  }

  /**
   * SECURITY: this previously reflected `req.headers.origin` back verbatim
   * and unconditionally set `Access-Control-Allow-Credentials: true`. That
   * combination lets *any* website the victim visits make a credentialed
   * fetch() to this API — the browser attaches the httpOnly refresh-token
   * cookie automatically, and the reflected origin satisfies the browser's
   * CORS check, so the attacker's own page (no XSS needed) could read the
   * JSON response directly. This is exactly the class of attack the
   * httpOnly-cookie design (Phase 4 §2.3) was meant to close off — an open
   * CORS policy with credentials enabled undoes it completely.
   *
   * Fixed: only echo the request's Origin, and only enable credentials, when
   * that origin is in the configured allowlist (`config.corsOrigins`). An
   * unlisted origin gets no CORS headers at all — the browser then blocks
   * the response from being read, which is the correct, safe default.
   * `corsOrigins: ['*']` (the config default, intended for local dev) never
   * enables credentials, since a wildcard origin combined with credentials
   * is unsafe regardless of what any individual browser currently enforces.
   */
  private setCORS(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    const allowedOrigins = this.config.corsOrigins;
    const allowAll = allowedOrigins.includes('*');

    const isExplicitlyAllowed = isAllowedOrigin(origin, allowedOrigins);

    if (isExplicitlyAllowed && origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    } else if (allowAll) {
      // Dev/wildcard mode: reflect nothing, allow unauthenticated (no
      // cookie) cross-origin requests only. Never combined with credentials.
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else {
      // Origin missing or not on the allowlist: emit no CORS headers.
      // The browser will block the response from being read by that origin.
      return;
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    const requestedHeaders = req.headers['access-control-request-headers'];
    if (requestedHeaders) {
      res.setHeader('Access-Control-Allow-Headers', requestedHeaders);
    } else {
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type,Authorization,X-Request-ID,X-Client-Type',
      );
    }
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  /**
   * Refresh expiring OAuth credentials before handing a token to a provider
   * client. A failed refresh is treated as disconnected; no stale access token
   * is ever sent after its declared expiry.
   */
  private async getVcsCredential(
    userId: string,
    provider: VcsProvider,
  ): Promise<StoredVcsCredential | null> {
    const credential = await this.vcsCredentials.get(userId, provider);
    if (!credential?.expiresAt) return credential;
    const expiry = Date.parse(credential.expiresAt);
    if (!Number.isFinite(expiry) || expiry > Date.now() + 30_000) return credential;
    if (!credential.refreshToken) return null;
    try {
      const refreshed = await this.vcsOAuth.refreshAccessToken(provider, credential.refreshToken);
      const scope = refreshed.scope ?? credential.scope;
      const updated: StoredVcsCredential = {
        ...credential,
        ...refreshed,
        refreshToken: refreshed.refreshToken ?? credential.refreshToken,
        ...(scope ? { scope } : {}),
        connectedAt: credential.connectedAt,
      };
      await this.vcsCredentials.set(userId, provider, updated);
      return updated;
    } catch {
      return null;
    }
  }

  private async executeApprovedVcsPullRequest(
    userId: string,
    action: Record<string, unknown>,
  ): Promise<{
    acknowledged: boolean;
    delivered: boolean;
    sequence: number | null;
    payload?: unknown;
  }> {
    const provider = isVcsProvider(action['provider']) ? action['provider'] : 'github';
    const repository = typeof action['repository'] === 'string' ? action['repository'] : '';
    const title = typeof action['title'] === 'string' ? action['title'] : '';
    const head = typeof action['head'] === 'string' ? action['head'] : '';
    const base = typeof action['base'] === 'string' ? action['base'] : '';
    if (!repository || !title || !head || !base)
      throw new Error('Stored pull request action is invalid');
    const credential = await this.getVcsCredential(userId, provider);
    if (!credential) throw new Error(provider + ' is not connected');
    const pullRequest = await new VcsClient(provider, credential.accessToken).createPullRequest({
      repository,
      title,
      head,
      base,
      ...(typeof action['description'] === 'string' ? { description: action['description'] } : {}),
    });
    return { acknowledged: true, delivered: true, sequence: null, payload: pullRequest };
  }

  /**
   * Sends OAuth results back to the known control-centre origin. Provider
   * callbacks never echo a caller-supplied return URL, which prevents an OAuth
   * completion link being turned into an open redirect.
   */
  private redirectOAuthResult(
    res: ServerResponse,
    provider: VcsProvider,
    status: 'connected' | 'failed',
    reason?: string,
  ): void {
    const fallback = this.config.corsOrigins.find((origin) => origin.startsWith('https://'));
    const base = this.config.frontendUrl ?? fallback;
    if (!base || !isAllowedOrigin(base, this.config.corsOrigins)) {
      return this.sendJson(res, 500, { error: 'OAuth return URL is not configured securely' });
    }
    const target = new URL('/integrations', base);
    target.searchParams.set('provider', provider);
    target.searchParams.set('connection', status);
    if (reason) target.searchParams.set('reason', reason);
    res.writeHead(302, {
      Location: target.toString(),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
    res.end();
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
    return versions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
