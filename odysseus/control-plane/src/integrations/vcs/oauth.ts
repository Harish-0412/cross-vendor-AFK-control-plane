import { createHash, randomBytes } from 'node:crypto';

import type { OAuthAccessToken, OAuthProviderConfiguration, VcsProvider } from './types';

interface ProviderDefinition {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopes: readonly string[];
  supportsPkce: boolean;
}

const PROVIDERS: Record<VcsProvider, ProviderDefinition> = {
  github: {
    authorizationEndpoint: 'https://github.com/login/oauth/authorize',
    tokenEndpoint: 'https://github.com/login/oauth/access_token',
    scopes: ['repo'],
    supportsPkce: true,
  },
  gitlab: {
    authorizationEndpoint: 'https://gitlab.com/oauth/authorize',
    tokenEndpoint: 'https://gitlab.com/oauth/token',
    scopes: ['api'],
    supportsPkce: true,
  },
  bitbucket: {
    authorizationEndpoint: 'https://bitbucket.org/site/oauth2/authorize',
    tokenEndpoint: 'https://bitbucket.org/site/oauth2/access_token',
    scopes: ['repository', 'account'],
    // Bitbucket Cloud's confidential OAuth client uses its client secret.
    supportsPkce: false,
  },
};

interface Transaction {
  userId: string;
  provider: VcsProvider;
  verifier?: string;
  expiresAt: number;
}

/**
 * Holds opaque, single-use connection transactions. A restart makes an
 * unfinished callback fail safely rather than accepting an unverifiable state.
 */
export class VcsOAuth {
  private readonly transactions = new Map<string, Transaction>();

  constructor(
    private readonly configurations: Partial<Record<VcsProvider, OAuthProviderConfiguration>>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  isConfigured(provider: VcsProvider): boolean {
    const config = this.configurations[provider];
    return Boolean(config?.clientId && config.clientSecret && config.callbackUrl);
  }

  configuredProviders(): VcsProvider[] {
    return (Object.keys(PROVIDERS) as VcsProvider[]).filter((provider) =>
      this.isConfigured(provider),
    );
  }

  authorizationUrl(
    provider: VcsProvider,
    userId: string,
    now = Date.now(),
  ): { authorizationUrl: string; scopes: readonly string[] } {
    const config = this.requireConfiguration(provider);
    this.purgeExpired(now);
    const state = randomBytes(32).toString('base64url');
    const definition = PROVIDERS[provider];
    const verifier = definition.supportsPkce ? randomBytes(48).toString('base64url') : undefined;
    this.transactions.set(state, {
      userId,
      provider,
      ...(verifier ? { verifier } : {}),
      expiresAt: now + 10 * 60_000,
    });

    const url = new URL(definition.authorizationEndpoint);
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', config.callbackUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', definition.scopes.join(' '));
    url.searchParams.set('state', state);
    if (verifier) {
      url.searchParams.set(
        'code_challenge',
        createHash('sha256').update(verifier).digest('base64url'),
      );
      url.searchParams.set('code_challenge_method', 'S256');
    }
    return { authorizationUrl: url.toString(), scopes: definition.scopes };
  }

  async exchangeCode(
    provider: VcsProvider,
    state: string,
    code: string,
  ): Promise<{ userId: string; token: OAuthAccessToken }> {
    const transaction = this.consume(provider, state);
    const config = this.requireConfiguration(provider);
    const definition = PROVIDERS[provider];
    const fields = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.callbackUrl,
    });
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (provider === 'bitbucket') {
      headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
    } else {
      fields.set('client_id', config.clientId);
      fields.set('client_secret', config.clientSecret);
      if (transaction.verifier) fields.set('code_verifier', transaction.verifier);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(definition.tokenEndpoint, {
        method: 'POST',
        headers,
        body: fields.toString(),
      });
    } catch {
      throw new Error(`Could not reach ${provider} to complete the connection`);
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok || typeof body['access_token'] !== 'string') {
      throw new Error(`${provider} rejected the connection request`);
    }
    const expiresIn = typeof body['expires_in'] === 'number' ? body['expires_in'] : undefined;
    return {
      userId: transaction.userId,
      token: {
        accessToken: body['access_token'],
        ...(typeof body['refresh_token'] === 'string'
          ? { refreshToken: body['refresh_token'] }
          : {}),
        ...(typeof body['scope'] === 'string' ? { scope: body['scope'] } : {}),
        ...(typeof body['token_type'] === 'string' ? { tokenType: body['token_type'] } : {}),
        ...(expiresIn ? { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() } : {}),
      },
    };
  }

  private consume(provider: VcsProvider, state: string, now = Date.now()): Transaction {
    this.purgeExpired(now);
    const transaction = this.transactions.get(state);
    // Consume before calling the provider: a callback can never be replayed.
    this.transactions.delete(state);
    if (!transaction || transaction.provider !== provider || transaction.expiresAt < now) {
      throw new Error(
        'This connection link is invalid or has expired. Start again from Integrations.',
      );
    }
    return transaction;
  }

  private purgeExpired(now: number): void {
    for (const [state, transaction] of this.transactions) {
      if (transaction.expiresAt < now) this.transactions.delete(state);
    }
  }

  private requireConfiguration(provider: VcsProvider): OAuthProviderConfiguration {
    const config = this.configurations[provider];
    if (!config?.clientId || !config.clientSecret || !config.callbackUrl) {
      throw new Error(`${provider} OAuth is not configured`);
    }
    return config;
  }
}

export function scopesFor(provider: VcsProvider): readonly string[] {
  return PROVIDERS[provider].scopes;
}
