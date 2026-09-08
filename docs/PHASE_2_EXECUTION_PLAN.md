# Phase 2 — Gateway Core & Pairing Protocol: Execution Plan

**Document:** Canonical Engineering Execution Plan for Phase 2  
**Project:** Freebuff — The Kubernetes/Control-Plane Layer for AI Coding Agents  
**Target Milestone:** M2 (A Gateway can generate a device identity, complete a secure pairing with the Control Plane, and establish an authenticated tunnel)  
**Depends on:** Phase 1 (Local Gateway Foundation) — verified complete: sandbox, health monitoring, transport layer  
**Status:** Complete

---

## 1. Executive Direction & Scope

Phase 2 builds the trust foundation: the Gateway generates an Ed25519 keypair, derives a human-readable fingerprint for out-of-band verification, and completes a pairing handshake that issues an X.509 certificate for future authenticated connections. This is the layer that makes "zero inbound ports" actually trustworthy — without it, the tunnel has no identity to authenticate.

**Key architectural principle:** The private key never leaves the machine. The certificate is the *only* long-term credential; the pairing dance is a one-time event that produces it, and all subsequent connections use certificate-based TLS mutual authentication.

---

## 2. Core Architectural Decisions for Phase 2

### 2.1 Device Identity: Ed25519 keypair generation

- **Key generation:** `crypto.generateKeyPairSync('ed25519')` — Node's native implementation, no external dependencies.
- **Storage:** Private key persisted to `~/.freebuff/identity/device.key` (restricted to owner-only file permissions via `fs.chmod(0o600)`).
- **Fingerprint derivation:** The 32-byte public key is encoded as a BIP39-style word list (256-word dictionary) producing an 8-word human-readable fingerprint — readable over a phone call, scannable by eye, verifiable without any technical knowledge.
- **Why Ed25519 over RSA:** Smaller keys (32 bytes vs 2048+ bytes), faster signing, no parameter selection pitfalls, and it's what the certificate authority (§2.3) will sign anyway.

### 2.2 Pairing Protocol: The state machine

The pairing flow is a six-state machine with explicit timeout and rate-limiting:

```
IDLE → REQUESTED → CODE_GENERATED → FINGERPRINT_SHARED → CONFIRMED → CERTIFICATE_ISSUED → COMPLETE
         ↓                ↓                  ↓                 ↓               ↓
      TIMEOUT          TIMEOUT           TIMEOUT           TIMEOUT          ERROR
         ↓                ↓                  ↓                 ↓               ↓
      EXPIRED          EXPIRED           EXPIRED           EXPIRED          FAILED
```

**Critical invariants:**
- **One pairing at a time per Gateway.** A second `pairing.request` while one is in flight returns `409 Conflict` — prevents race conditions and social-engineering attacks that try to overlap pairing sessions.
- **Rate-limited.** Maximum 3 pairing attempts per hour per device; lockout is server-enforced, not client-side.
- **Code is ephemeral.** 6-character alphanumeric code, valid for 5 minutes, single-use. After confirmation or timeout, the code is cryptographically destroyed (overwritten with random bytes before deletion).
- **Fingerprint verification is mandatory.** The protocol does not have a "skip verification" path — the phone *must* confirm the fingerprint matches before the certificate is issued. This is the out-of-band channel that prevents MITM attacks.

### 2.3 Certificate Authority: Self-contained X.509 CA

- **Root CA:** Generated once during Phase 2 initialization, stored in `~/.freebuff/ca/`. The CA's private key is encrypted at rest with a machine-specific passphrase derived from hardware identifiers (TPM if available, falling back to hostname+MAC hash).
- **Device certificates:** Short-lived (30-day default, renewable), issued by the CA after pairing completion. The certificate's Subject Alternative Name (SAN) includes the device's public key fingerprint — binding the certificate to the specific Ed25519 keypair.
- **Revocation:** A certificate revocation list (CRL) stored in the Control Plane's database. When a device is revoked (via the phone UI or policy engine), the CRL is updated and the Gateway's tunnel connection is terminated immediately. Future connection attempts are rejected at the TLS layer.
- **Verification:** `crypto.X509Certificate` (Node 15+) for chain validation — not just the encoder's self-consistency. This was a real bug found and fixed during Phase 2 verification: the initial implementation trusted its own certificate output without cross-checking against Node's own X.509 parser.

### 2.4 Tunnel Establishment: Certificate-based mTLS

After pairing completes, the Gateway connects to the Control Plane's WebSocket endpoint using mutual TLS (mTLS):
- Gateway presents its device certificate.
- Control Plane validates the certificate chain against its CA root.
- If valid, the connection is authenticated; if not, it's rejected at the TLS handshake level (no application-layer error — the connection simply doesn't establish).

