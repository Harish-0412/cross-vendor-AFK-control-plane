import { randomBytes } from 'node:crypto';

import { type DeviceIdentityManager } from '@freebuff/identity';
import {
  type DeviceCertificate,
  isCertificateValid,
  shouldRenewCertificate,
  DEFAULT_CERT_VALIDITY_MS,
  DEFAULT_CERT_RENEW_AT_MS,
} from '@freebuff/protocol';

import {
  type CertificateAuthority,
  type CertificateSigningRequest,
  createCertificateAuthority,
  generateCAKeyMaterial,
  DEFAULT_ROOT_CA_CONFIG,
  DEFAULT_INTERMEDIATE_CA_CONFIG,
} from './ca';
import {
  type RevocationStore,
  type RevocationChecker,
  createRevocationStore,
  createRevocationChecker,
  type RevocationEntry,
} from './revocation';

export interface CertificateManagerOptions {
  autoRenew?: boolean;
  renewAtRemainingMs?: number;
  autoRevokeCheck?: boolean;
  revocationCheckIntervalMs?: number;
  defaultValidityMs?: number;
  useEmbeddedCAForTesting?: boolean;
}

export type CertificateRenewalListener = (
  oldCert: DeviceCertificate,
  newCert: DeviceCertificate,
) => void;

export type CertificateRevocationListener = (deviceId: string, entry: RevocationEntry) => void;

export interface SessionInvalidator {
  pauseAllSessions(deviceId: string, reason: string): Promise<void>;
}

export class CertificateManager {
  private readonly identityManager: DeviceIdentityManager;
  private readonly options: Required<Omit<CertificateManagerOptions, 'useEmbeddedCAForTesting'>> &
    Pick<CertificateManagerOptions, 'useEmbeddedCAForTesting'>;
  private readonly revocationStore: RevocationStore;
  private readonly revocationChecker: RevocationChecker;
  private embeddedCA: CertificateAuthority | null = null;
  private currentCertificate: DeviceCertificate | null = null;
  private renewalTimer: NodeJS.Timeout | null = null;
  private renewalListeners: Set<CertificateRenewalListener> = new Set();
  private revocationListeners: Set<CertificateRevocationListener> = new Set();
  private renewalClient: CertificateRenewalClient | null = null;
  private shuttingDown = false;

  constructor(
    identityManager: DeviceIdentityManager,
    sessionInvalidator?: SessionInvalidator,
    options: CertificateManagerOptions = {},
  ) {
    this.identityManager = identityManager;
    this.options = {
      autoRenew: true,
      renewAtRemainingMs: DEFAULT_CERT_RENEW_AT_MS,
      autoRevokeCheck: true,
      revocationCheckIntervalMs: 60 * 1000,
      defaultValidityMs: DEFAULT_CERT_VALIDITY_MS,
      ...options,
    };

    this.revocationStore = createRevocationStore();
    // Wire store revocation events to manager revocation listeners
    this.revocationStore.onRevocation(async (entry) => {
      for (const listener of this.revocationListeners) {
        try {
          listener(entry.deviceId, entry);
        } catch {
          // swallow
        }
      }
      // Also notify session invalidator if configured
      if (sessionInvalidator && entry.effectiveImmediately) {
        try {
          await sessionInvalidator.pauseAllSessions(
            entry.deviceId,
            `Device revoked: ${entry.reason}`,
          );
        } catch {
          // swallow
        }
      }
    });
    this.revocationChecker = createRevocationChecker(
      this.revocationStore,
      undefined,
      sessionInvalidator
        ? async (deviceId: string, reason: string) => {
            await sessionInvalidator.pauseAllSessions(deviceId, reason);
            for (const listener of this.revocationListeners) {
              const entry = this.revocationStore.get(deviceId);
              if (entry) {
                try {
                  listener(deviceId, entry);
                } catch {
                  // swallow
                }
              }
            }
          }
        : undefined,
    );

    if (this.options.useEmbeddedCAForTesting) {
      const rootKey = generateCAKeyMaterial('EC', 'prime256v1');
      const intermediateKey = generateCAKeyMaterial('EC', 'prime256v1');
      this.embeddedCA = createCertificateAuthority(
        rootKey,
        DEFAULT_ROOT_CA_CONFIG,
        intermediateKey,
        DEFAULT_INTERMEDIATE_CA_CONFIG,
      );
    }
  }

  setRenewalClient(client: CertificateRenewalClient | null): void {
    this.renewalClient = client;
  }

  getRevocationChecker(): RevocationChecker {
    return this.revocationChecker;
  }

  getRevocationStore(): RevocationStore {
    return this.revocationStore;
  }

  hasCertificate(): boolean {
    return this.currentCertificate !== null;
  }

  getCurrentCertificate(): DeviceCertificate | null {
    return this.currentCertificate;
  }

  isCertificateValidNow(): boolean {
    if (!this.currentCertificate) return false;
    return isCertificateValid(this.currentCertificate);
  }

  needsRenewal(): boolean {
    if (!this.currentCertificate) return true;
    return shouldRenewCertificate(this.currentCertificate);
  }

  getCertificateChain() {
    if (!this.currentCertificate || !this.embeddedCA) {
      return null;
    }
    return this.embeddedCA.getCertificateChain(this.currentCertificate);
  }

