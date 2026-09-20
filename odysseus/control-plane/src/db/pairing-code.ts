/**
 * Canonical form for pairing codes.
 *
 * A pairing code is displayed as `T55Q-Y3D2` but typed by a human who may or
 * may not include the dash, may use lower case, and may paste trailing
 * whitespace. Every layer that has normalised this has historically done it
 * slightly differently — the HTTP route stripped dashes while the store did
 * not — which meant a stored `T55Q-Y3D2` never matched a looked-up
 * `T55QY3D2`, and pairing failed with "Invalid or expired pairing code".
 *
 * There is exactly one normaliser, and both writes and lookups use it.
 */
export function normalizePairingCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

/** Display form: `XXXX-XXXX`. Codes of other lengths are returned as-is. */
export function formatPairingCode(code: string): string {
  const normalized = normalizePairingCode(code);
  if (normalized.length !== 8) return normalized;
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}
