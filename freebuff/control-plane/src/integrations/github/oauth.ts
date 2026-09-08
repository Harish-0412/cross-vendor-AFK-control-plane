import { createHmac, timingSafeEqual } from 'node:crypto';

export const GITHUB_OAUTH_SCOPES = ['repo'] as const;

export class GitHubOAuth {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly callbackUrl: string,
    private readonly stateSecret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  authorizationUrl(userId: string, now = Date.now()): string {
    const payload = Buffer.from(JSON.stringify({ userId, exp: now + 10 * 60_000 })).toString(
      'base64url',
    );
    const signature = createHmac('sha256', this.stateSecret).update(payload).digest('base64url');
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', this.callbackUrl);
    url.searchParams.set('scope', GITHUB_OAUTH_SCOPES.join(' '));
    url.searchParams.set('state', `${payload}.${signature}`);
    return url.toString();
  }

  verifyState(state: string): string {
    const [payload, signature] = state.split('.');
    if (!payload || !signature) throw new Error('Invalid OAuth state');
    const expected = createHmac('sha256', this.stateSecret).update(payload).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new Error('Invalid OAuth state');
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      userId?: unknown;
      exp?: unknown;
    };
    if (
      typeof parsed.userId !== 'string' ||
      typeof parsed.exp !== 'number' ||
      parsed.exp < Date.now()
    )
      throw new Error('Expired OAuth state');
    return parsed.userId;
  }

  async exchangeCode(code: string): Promise<string> {
    const response = await this.fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: this.callbackUrl,
      }),
    });
    const body = (await response.json()) as { access_token?: unknown; error?: unknown };
    if (!response.ok || typeof body.access_token !== 'string')
      throw new Error(`GitHub OAuth exchange failed (${response.status})`);
    return body.access_token;
  }
}
