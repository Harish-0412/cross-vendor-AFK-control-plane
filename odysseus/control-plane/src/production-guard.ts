/**
 * Refuse to start a production deployment that is configured insecurely.
 *
 * Every check here guards a default that is correct for `pnpm dev` on a laptop
 * and dangerous the moment the process is reachable from the internet. The
 * defaults are deliberately kept — removing them would make local development
 * worse — so the safety has to come from refusing to *run* with them in
 * production.
 *
 * This fails startup rather than warning. A warning in a deploy log is read
 * once, if ever; a deployment that will not boot is read immediately. An
 * insecure Control Plane that starts successfully is the worse outcome,
 * because nothing about it looks wrong.
 */
import { DEV_JWT_SECRET } from './config';
import type { ControlPlaneConfig } from './types';

export interface ProductionGuardInput {
  config: Pick<ControlPlaneConfig, 'jwtSecret' | 'corsOrigins' | 'secureCookies'>;
  env: NodeJS.ProcessEnv;
  /** True when the Control Plane resolved to an in-memory database. */
  usingMemoryDatabase: boolean;
}

const MIN_SECRET_LENGTH = 32;

export function collectProductionConfigErrors(input: ProductionGuardInput): string[] {
  const errors: string[] = [];
  const { config, env } = input;

  if (!env['JWT_SECRET']) {
    errors.push(
      'JWT_SECRET is not set. The development default is published in this repository, ' +
        'so anyone could mint a valid session token for any user. ' +
        'Generate one with: openssl rand -base64 48',
    );
  } else if (config.jwtSecret === DEV_JWT_SECRET) {
    errors.push('JWT_SECRET is set to the development default and must be replaced.');
  } else if (config.jwtSecret.length < MIN_SECRET_LENGTH) {
    errors.push(
      `JWT_SECRET is ${config.jwtSecret.length} characters; use at least ${MIN_SECRET_LENGTH}.`,
    );
  }

  if (!env['CORS_ORIGINS']) {
    errors.push(
      'CORS_ORIGINS is not set, so it defaults to localhost and your deployed frontend ' +
        'will be rejected. Set it to the exact origin of the web app, ' +
        'e.g. https://odysseus.example.com',
    );
  } else if (config.corsOrigins.includes('*')) {
    errors.push(
      'CORS_ORIGINS contains "*". Credentialed requests plus a wildcard origin defeats ' +
        'the cookie security model — list the exact origins instead.',
    );
  } else {
    for (const origin of config.corsOrigins) {
      if (origin.startsWith('http://') && !isLoopback(origin)) {
        errors.push(
          `CORS_ORIGINS contains the insecure origin "${origin}". ` +
            'A production frontend must be served over https.',
        );
      }
    }
  }

  if (input.usingMemoryDatabase) {
    errors.push(
      'No persistent database is configured, so the in-memory store would be used. ' +
        'Hosted containers restart routinely and every restart would erase users, paired ' +
        'devices, sessions and the audit log. Set USE_FIRESTORE=true with Firebase ' +
        'credentials, or run with an explicit database.',
    );
  }

  if (!config.secureCookies) {
    errors.push(
      'SECURE_COOKIES is disabled. Refresh-token cookies would be transmitted over plain ' +
        'http. Set SECURE_COOKIES=true.',
    );
  }

  return errors;
}

export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['NODE_ENV'] === 'production';
}

function isLoopback(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

/**
 * Throws with every problem at once, rather than one per restart cycle.
 * Deploying is slow; finding out about four misconfigurations one deploy at a
 * time is the kind of thing that makes people disable the check.
 */
export function assertProductionConfig(input: ProductionGuardInput): void {
  const errors = collectProductionConfigErrors(input);
  if (errors.length === 0) return;

  const detail = errors.map((error, index) => `  ${index + 1}. ${error}`).join('\n');
  throw new Error(
    `Refusing to start in production with an insecure configuration:\n${detail}\n\n` +
      'See docs/DEPLOYMENT.md for the full environment contract.',
  );
}
