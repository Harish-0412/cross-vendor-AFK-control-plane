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
import WebSocket from 'ws';

import { createGateway } from '../gateway/core/src/gateway';
import {
  adaptersCheck,
  clockSkewCheck,
  controlPlaneUrlCheck,
  createLogger,
  createGatewayRuntime,
  ExitCode,
  formatResolvedConfig,
  identityCheck,
  loadGatewayConfig,
  nodeVersionCheck,
  projectRootsCheck,
  type PreflightCheck,
} from '../gateway/core/src/index';
import { DeviceIdentityManager } from '../gateway/identity/src/device-identity';

const USAGE = `
Odysseus Gateway

Usage: pnpm gateway [options]

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

  await registerAvailableAdapters(gateway, deviceLog);
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
        break;
      case 'state_change':
        if (event.state === 'disconnected' || event.state === 'reconnecting') {
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
 * Probe for optional adapters and register the ones this machine can run.
 * Imports are dynamic so a missing or unbuilt adapter package degrades to a
 * warning instead of taking the whole gateway down at startup.
 */
type AnyAdapter = Parameters<ReturnType<typeof createGateway>['registerAdapter']>[0];

async function registerAvailableAdapters(
  gateway: ReturnType<typeof createGateway>,
  log: ReturnType<typeof createLogger>,
): Promise<void> {
  const candidates: Array<{ name: string; construct: () => Promise<AnyAdapter> }> = [
    {
      name: 'opencode',
      construct: async () => {
        const { OpenCodeAdapter } = await import('../gateway/adapters/opencode/src/index');
        return new OpenCodeAdapter() as AnyAdapter;
      },
    },
    {
      name: 'antigravity',
      construct: async () => {
        const { AntigravityAdapter } = await import('../gateway/adapters/antigravity/src/index');
        return new AntigravityAdapter() as AnyAdapter;
      },
    },
  ];

  for (const candidate of candidates) {
    try {
      const registered = gateway.registerAdapter(await candidate.construct());
      log.info('adapter.registered', { adapter: candidate.name, registered });
    } catch (err) {
      log.warn('adapter.unavailable', { adapter: candidate.name, error: err as Error });
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(ExitCode.SOFTWARE);
});
