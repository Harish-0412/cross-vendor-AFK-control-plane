import type { ControlPlaneConfig } from './types';

/**
 * The development fallback secret.
 *
 * Exported so the production guard can recognise it: this value is public,
 * so a deployment still using it has no session security at all.
 */
export const DEV_JWT_SECRET = 'dev-secret-odysseus-control-plane-change-in-prod-2026';

export const DEFAULT_CONTROL_PLANE_CONFIG: ControlPlaneConfig = {
  host: process.env.CONTROL_PLANE_HOST || '0.0.0.0',
  port: parseInt(process.env.CONTROL_PLANE_PORT || '4000', 10),
  jwtSecret: process.env.JWT_SECRET || DEV_JWT_SECRET,
  jwtExpiresInSec: parseInt(process.env.JWT_EXPIRES_IN_SEC || '86400', 10), // 24 hours
  refreshTokenExpiresInSec: parseInt(process.env.REFRESH_TOKEN_EXPIRES_IN_SEC || '604800', 10), // 7 days
  corsOrigins: process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',')
        .map((s) => s.trim().replace(/\/+$/, ''))
        .filter(Boolean)
    : [
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'https://odysseus-control-center.vercel.app',
        'https://cross-vendor-afk-control-plane.vercel.app',
      ],
  pairingCodeTtlSec: parseInt(process.env.PAIRING_CODE_TTL_SEC || '300', 10), // 5 mins
  heartbeatTimeoutMs: parseInt(process.env.HEARTBEAT_TIMEOUT_MS || '60000', 10), // 60s
  ...(process.env.GITHUB_CLIENT_ID ? { githubClientId: process.env.GITHUB_CLIENT_ID } : {}),
  ...(process.env.GITHUB_CLIENT_SECRET
    ? { githubClientSecret: process.env.GITHUB_CLIENT_SECRET }
    : {}),
  ...(process.env.GITHUB_CALLBACK_URL
    ? { githubCallbackUrl: process.env.GITHUB_CALLBACK_URL }
    : {}),
  ...(process.env.GITLAB_CLIENT_ID ? { gitlabClientId: process.env.GITLAB_CLIENT_ID } : {}),
  ...(process.env.GITLAB_CLIENT_SECRET
    ? { gitlabClientSecret: process.env.GITLAB_CLIENT_SECRET }
    : {}),
  ...(process.env.GITLAB_CALLBACK_URL
    ? { gitlabCallbackUrl: process.env.GITLAB_CALLBACK_URL }
    : {}),
  ...(process.env.BITBUCKET_CLIENT_ID
    ? { bitbucketClientId: process.env.BITBUCKET_CLIENT_ID }
    : {}),
  ...(process.env.BITBUCKET_CLIENT_SECRET
    ? { bitbucketClientSecret: process.env.BITBUCKET_CLIENT_SECRET }
    : {}),
  ...(process.env.BITBUCKET_CALLBACK_URL
    ? { bitbucketCallbackUrl: process.env.BITBUCKET_CALLBACK_URL }
    : {}),
  ...(process.env.FRONTEND_URL ? { frontendUrl: process.env.FRONTEND_URL } : {}),
  ...(process.env.CREDENTIAL_ENCRYPTION_SECRET
    ? { credentialEncryptionSecret: process.env.CREDENTIAL_ENCRYPTION_SECRET }
    : {}),
  secureCookies: process.env.SECURE_COOKIES
    ? process.env.SECURE_COOKIES === 'true'
    : process.env.NODE_ENV === 'production',
};

export function loadConfig(overrides: Partial<ControlPlaneConfig> = {}): ControlPlaneConfig {
  return {
    ...DEFAULT_CONTROL_PLANE_CONFIG,
    ...overrides,
  };
}

export function isAllowedOrigin(
  origin: string | undefined,
  configuredOrigins: string[] = [],
): boolean {
  if (!origin) return false;

  const normalizedOrigin = origin.trim().replace(/\/+$/, '');
  const allowed = configuredOrigins.map((o) => o.trim().replace(/\/+$/, ''));

  if (allowed.includes(normalizedOrigin)) return true;

  // Local development loopback
  if (
    allowed.some((o) => o.includes('localhost') || o.includes('127.0.0.1')) &&
    /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/.test(normalizedOrigin)
  ) {
    return true;
  }

  // Odysseus production and preview frontend domains
  const knownOrigins = [
    'https://odysseus-control-center.vercel.app',
    'https://cross-vendor-afk-control-plane.vercel.app',
  ];
  if (knownOrigins.includes(normalizedOrigin)) {
    return true;
  }

  try {
    const url = new URL(normalizedOrigin);
    if (
      url.protocol === 'https:' &&
      ((url.hostname.startsWith('odysseus-control-center-') &&
        url.hostname.endsWith('.vercel.app')) ||
        (url.hostname.startsWith('cross-vendor-afk-control-plane-') &&
          url.hostname.endsWith('.vercel.app')))
    ) {
      return true;
    }
  } catch {
    // ignore invalid URLs
  }

  return false;
}
