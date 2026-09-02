import { randomBytes } from 'node:crypto';

import {
  type DeviceIdentityManager,
  formatFingerprintForDisplay,
  fingerprintToQrPayload,
} from '@freebuff/identity';
import {
  type DeviceIdentity,
  type PairingCode,
  type DeviceCertificate,
  isPairingCodeExpired,
} from '@freebuff/protocol';

import {
  createPairingCode,
  type PairingRateLimiter,
  createPairingRateLimiter,
} from './code-generator';
import {
  type PairingSession,
  type PairingState,
  type PairingStartOptions,
  type PairingConfirmation,
  type ControlPlanePairingRequest,
  type ControlPlanePairingResponse,
  type PairingCompleteResult,
  DEFAULT_PAIRING_TTL_MS,
  DEFAULT_MAX_RETRIES,
  PAIRING_POLL_INTERVAL_MS,
  PAIRING_MAX_POLL_ATTEMPTS,
} from './types';

export interface PairingManagerOptions {
  autoStartPolling?: boolean;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
}

export interface PairingEventListener {
  (event: PairingEvent): void;
}

export interface PairingEvent {
  type:
    | 'session_created'
    | 'code_display'
    | 'fingerprint_confirm_required'
    | 'polling_started'
    | 'polling_stopped'
    | 'pairing_pending'
    | 'pairing_success'
    | 'pairing_failed'
    | 'session_expired'
    | 'session_cancelled'
    | 'error';
  timestamp: Date;
  sessionId?: string | undefined;
  payload?: unknown;
  error?: string;
}

const PAIRING_SESSION_ID_PREFIX = 'pair_';

export class PairingManager {
  private readonly identityManager: DeviceIdentityManager;
  private readonly options: Required<PairingManagerOptions>;
  private readonly rateLimiter: PairingRateLimiter;
  private currentSession: PairingSession | null = null;
  private listeners: Set<PairingEventListener> = new Set();
  private pollTimer: NodeJS.Timeout | null = null;
  private pollAttempts = 0;
  private shuttingDown = false;
  private controlPlaneClient: ControlPlanePairingClient | null = null;

  constructor(
    identityManager: DeviceIdentityManager,
    options: PairingManagerOptions = {},
    rateLimiter?: PairingRateLimiter,
  ) {
    this.identityManager = identityManager;
    this.options = {
      autoStartPolling: false,
      pollIntervalMs: PAIRING_POLL_INTERVAL_MS,
      maxPollAttempts: PAIRING_MAX_POLL_ATTEMPTS,
      ...options,
    };
    this.rateLimiter = rateLimiter ?? createPairingRateLimiter();
  }

  setControlPlaneClient(client: ControlPlanePairingClient | null): void {
    this.controlPlaneClient = client;
  }

