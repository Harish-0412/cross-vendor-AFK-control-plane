import { AcpAdapter } from './acp-adapter';
import { ACP_PRESETS } from './presets';

export * from './acp-adapter';
export * from './connection';
export * from './presets';

/** Claude Code over ACP: every tool call it makes can be approved in Odysseus. */
export class ClaudeAcpAdapter extends AcpAdapter {
  constructor() {
    super(ACP_PRESETS.claude);
  }
}

export class CodexAcpAdapter extends AcpAdapter {
  constructor() {
    super(ACP_PRESETS.codex);
  }
}

export class GeminiAcpAdapter extends AcpAdapter {
  constructor() {
    super(ACP_PRESETS.gemini);
  }
}

export class OpenCodeAcpAdapter extends AcpAdapter {
  constructor() {
    super(ACP_PRESETS.opencode);
  }
}
