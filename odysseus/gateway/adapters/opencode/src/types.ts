/** OpenCode's vendor wire format is intentionally contained in this package. */
export interface OpenCodeNativeEvent {
  type: string;
  properties?: Record<string, unknown>;
  sessionID?: string;
  sessionId?: string;
  part?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface OpenCodeProcessOptions {
  binaryPath?: string;
  minimumVersion?: string;
}
