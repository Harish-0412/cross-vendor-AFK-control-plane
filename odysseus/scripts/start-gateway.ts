/**
 * Odysseus Gateway entrypoint.
 *
 * This is the process a developer runs on their own workstation, and it is the
 * composition root: it resolves configuration, owns the device identity,
 * decides which agent adapters exist on this machine, and hands all of that to
 * GatewayRuntime — which owns the lifecycle from there.
 *
 * It deliberately does not re-implement transport or lifecycle. Reconnect and
 * backoff live in TunnelClient; state transitions, signals, drain and exit
 * codes live in GatewayRuntime. This file only wires them together and
 * supplies the two things they cannot know on their own: a WebSocket
 * implementation and a signing identity.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

import { createGateway } from '../gateway/core/src/gateway';
import {
  adaptersCheck,
  clockSkewCheck,
  controlPlaneUrlCheck,
  createLogger,
  createGatewayRuntime,
  discoverAdapters,
  ExitCode,
  formatResolvedConfig,
  identityCheck,
  loadAdapter,
  loadGatewayConfig,
  nodeVersionCheck,
  projectRootsCheck,
  type PreflightCheck,
} from '../gateway/core/src/index';
import { DeviceIdentityManager } from '../gateway/identity/src/device-identity';
import {
  HistorySync,
  IntegrationManager,
  defaultPathContext,
} from '../gateway/integrations/src/index';
import { isIntegrationId } from '../packages/protocol/src/index';

import { promptForApproval, renderRequest, signerFor } from './grant-prompt';

const CLI_COMMAND = process.env['ODYSSEUS_CLI_COMMAND']
  ? `${process.env['ODYSSEUS_CLI_COMMAND']} gateway`
  : 'pnpm gateway';

const USAGE = `
Odysseus Gateway

Usage: ${CLI_COMMAND} [options]

Options:
  --control-plane-url <url>   Control Plane tunnel endpoint (ws:// or wss://)
  --config <path>             Config file (default: ~/.odysseus/config.yaml)
  --project-root <path>       Project root to serve; repeatable
  --adapter <id>              Restrict to these adapters; repeatable
  --auth-token-file <path>    Read the auth token from a file
  --log-level <level>         error | warn | info | debug | trace
  --heartbeat-ms <ms>         Heartbeat interval
  --no-tunnel                 Run local-only, without dialling the Control Plane
  --print-config              Print the resolved configuration and exit
  --help                      Show this message

Configuration precedence: flags > environment > config file > defaults.

Signals:
  SIGTERM   finish in-flight sessions, then exit
  SIGQUIT   cancel in-flight sessions and exit
  SIGINT    as SIGTERM; press again within 5s to escalate
`;

async function main(): Promise<void> {
  // ------------------------------------------------------------ configuration
  let resolved;
  try {
    resolved = loadGatewayConfig();
  } catch (err) {
    console.error(`Configuration error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(ExitCode.CONFIG);
    return;
  }

  if (resolved.directives.help) {
    console.log(USAGE.trim());
    process.exit(ExitCode.OK);
    return;
  }

  const log = createLogger({ level: resolved.options.logLevel ?? 'info' });
  for (const warning of resolved.warnings) log.warn('config.warning', { detail: warning });

  if (resolved.directives.printConfig) {
    console.log(formatResolvedConfig(resolved));
    process.exit(ExitCode.OK);
    return;
  }

  const options = resolved.options;
  const controlPlaneUrl =
    options.controlPlane?.autoConnect === false ? undefined : options.controlPlane?.url;

  // ---------------------------------------------------------------- identity
  const identityManager = new DeviceIdentityManager();
  await identityManager.initialize();
  const identity = identityManager.getIdentity();

  const deviceLog = log.child({ deviceId: identity.deviceId });
  deviceLog.info('gateway.identity', {
    gatewayId: identity.gatewayId,
    fingerprint: identity.fingerprint.words.join(' '),
    target: controlPlaneUrl ?? '(local-only)',
    projectRoots: options.projectRoots,
  });

  // ----------------------------------------------------------------- gateway
  const gateway = createGateway({
    ...options,
    deviceId: identity.deviceId,
    gatewayId: identity.gatewayId,
    ...(controlPlaneUrl
      ? {
          controlPlane: {
            ...(options.controlPlane ?? { url: controlPlaneUrl }),
            url: controlPlaneUrl,
          },
        }
      : {}),
  });

  const adapterResult = await registerAvailableAdapters(gateway, deviceLog, {
    allowedAdapters: options.allowedAdapters,
  });
  if (adapterResult.fatal) {
    deviceLog.error('gateway.adapter_fatal', { detail: adapterResult.fatal });
    process.exit(ExitCode.CONFIG);
    return;
  }
  const agents = await gateway.detectAgents();
  for (const agent of agents) {
    deviceLog.info('gateway.agent', {
      adapter: agent.metadata.id,
      installed: agent.installed,
      ...(agent.detectedVersion ? { version: agent.detectedVersion } : {}),
      health: agent.health.status,
    });
  }

  gateway.subscribeToEvents({
    onEvent: (event) => {
      deviceLog.debug('session.event', {
        sessionId: event.sessionId,
        eventType: event.eventType,
        sequence: event.sequence,
      });
    },
  });

  // ------------------------------------------------------------------ runtime
  const { tunnelClient } = gateway.getModules();

  // ------------------------------------------------------------ integrations
  // Consent-gated access to Antigravity / Codex / ChatGPT-export / OpenAI
  // org data. This process holds the device key, so it is the only place a
  // grant can be verified — and the only place one can be approved.
  const pathContext = defaultPathContext();
  // Created before the manager so a newly approved grant can start a sync.
  let history: HistorySync | undefined;
  const integrations = new IntegrationManager({
    signer: signerFor(identityManager),
    ctx: pathContext,
    onUpdate: (update) => {
      tunnelClient.send('integration_update', update);
      if (update.kind === 'grant_changed') {
        if (update.state.status === 'active') {
          // Titles and usage appear in the web app as soon as access is granted.
          void history?.syncAll(update.state.integration).catch(() => undefined);
        } else if (update.state.status === 'revoked' || update.state.status === 'expired') {
          history?.forget(update.state.integration);
        }
      }
      if (update.kind === 'access_refused') {
        deviceLog.warn('integration.access_refused', {
          integration: update.integration,
          scope: update.scope,
          detail: update.reason,
        });
      }
    },
    onLocalWebDisconnect: (request) => {
      tunnelClient.send('client_control', {
        action: 'terminate_all',
        requestId: request.id,
        requestedAt: request.requestedAt,
        reason: 'Disconnected from the workstation',
      });
      history?.setBrowserPresence(false);
      deviceLog.info('web_clients.terminate_requested', { requestId: request.id });
    },
    onLocalIntegrationSync: (integration) => {
      void history?.syncAll(integration).catch((error) => {
        deviceLog.warn('integration.local_sync_failed', { integration, error: error as Error });
      });
    },
  });

  // One prompt at a time: a second request waits for `pnpm grants`.
  let prompting = false;
  gateway.setIntegrationHandler({
    receiveRequest: async (payload) => {
      const received = await integrations.receiveRequest(payload);
      const request = await integrations.store.findRequest(received.requestId);
      if (request) {
        deviceLog.info('integration.request', {
          integration: request.integration,
          requestId: request.requestId,
        });
        if (!prompting) {
          prompting = true;
          // Not awaited: the Control Plane gets its answer ("pending") now,
          // and the owner decides in their own time.
          void (async () => {
            try {
              await renderRequest(request);
              await promptForApproval(integrations, request);
            } catch (error) {
              deviceLog.warn('integration.prompt_failed', { error: error as Error });
            } finally {
              prompting = false;
            }
          })();
        }
      }
      return received;
    },
    revoke: (integration, by) => integrations.revoke(integration, by),
    list: () => integrations.list(),
    sync: async (payload) => {
      const integration = (payload as { integration?: unknown }).integration;
      if (!isIntegrationId(integration)) throw new Error('Unknown integration');
      // Answer now; the scan reports its results as it goes.
      void history?.syncAll(integration).catch(() => undefined);
      return { started: true };
    },
    syncContent: async (payload) => {
      const value = payload as { integration?: unknown; externalId?: unknown };
      if (!isIntegrationId(value.integration)) throw new Error('Unknown integration');
      if (!history) throw new Error('History sync is not running');
      return history.syncContent(value.integration, value.externalId);
    },
    setClientPresence: (active, clients) => {
      history?.setBrowserPresence(active);
      deviceLog.info(active ? 'web_clients.connected' : 'web_clients.disconnected', { clients });
      return { active, clients, localReadsPaused: !active };
    },
    authorizeSession: async (adapterId) => {
      const integration =
        adapterId === 'codex' ? 'codex' : adapterId === 'antigravity' ? 'antigravity' : undefined;
      if (!integration) return;
      const grant = await integrations.store.findActive(integration);
      if (!grant?.scopes.includes('session.run')) {
        throw new Error(
          `${integration === 'codex' ? 'Codex' : 'Antigravity'} session access is not granted on this workstation. Connect ${
            integration === 'codex' ? 'OpenAI Codex' : 'Google Antigravity'
          } with “Run sessions” access first.`,
        );
      }
      if (!history?.isBrowserPresent()) {
        throw new Error(
          `No active Odysseus web client; remote ${
            integration === 'codex' ? 'Codex' : 'Antigravity'
          } session launch is paused`,
        );
      }
    },
  });

  history = new HistorySync({
    manager: integrations,
    ctx: pathContext,
    emit: (update) => tunnelClient.send('integration_update', update),
    requireBrowserPresence: true,
  });
  // Keep granted integrations current. Unchanged files are served from a
  // cache, so a quiet interval costs only a directory listing.
  history.startAuto();
  // Picks up approvals and revokes made with `pnpm grants` in another
  // terminal, and expires requests nobody answered.
  integrations.startWatching();

  const preflightChecks: PreflightCheck[] = [
    nodeVersionCheck(20),
    identityCheck({ deviceId: identity.deviceId, sign: (data) => identityManager.sign(data) }),
    controlPlaneUrlCheck(controlPlaneUrl),
    projectRootsCheck(options.projectRoots ?? []),
    adaptersCheck(agents.length, agents.filter((agent) => agent.installed).length),
    clockSkewCheck(() => fetchControlPlaneTime(controlPlaneUrl)),
  ];

  const runtime = createGatewayRuntime({
    gateway,
    logger: deviceLog,
    preflightChecks,
    ...(controlPlaneUrl
      ? {
          connect: () =>
            gateway.connectToControlPlane({
              webSocketImpl: WebSocket as never,
              authProvider: {
                getPublicKeyJwk: () => identity.publicKeyJwk,
                getCertificateThumbprint: () => null,
                sign: (data: string) => identityManager.sign(data),
                verifySignature: (data: string, signature: string) =>
                  identityManager.verifySignature(data, signature),
              },
            }),
        }
      : {}),
  });

  // Tunnel events drive the runtime's online/degraded state and feed the
  // failure taxonomy, so a revoked device exits 77 instead of retrying.
  tunnelClient.onEvent((event) => {
    switch (event.type) {
      case 'auth_success':
        runtime.notifyTunnelConnected();
        // Bring the web app up to date after a reconnect (e.g. the PC woke up).
        void history?.syncAllActive();
        break;
      case 'state_change':
        if (event.state === 'disconnected' || event.state === 'reconnecting') {
          // Without the authenticated Control Plane link there is no way to
          // prove a website is still present, so fail closed and stop reads.
          history?.setBrowserPresence(false);
          runtime.notifyTunnelLost(event.message);
        }
        break;
      case 'certificate_warning':
        runtime.recordFailure('auth_fatal', new Error(event.message ?? 'credentials rejected'));
        break;
      case 'auth_failure': {
        const failure = tunnelClient.getLastFailure();
        if (failure && !failure.retryable) {
          runtime.recordFailure(
            failure.class === 'protocol' ? 'protocol' : 'auth_fatal',
            new Error(`${failure.code}: ${failure.reason}`),
          );
        }
        break;
      }
      case 'reconnect_attempt':
        deviceLog.info('tunnel.reconnect', { detail: event.message });
        break;
      case 'heartbeat_timeout':
        runtime.recordFailure('transient', new Error('heartbeat timeout'));
        break;
      case 'error':
        deviceLog.warn('tunnel.error', { detail: event.message ?? event.error?.message });
        break;
      default:
        break;
    }
  });

  await runtime.start();
}

/** Best-effort Control Plane clock, over the health endpoint. */
async function fetchControlPlaneTime(wsUrl: string | undefined): Promise<Date | null> {
  if (!wsUrl) return null;
  try {
    const httpUrl = new URL(wsUrl);
    httpUrl.protocol = httpUrl.protocol === 'wss:' ? 'https:' : 'http:';
    httpUrl.pathname = '/health';
    httpUrl.search = '';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(httpUrl.toString(), { signal: controller.signal });
      if (!res.ok) return null;
      const body = (await res.json()) as { timestamp?: string };
      return body.timestamp ? new Date(body.timestamp) : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/**
 * Discover adapters from manifests and register the ones this machine can run.
 *
 * Two-phase, following Packer: explicitly configured adapters are required and
 * a failure to load one is fatal, while discovered adapters are optional and a
 * failure is a named warning. The previous hardcoded try/catch conflated those
 * — a broken adapter was indistinguishable from an absent one.
 *
 * Returns a fatal reason when a required adapter could not be loaded.
 */
async function registerAvailableAdapters(
  gateway: ReturnType<typeof createGateway>,
  log: ReturnType<typeof createLogger>,
  options: { allowedAdapters?: string[] | undefined; explicit?: Array<{ path: string }> },
): Promise<{ fatal?: string }> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  // Source runs from scripts/, while the published package runs from
  // dist-package/. Both roots are harmless to scan when absent and let the
  // same composition code serve local development and the bundled download.
  const adapterRoots = [
    join(moduleDirectory, 'adapters'),
    join(moduleDirectory, '..', 'gateway', 'adapters'),
  ];

  const discovery = await discoverAdapters({
    ...(options.explicit ? { explicit: options.explicit } : {}),
    workspaceRoots: adapterRoots,
    ...(options.allowedAdapters ? { allowedAdapters: options.allowedAdapters } : {}),
    logger: log,
  });

  for (const warning of discovery.warnings)
    log.warn('adapter.discovery_warning', { detail: warning });
  if (discovery.errors.length > 0) {
    for (const error of discovery.errors) log.error('adapter.required_failed', { detail: error });
    return { fatal: discovery.errors[0] };
  }

  for (const discovered of discovery.adapters) {
    try {
      const { adapter, manifest } = await loadAdapter(discovered);
      const registered = gateway.registerAdapter(adapter);
      log.info('adapter.registered', {
        adapter: manifest.id,
        source: discovered.source,
        registered,
      });
    } catch (err) {
      if (discovered.required) {
        log.error('adapter.required_failed', {
          adapter: discovered.manifest.id,
          error: err as Error,
        });
        return { fatal: (err as Error).message };
      }
      log.warn('adapter.unavailable', {
        adapter: discovered.manifest.id,
        error: err as Error,
      });
    }
  }

  return {};
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(ExitCode.SOFTWARE);
});