  async issueInitialCertificate(): Promise<DeviceCertificate> {
    if (this.currentCertificate && isCertificateValid(this.currentCertificate)) {
      return this.currentCertificate;
    }

    const identity = this.identityManager.getIdentity();
    const csr: CertificateSigningRequest = {
      deviceId: identity.deviceId,
      gatewayId: identity.gatewayId,
      publicKeyPem: identity.publicKeyPem,
      deviceFingerprintHex: identity.fingerprint.hex,
      validityMs: this.options.defaultValidityMs,
      signedChallenge: {
        nonce: randomBytes(32).toString('hex'),
        signature: '',
      },
    };
    csr.signedChallenge.signature = this.identityManager.sign(
      JSON.stringify({ nonce: csr.signedChallenge.nonce, deviceId: csr.deviceId }),
    );

    let cert: DeviceCertificate;
    if (this.embeddedCA) {
      cert = this.embeddedCA.issueDeviceCertificate(csr);
    } else if (this.renewalClient) {
      cert = await this.renewalClient.requestInitialCertificate(csr);
    } else {
      throw new Error(
        'No CA available for issuing certificate. Configure embedded CA or renewal client.',
      );
    }

    this.currentCertificate = cert;
    this.scheduleRenewal();

    if (this.options.autoRevokeCheck) {
      this.revocationChecker.startAutoRefresh(this.options.revocationCheckIntervalMs);
    }

    return cert;
  }

  async renewCertificate(): Promise<DeviceCertificate> {
    if (!this.currentCertificate) {
      return this.issueInitialCertificate();
    }

    const identity = this.identityManager.getIdentity();
    const csr: CertificateSigningRequest = {
      deviceId: identity.deviceId,
      gatewayId: identity.gatewayId,
      publicKeyPem: identity.publicKeyPem,
      deviceFingerprintHex: identity.fingerprint.hex,
      validityMs: this.options.defaultValidityMs,
      signedChallenge: {
        nonce: randomBytes(32).toString('hex'),
        signature: '',
      },
    };
    csr.signedChallenge.signature = this.identityManager.sign(
      JSON.stringify({
        nonce: csr.signedChallenge.nonce,
        deviceId: csr.deviceId,
        previousCertThumbprint: this.currentCertificate.thumbprint,
      }),
    );

    let newCert: DeviceCertificate;
    if (this.embeddedCA) {
      newCert = this.embeddedCA.issueDeviceCertificate(csr);
    } else if (this.renewalClient) {
      newCert = await this.renewalClient.renewCertificate(this.currentCertificate, csr);
    } else {
      throw new Error('No CA available for renewing certificate.');
    }

    const oldCert = this.currentCertificate;
    this.currentCertificate = newCert;

    for (const listener of this.renewalListeners) {
      try {
        listener(oldCert, newCert);
      } catch {
        // swallow
      }
    }

    this.scheduleRenewal();
    return newCert;
  }

  onRenewal(listener: CertificateRenewalListener): () => void {
    this.renewalListeners.add(listener);
    return () => this.renewalListeners.delete(listener);
  }

  onRevocation(listener: CertificateRevocationListener): () => void {
    this.revocationListeners.add(listener);
    return () => this.revocationListeners.delete(listener);
  }

  async checkRevocation(certificateThumbprint?: string): Promise<boolean> {
    const identity = this.identityManager.getIdentity();
    const thumbprint = certificateThumbprint ?? this.currentCertificate?.thumbprint ?? '';
    const status = await this.revocationChecker.check(identity.deviceId, thumbprint);
    return status.revoked;
  }

  private scheduleRenewal(): void {
    this.clearRenewalTimer();
    if (!this.options.autoRenew || !this.currentCertificate) return;
    if (this.shuttingDown) return;

    const now = Date.now();
    const expiresAt = this.currentCertificate.expiresAt.getTime();
    const renewAt = expiresAt - this.options.renewAtRemainingMs;
    const delay = Math.max(0, renewAt - now);

    this.renewalTimer = setTimeout(() => {
      void this.autoRenewInternal();
    }, delay);
    if (typeof this.renewalTimer.unref === 'function') {
      this.renewalTimer.unref();
    }
  }

  private async autoRenewInternal(): Promise<void> {
    if (this.shuttingDown) return;
    try {
      await this.renewCertificate();
    } catch {
      // Retry with shorter delay (5 minutes)
      this.clearRenewalTimer();
      this.renewalTimer = setTimeout(
        () => {
          void this.autoRenewInternal();
        },
        5 * 60 * 1000,
      );
      if (typeof this.renewalTimer.unref === 'function') {
        this.renewalTimer.unref();
      }
    }
  }

  private clearRenewalTimer(): void {
    if (this.renewalTimer) {
      clearTimeout(this.renewalTimer);
      this.renewalTimer = null;
    }
  }

  setEmbeddedCAForTesting(): void {
    if (this.embeddedCA) return;
    const rootKey = generateCAKeyMaterial('EC', 'prime256v1');
    const intermediateKey = generateCAKeyMaterial('EC', 'prime256v1');
    this.embeddedCA = createCertificateAuthority(
      rootKey,
      DEFAULT_ROOT_CA_CONFIG,
      intermediateKey,
      DEFAULT_INTERMEDIATE_CA_CONFIG,
    );
  }

  getEmbeddedCARootPem(): string | null {
    return this.embeddedCA ? this.embeddedCA.getRootCertificatePem() : null;
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.clearRenewalTimer();
    this.revocationChecker.shutdown();
    this.renewalListeners.clear();
    this.revocationListeners.clear();
  }
}

export interface CertificateRenewalClient {
  requestInitialCertificate(csr: CertificateSigningRequest): Promise<DeviceCertificate>;
  renewCertificate(
    currentCert: DeviceCertificate,
    csr: CertificateSigningRequest,
  ): Promise<DeviceCertificate>;
}

export function createCertificateManager(
  identityManager: DeviceIdentityManager,
  sessionInvalidator?: SessionInvalidator,
  options?: CertificateManagerOptions,
): CertificateManager {
  return new CertificateManager(identityManager, sessionInvalidator, options);
}
