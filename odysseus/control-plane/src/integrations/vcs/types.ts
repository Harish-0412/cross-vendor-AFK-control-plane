import type { RepositoryProvider } from '@odysseus/protocol';

export type VcsProvider = RepositoryProvider;

export const VCS_PROVIDERS: readonly VcsProvider[] = ['github', 'gitlab', 'bitbucket'];

export interface OAuthProviderConfiguration {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

export interface OAuthAccessToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
  tokenType?: string;
}

export interface ConnectedAccount {
  username: string;
  displayName?: string;
  avatarUrl?: string;
}

/** Encrypted before it is persisted; no API returns the provider token. */
export interface StoredVcsCredential extends OAuthAccessToken {
  account: ConnectedAccount;
  connectedAt: string;
}

export interface RepositorySummary {
  provider: VcsProvider;
  fullName: string;
  name: string;
  webUrl: string;
  defaultBranch?: string;
  private?: boolean;
}

export interface PullRequestInput {
  repository: string;
  title: string;
  head: string;
  base: string;
  description?: string;
}

export function isVcsProvider(value: unknown): value is VcsProvider {
  return typeof value === 'string' && VCS_PROVIDERS.includes(value as VcsProvider);
}
