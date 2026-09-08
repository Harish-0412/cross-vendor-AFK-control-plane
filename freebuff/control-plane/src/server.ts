import { ControlPlane } from './control-plane';

const port = parseInt(process.env.CONTROL_PLANE_PORT || process.env.PORT || '4000', 10);
const host = process.env.CONTROL_PLANE_HOST || process.env.HOST || '0.0.0.0';

const cp = new ControlPlane({ port, host });

void (async () => {
  try {
    const info = await cp.start();
    // eslint-disable-next-line no-console
    console.info(`[Freebuff Control Plane] Server listening on ${info.url}`);
    // eslint-disable-next-line no-console
    console.info(`[Freebuff Control Plane] Gateway Tunnel Endpoint: ${cp.getWsTunnelUrl()}`);
    // eslint-disable-next-line no-console
    console.info(`[Freebuff Control Plane] Web Client Endpoint: ${cp.getWsClientUrl()}`);

    const handleShutdown = async (signal: string) => {
      // eslint-disable-next-line no-console
      console.info(`[Freebuff Control Plane] Received ${signal}, shutting down gracefully...`);
      await cp.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => void handleShutdown('SIGINT'));
    process.on('SIGTERM', () => void handleShutdown('SIGTERM'));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[Freebuff Control Plane] Failed to start server:', err);
    process.exit(1);
  }
})();