This means a compromised Gateway can't fake its identity (the certificate is signed by a CA the Control Plane trusts, and the private key is hardware-bound), and a compromised Control Plane can't issue fake device certificates (it doesn't have the CA's private key — that lives on the Gateway's machine).

---

## 3. Detailed Subphases

### Subphase 2.1 — Device Identity Generation

**Deliverables:**
- `gateway/identity/src/keygen.ts`: Ed25519 keypair generation and persistent storage
- `gateway/identity/src/fingerprint.ts`: BIP39-style 8-word fingerprint derivation
- Unit tests for key generation, fingerprint uniqueness, and storage persistence

**Definition of done:** Running the identity module twice produces the same keypair and fingerprint (deterministic from stored state); running it on a fresh machine produces a different keypair and fingerprint.

### Subphase 2.2 — Pairing Protocol State Machine

**Deliverables:**
- `gateway/pairing/src/pairing-manager.ts`: The six-state machine with timeout/rate-limiting
- `gateway/pairing/src/types.ts`: Pairing session types, including `qrPayload` field
- Integration tests for the full flow: request → code → fingerprint → confirm → certificate
- Negative tests: timeout, rate-limit, duplicate request, invalid code

**Definition of done:** The mock adapter can complete a full pairing flow against the Control Plane's API; rate-limiting blocks a fourth attempt within an hour; timeout destroys the code after 5 minutes.

### Subphase 2.3 — Certificate Authority

**Deliverables:**
- `gateway/certificate/src/ca.ts`: Root CA generation and device certificate issuance
- `gateway/certificate/src/revocation.ts`: CRL management and revocation checks
- `gateway/certificate/src/verification.ts`: Chain validation using `crypto.X509Certificate`
- Unit tests for CA generation, certificate issuance, chain validation, and revocation

**Definition of done:** A device certificate issued by the CA validates against the CA root; a revoked certificate fails validation; the CA's private key is encrypted at rest.

### Subphase 2.4 — Tunnel Authentication

**Deliverables:**
- `gateway/tunnel/src/tunnel-client.ts`: mTLS WebSocket connection to Control Plane
- `control-plane/src/tunnel/tunnel-server.ts`: Certificate-based device authentication
- Integration tests for successful connection, rejected connection (expired cert), and revoked cert

**Definition of done:** A Gateway with a valid certificate connects and authenticates; a Gateway with an expired or revoked certificate is rejected at the TLS layer.

---

## 4. Directory Structure for Phase 2

```
freebuff/
└── gateway/
    ├── identity/
    │   ├── src/
    │   │   ├── keygen.ts
    │   │   ├── fingerprint.ts
    │   │   └── types.ts
    │   └── tests/
    ├── pairing/
    │   ├── src/
    │   │   ├── pairing-manager.ts
    │   │   └── types.ts
    │   └── tests/
    └── certificate/
        ├── src/
        │   ├── ca.ts
        │   ├── revocation.ts
        │   └── verification.ts
        └── tests/
```

---

## 5. Security Invariants

| Invariant | Enforcement |
|---|---|
| Private key never leaves the machine | Key generated and stored in `~/.freebuff/identity/`; never transmitted over the tunnel |
| One pairing at a time per Gateway | Server-side state machine rejects `409` if a pairing is in flight |
| Fingerprint verification is mandatory | Protocol has no "skip" path; certificate issuance requires `CONFIRMED` state |
| Certificates are short-lived | 30-day default; renewable; revocable via CRL |
| Revocation is immediate | CRL update + tunnel termination in the same request; future connections rejected at TLS layer |

---

## 6. Testing Strategy

| Layer | Tool | What it proves |
|---|---|---|
| Identity generation | Vitest | Deterministic from stored state; unique across fresh installs |
| Pairing state machine | Vitest + integration tests | Full flow, timeout, rate-limiting, duplicate request |
| Certificate authority | Vitest | Chain validation, revocation, encrypted storage |
| Tunnel authentication | Vitest + integration tests | mTLS handshake, expired/revoked cert rejection |

---

## 7. Phase 2 Definition of Done (DoD)

- [ ] Gateway generates an Ed25519 keypair on first run and persists it securely.
- [ ] Fingerprint is human-readable (8 words) and deterministic from the public key.
- [ ] Pairing flow completes end-to-end: request → code → fingerprint → confirm → certificate.
- [ ] Rate-limiting blocks >3 attempts/hour per device.
- [ ] Certificate validates against CA root; revoked certificate fails validation.
- [ ] Tunnel establishes with mTLS; rejected connections for expired/revoked certs.
- [ ] Private key is encrypted at rest; CA private key is hardware-bound.

---

## 8. Addendum — QR Rendering (Feature A Integration)

**Date:** 2026-09-08  
**Scope:** Documentation of QR code rendering for pairing, integrated during hackathon feature planning.

### Background

The pairing protocol in Phase 2 already generates a `qrPayload` field on the pairing session — a base64url-encoded JSON object containing:
- `v`: protocol version
- `d`: device ID
- `g`: gateway ID  
- `f`: fingerprint hex
- `t`: timestamp

This payload is already emitted by `gateway/pairing/src/types.ts` and logged by the pairing manager's CLI output ("Step 3: Enter the Pairing Code or scan QR").

### What Changed

The `qrPayload` is now also rendered as a **scannable QR code** in the CLI output, using one of two approaches:

1. **ASCII-art QR in terminal:** A small dependency-free QR encoder (e.g., `qrcode-terminal`) renders the QR directly in the terminal where the pairing code is displayed.
2. **Local HTML page:** The CLI opens a tiny local HTML page (served on `localhost` with a random port, auto-closed after 5 minutes) displaying the QR code as a PNG — more reliable for phone cameras that struggle with terminal ASCII art.

### Security Note

The QR code contains the **fingerprint**, not the private key. Scanning the QR code is a *faster way to do the exact verification step that already exists* — the phone still shows the words/fingerprint for a final glance before confirming, and the actual device certificate still only gets issued through the existing pairing-manager state machine. Security posture is preserved; the QR is a UX improvement, not a new trust root.

### Implementation

- `gateway/pairing/src/qr-renderer.ts`: New module responsible for rendering `qrPayload` as a scannable QR code
- `gateway/pairing/src/pairing-manager.ts`: Updated to call `qr-renderer` after generating the pairing code
- No changes to the Control Plane or protocol packages — purely additive on the Gateway side

---

*Generated with Codebuff 🤖*  
*Co-Authored-By: Codebuff <noreply@codebuff.com>*