  onEvent(listener: PairingEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getCurrentSession(): PairingSession | null {
    return this.currentSession;
  }

  getState(): PairingState {
    return this.currentSession?.state ?? 'idle';
  }

  async startPairing(options: PairingStartOptions = {}): Promise<PairingConfirmation> {
    if (this.shuttingDown) {
      throw new Error('Pairing manager is shutting down');
    }

    if (
      this.currentSession &&
      this.currentSession.state !== 'expired' &&
      this.currentSession.state !== 'cancelled' &&
      this.currentSession.state !== 'error'
    ) {
      if (
        !isPairingCodeExpired({
          code: this.currentSession.code,
          issuedAt: this.currentSession.createdAt,
          expiresAt: this.currentSession.expiresAt,
          deviceId: this.currentSession.deviceId,
          publicKeyFingerprint: this.currentSession.fingerprintHex,
        })
      ) {
        return this.buildConfirmation(this.currentSession);
      }
      await this.cancelPairing('Expired pairing replaced');
    }

    if (!this.rateLimiter.canGenerateCode()) {
      this.emitEvent({
        type: 'error',
        timestamp: new Date(),
        error: 'Rate limit exceeded for pairing code generation',
      });
      throw new Error('Too many pairing code attempts. Please wait and try again.');
    }

    const identity = this.identityManager.getIdentity();
    const ttlMs = options.ttlMs ?? DEFAULT_PAIRING_TTL_MS;
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

    this.updateState('generating_code');

    const pairingCode: PairingCode = createPairingCode(
      identity.deviceId,
      identity.fingerprint.hex,
      ttlMs,
    );
    this.rateLimiter.recordCodeGeneration();

    const sessionId = this.generateSessionId();
    const session: PairingSession = {
      id: sessionId,
      code: pairingCode.code,
      deviceId: identity.deviceId,
      gatewayId: identity.gatewayId,
      state: 'awaiting_user_input',
      fingerprintHex: identity.fingerprint.hex,
      fingerprintWords: identity.fingerprint.words,
      fingerprintShort: identity.fingerprint.shortCode,
      qrPayload: fingerprintToQrPayload(
        identity.fingerprint,
        identity.deviceId,
        identity.gatewayId,
      ),
      createdAt: pairingCode.issuedAt,
      expiresAt: pairingCode.expiresAt,
      ttlMs,
      retryCount: 0,
      maxRetries,
      controlPlaneEndpoint: options.controlPlaneEndpoint,
    };

    this.currentSession = session;
    this.emitEvent({
      type: 'session_created',
      timestamp: new Date(),
      sessionId,
      payload: { code: session.code },
    });
    this.emitEvent({
      type: 'code_display',
      timestamp: new Date(),
      sessionId,
      payload: {
        code: session.code,
        fingerprintWords: session.fingerprintWords,
        fingerprintShort: session.fingerprintShort,
        qrPayload: session.qrPayload,
        expiresAt: session.expiresAt,
      },
    });

    this.printPairingInstructions(session);

    if (this.options.autoStartPolling) {
      this.startPolling();
    }

    return this.buildConfirmation(session);
  }

  async cancelPairing(reason?: string): Promise<void> {
    if (!this.currentSession) return;
    this.stopPolling();
    const sessionId = this.currentSession.id;
    this.currentSession.state = 'cancelled';
    this.currentSession.cancelledAt = new Date();
    this.emitEvent({
      type: 'session_cancelled',
      timestamp: new Date(),
      sessionId,
      payload: { reason: reason ?? 'User cancelled' },
    });
    this.currentSession = null;
  }

  startPolling(): void {
    if (this.pollTimer) return;
    if (!this.currentSession) {
      throw new Error('No active pairing session to poll for');
    }
    this.pollAttempts = 0;
    this.emitEvent({
      type: 'polling_started',
      timestamp: new Date(),
      sessionId: this.currentSession.id,
    });
    this.updateState('awaiting_fingerprint_confirm');
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, this.options.pollIntervalMs);
    if (typeof this.pollTimer.unref === 'function') {
      this.pollTimer.unref();
    }
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      const sessionId = this.currentSession?.id;
      this.emitEvent({ type: 'polling_stopped', timestamp: new Date(), sessionId });
    }
  }

  private async pollOnce(): Promise<void> {
    if (this.shuttingDown || !this.currentSession) {
      this.stopPolling();
      return;
    }

    this.pollAttempts++;

    if (
      isPairingCodeExpired({
        code: this.currentSession.code,
        issuedAt: this.currentSession.createdAt,
        expiresAt: this.currentSession.expiresAt,
        deviceId: this.currentSession.deviceId,
        publicKeyFingerprint: this.currentSession.fingerprintHex,
      })
    ) {
      const sessionId = this.currentSession.id;
      this.currentSession.state = 'expired';
      this.emitEvent({ type: 'session_expired', timestamp: new Date(), sessionId });
      this.stopPolling();
      this.currentSession = null;
      return;
    }

    if (this.pollAttempts >= this.options.maxPollAttempts) {
      this.stopPolling();
      return;
    }

    if (this.controlPlaneClient && this.currentSession) {
      try {
        const identity = this.identityManager.getIdentity();
        const request = this.buildControlPlaneRequest(identity);
        const response = await this.controlPlaneClient.checkPairingStatus(request);

        if (response.success && response.deviceTrusted) {
          await this.handlePairingSuccess(response);
          return;
        }

        if (response.success && response.requiresFingerprintConfirm) {
          this.updateState('awaiting_fingerprint_confirm');
          this.emitEvent({
            type: 'fingerprint_confirm_required',
            timestamp: new Date(),
            sessionId: this.currentSession.id,
            payload: {
              fingerprintWords: this.currentSession.fingerprintWords,
              fingerprintShort: this.currentSession.fingerprintShort,
            },
          });
        } else if (!response.success) {
          if (this.currentSession.retryCount >= this.currentSession.maxRetries) {
            const sessionId = this.currentSession.id;
            const error = response.error ?? 'Max retries exceeded';
            this.currentSession.state = 'error';
            this.currentSession.error = error;
            this.emitEvent({
              type: 'pairing_failed',
              timestamp: new Date(),
              sessionId,
              error,
            });
            this.stopPolling();
            this.currentSession = null;
          } else {
            this.currentSession.retryCount++;
            this.emitEvent({
              type: 'pairing_pending',
              timestamp: new Date(),
              sessionId: this.currentSession.id,
              payload: { retryCount: this.currentSession.retryCount },
            });
          }
        } else {
          this.emitEvent({
            type: 'pairing_pending',
            timestamp: new Date(),
            sessionId: this.currentSession.id,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.emitEvent({
          type: 'error',
          timestamp: new Date(),
          sessionId: this.currentSession?.id,
          error: `Poll error: ${message}`,
        });
      }
    }
  }

  private async handlePairingSuccess(_response: ControlPlanePairingResponse): Promise<void> {
    if (!this.currentSession) return;

    this.stopPolling();
    const session = this.currentSession;
    session.state = 'awaiting_certificate';

    if (this.controlPlaneClient) {
      try {
        const identity = this.identityManager.getIdentity();
        const request = this.buildControlPlaneRequest(identity);
        const certificate = await this.controlPlaneClient.requestDeviceCertificate(request);

        session.state = 'paired';
        session.pairedAt = new Date();

        this.emitEvent({
          type: 'pairing_success',
          timestamp: new Date(),
          sessionId: session.id,
          payload: {
            deviceId: session.deviceId,
            certificateThumbprint: certificate.thumbprint,
            pairedAt: session.pairedAt,
          },
        });

        const result: PairingCompleteResult = {
          deviceId: session.deviceId,
          pairedAt: session.pairedAt,
          certificate,
          status: 'paired',
        };
        this.emitEvent({
          type: 'pairing_success',
          timestamp: new Date(),
          sessionId: session.id,
          payload: result,
        });

        this.currentSession = null;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        session.state = 'error';
        session.error = `Certificate request failed: ${message}`;
        this.emitEvent({
          type: 'pairing_failed',
          timestamp: new Date(),
          sessionId: session.id,
          error: session.error,
        });
        this.currentSession = null;
      }
    }
  }

  async confirmFingerprintManually(): Promise<boolean> {
    if (!this.currentSession) {
      throw new Error('No active pairing session');
    }

    const session = this.currentSession;
    if (
      session.state !== 'awaiting_fingerprint_confirm' &&
      session.state !== 'awaiting_user_input'
    ) {
      return false;
    }

    session.confirmedAt = new Date();
    this.updateState('awaiting_certificate');

    if (!this.controlPlaneClient) {
      this.emitEvent({
        type: 'pairing_success',
        timestamp: new Date(),
        sessionId: session.id,
        payload: {
          note: 'Fingerprint confirmed locally; no Control Plane client configured (offline mode)',
        },
      });
      return true;
    }

    const identity = this.identityManager.getIdentity();
    const request = this.buildControlPlaneRequest(identity);
    try {
      const confirmResponse = await this.controlPlaneClient.confirmFingerprint({
        ...request,
        fingerprintMatches: true,
      });
      if (confirmResponse.success) {
        await this.handlePairingSuccess(confirmResponse);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private buildControlPlaneRequest(identity: DeviceIdentity): ControlPlanePairingRequest {
    const nonce = randomBytes(32).toString('hex');
    const timestamp = new Date();
    const signedHandshake = this.identityManager.createHandshake();
    const signaturePayload = JSON.stringify({
      code: this.currentSession?.code,
      deviceId: identity.deviceId,
      gatewayId: identity.gatewayId,
      fingerprintHex: identity.fingerprint.hex,
      nonce,
      timestamp: timestamp.toISOString(),
    });

    return {
      code: this.currentSession?.code ?? '',
      deviceId: identity.deviceId,
      gatewayId: identity.gatewayId,
      publicKeyJwk: identity.publicKeyJwk,
      publicKeyPem: identity.publicKeyPem,
      fingerprintHex: identity.fingerprint.hex,
      signature: this.identityManager.sign(signaturePayload),
      nonce,
      timestamp,
      signedHandshake,
    };
  }

  private printPairingInstructions(session: PairingSession): void {
    const identity = this.identityManager.getIdentity();
    const expiresIn = Math.max(0, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000));

    console.log('');
    console.log('═══════════════════════════════════════════════════════');
    console.log('  FREEBUFF DEVICE PAIRING');
    console.log('═══════════════════════════════════════════════════════');
    console.log('');
    console.log(`  Pairing Code:    ${session.code.substring(0, 4)}-${session.code.substring(4)}`);
    console.log('');
    console.log(`  Fingerprint:     ${formatFingerprintForDisplay(identity.fingerprint, 'short')}`);
    console.log(`  Words:           ${identity.fingerprint.words.slice(0, 5).join(' ')}`);
    console.log(`                   ${identity.fingerprint.words.slice(5).join(' ')}`);
    console.log('');
    console.log(`  Expires in:      ${Math.floor(expiresIn / 60)}m ${expiresIn % 60}s`);
    console.log(`  Device ID:       ${session.deviceId.substring(0, 12)}...`);
    console.log('');
    console.log('  ⚠️  SECURITY CHECK:');
    console.log('     Verify the fingerprint above matches');
    console.log('     the one shown in the Control Plane UI');
    console.log('     BEFORE clicking "Confirm Pairing".');
    console.log('');
    console.log('  Step 1: Open the Control Plane and log in');
    console.log('  Step 2: Go to Settings → Pair New Device');
    console.log('  Step 3: Enter the Pairing Code or scan QR');
    console.log('  Step 4: Confirm fingerprints MATCH');
    console.log('  Step 5: Click "Approve Pairing"');
    console.log('');
    console.log('  To cancel: Ctrl+C or call cancelPairing()');
    console.log('═══════════════════════════════════════════════════════');
    console.log('');
  }

  private buildConfirmation(session: PairingSession): PairingConfirmation {
    const expiresIn = Math.max(0, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000));
    return {
      code: session.code,
      fingerprintWords: session.fingerprintWords,
      fingerprintShort: session.fingerprintShort,
      qrPayload: session.qrPayload,
      expiresAt: session.expiresAt,
      expiresInSeconds: expiresIn,
    };
  }

  private updateState(newState: PairingState): void {
    if (!this.currentSession) return;
    this.currentSession.state = newState;
  }

  private generateSessionId(): string {
    const bytes = randomBytes(12);
    return `${PAIRING_SESSION_ID_PREFIX}${bytes.toString('hex')}`;
  }

  private emitEvent(event: PairingEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // swallow listener errors
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.stopPolling();
    if (this.currentSession) {
      try {
        await this.cancelPairing('Pairing manager shutdown');
      } catch {
        // ignore
      }
    }
    this.listeners.clear();
    this.rateLimiter.cleanup();
  }
}

export interface ControlPlanePairingClient {
  checkPairingStatus(request: ControlPlanePairingRequest): Promise<ControlPlanePairingResponse>;
  confirmFingerprint(
    request: ControlPlanePairingRequest & { fingerprintMatches: boolean },
  ): Promise<ControlPlanePairingResponse>;
  requestDeviceCertificate(request: ControlPlanePairingRequest): Promise<DeviceCertificate>;
}

export function createPairingManager(
  identityManager: DeviceIdentityManager,
  options?: PairingManagerOptions,
): PairingManager {
  return new PairingManager(identityManager, options);
}
