import { DeviceIdentityManager } from '../gateway/identity/src/device-identity';
import { PairingManager } from '../gateway/pairing/src/pairing-manager';

const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL ?? 'http://localhost:4000';
const POLL_INTERVAL_MS = 2000;

async function main() {
  const identityManager = new DeviceIdentityManager();

  console.log('Initializing gateway identity...');
  await identityManager.initialize();

  const pairingManager = new PairingManager(identityManager);

  console.log('Generating pairing code...\n');
  await pairingManager.startPairing();

  const session = pairingManager.getCurrentSession();
  if (!session) throw new Error('No pairing session created');

  // Register the code with the control plane so the web UI can look it up
  let pairingId: string;
  try {
    const res = await fetch(`${CONTROL_PLANE_URL}/api/v1/internal/pairing/initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: session.code,
        deviceId: session.deviceId,
        gatewayId: session.gatewayId,
        fingerprintHex: session.fingerprintHex,
        fingerprintWords: session.fingerprintWords,
        // Registered here so the Control Plane can verify the tunnel
        // signatures this gateway produces. Without it, the device is
        // created but can never authenticate.
        publicKeyJwk: identityManager.getIdentity().publicKeyJwk,
        publicKeyPem: identityManager.getIdentity().publicKeyPem,
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
    }

    const json = (await res.json()) as { pairingId: string };
    pairingId = json.pairingId;
    console.log(`Pairing registered with control plane (id: ${pairingId})\n`);
  } catch (err) {
    console.error('\nCould not reach control plane at', CONTROL_PLANE_URL);
    console.error('Start it first:  cd odysseus && npx tsx control-plane/src/server.ts');
    console.error('Error:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  console.log(`Open the web UI and enter the code above:`);
  console.log(`  http://localhost:3000/devices/pair\n`);
  console.log('Waiting for confirmation', { expires: session.expiresAt.toISOString() });
  process.stdout.write('\n');

  const deadline = session.expiresAt.getTime();
  let dots = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    try {
      const statusRes = await fetch(
        `${CONTROL_PLANE_URL}/api/v1/internal/pairing/status?code=${session.code}`,
      );

      if (!statusRes.ok) continue;

      const { status } = (await statusRes.json()) as { status: string };

      if (status === 'confirmed') {
        process.stdout.write('\n\n');
        console.log('Pairing confirmed! This machine is now registered.');
        console.log(`  Device ID:  ${session.deviceId}`);
        console.log(`  Gateway ID: ${session.gatewayId}`);
        console.log('');
        await pairingManager.shutdown();
        process.exit(0);
      }

      if (status === 'rejected') {
        process.stdout.write('\n');
        console.error('Pairing was rejected in the web UI.');
        process.exit(1);
      }

      if (status === 'expired') {
        process.stdout.write('\n');
        console.error('Pairing code expired before confirmation.');
        process.exit(1);
      }

      // pending / code_verified — still waiting
      if (++dots % 30 === 0) process.stdout.write('\n');
      process.stdout.write('.');
    } catch {
      // control plane briefly unreachable — keep polling
      process.stdout.write('?');
    }
  }

  process.stdout.write('\n');
  console.error('Pairing timed out (5 minutes elapsed).');
  await pairingManager.shutdown();
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
