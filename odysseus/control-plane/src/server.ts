import { ControlPlane } from './control-plane';
import { assertProductionConfig, isProduction } from './production-guard';

// `PORT` is what every hosted platform injects; the explicit name wins when set.
const port = parseInt(process.env.CONTROL_PLANE_PORT || process.env.PORT || '4000', 10);
const host = process.env.CONTROL_PLANE_HOST || process.env.HOST || '0.0.0.0';

const cp = new ControlPlane({ port, host });

void (async () => {
  try {
    // Checked before listening, so an insecure deployment never accepts a
    // single request. See production-guard.ts for why this fails rather than
    // warns.
    if (isProduction()) {
      assertProductionConfig({
        config: cp.config,
        env: process.env,
        usingMemoryDatabase: cp.usingMemoryDatabase,
      });
    }

    const info = await cp.start();
    // eslint-disable-next-line no-console
    console.info(`[Odysseus Control Plane] Server listening on ${info.url}`);
    // eslint-disable-next-line no-console
    console.info(`[Odysseus Control Plane] Gateway Tunnel Endpoint: ${cp.getWsTunnelUrl()}`);
    // eslint-disable-next-line no-console
    console.info(`[Odysseus Control Plane] Web Client Endpoint: ${cp.getWsClientUrl()}`);

    let shuttingDown = false;
    const handleShutdown = async (signal: string) => {
      // A platform that sends SIGTERM and then SIGKILL on a timer can deliver
      // the first signal twice; draining twice would race the close.
      if (shuttingDown) return;
      shuttingDown = true;
      // eslint-disable-next-line no-console
      console.info(`[Odysseus Control Plane] Received ${signal}, shutting down gracefully...`);
      await cp.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => void handleShutdown('SIGINT'));
    process.on('SIGTERM', () => void handleShutdown('SIGTERM'));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[Odysseus Control Plane] Failed to start server:', err);
    // 78 is sysexits' EX_CONFIG, matching the gateway's own exit-code
    // convention, so an orchestrator can tell "misconfigured" from "crashed"
    // and stop restarting a deployment that will never come up.
    process.exit(err instanceof Error && /Refusing to start/.test(err.message) ? 78 : 1);
  }
})();
