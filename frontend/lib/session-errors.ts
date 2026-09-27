/** A full path on the workstation: C:\… , \\server\… or /… */
export function isFullPath(value: string): boolean {
  const root = value.trim();
  return /^[A-Za-z]:[\\/]/.test(root) || root.startsWith("/") || root.startsWith("\\\\");
}

/**
 * Why a session did not start, in words the person can act on. The raw
 * reason comes from the gateway or the Control Plane and is kept at the end
 * for anything not recognised.
 */
export function explainStartFailure(raw: string | null | undefined): string {
  const error = (raw ?? "").trim();
  const missing = /Project root does not exist:\s*(.+)$/i.exec(error);
  if (missing) {
    return `That folder does not exist on your computer (${missing[1]}). Choose one of the folders your gateway allows, or create it first.`;
  }
  if (/Invalid project root|not a directory|outside/i.test(error)) {
    return "Your computer refused that folder. Choose one of the folders your gateway allows.";
  }
  if (/is currently offline|offline/i.test(error)) {
    return "Your computer is offline. Run `odysseus gateway` on it, then try again.";
  }
  if (/session access is not granted/i.test(error)) {
    return "This agent has not been given “Run sessions” access. Connect it on the Integrations page first.";
  }
  if (/No active Odysseus web client/i.test(error)) {
    return "Your computer could not see this dashboard as connected. Reload the page and try again.";
  }
  if (/Unknown adapter/i.test(error)) {
    return "That agent is not installed on this computer.";
  }
  if (/not accepting new sessions|shutting down/i.test(error)) {
    return "The gateway on your computer is shutting down. Start it again and retry.";
  }
  if (/did not acknowledge|did not start|timed out/i.test(error)) {
    return "Your computer did not respond in time. Check that the gateway window is still open, then try again.";
  }
  if (/api key|authenticat|log ?in|unauthori[sz]ed|401/i.test(error)) {
    return "The agent could not sign in on your computer. Open a terminal there and sign in to it once (for example run `claude` or `codex login`), then try again.";
  }
  if (/capabilit/i.test(error)) {
    return "This agent cannot run with the chosen approval settings. Try a different agent.";
  }
  return error ? `The session could not start: ${error}` : "The session could not start.";
}
