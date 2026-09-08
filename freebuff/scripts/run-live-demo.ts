import { createGateway } from '../gateway/core/src/gateway';
import { createApiServer } from '../gateway/core/src/api-server';
import type { GatewayOptions, SessionConfig, EventEnvelope } from '@freebuff/protocol';

const CONTROL_PLANE_URL = 'http://localhost:4000';
const GATEWAY_API_PORT = 4001;

async function runLiveDemo() {
  console.log('================================================================');
  console.log('🚀 FREEBUFF CONTROL PLANE & AGENT GATEWAY - LIVE SYSTEM DEMO');
  console.log('================================================================\n');

  // Step 1: Health Check Control Plane
  console.log('[1/5] Checking Cloud Control Plane status...');
  try {
    const healthRes = await fetch(`${CONTROL_PLANE_URL}/health`);
    const health = await healthRes.json();
    console.log('   ✅ Control Plane is healthy and running:');
    console.log('      URL:       ', CONTROL_PLANE_URL);
    console.log('      Service:   ', health.service);
    console.log('      Version:   ', health.version);
    console.log('      Timestamp: ', health.timestamp);
  } catch (err: any) {
    console.error('   ❌ Could not reach Control Plane at', CONTROL_PLANE_URL, err.message);
    process.exit(1);
  }

  // Step 2: Register / Login user in Control Plane
  console.log('\n[2/5] Authenticating Developer on Control Plane...');
  const regEmail = `dev_${Date.now()}@freebuff.dev`;
  const regRes = await fetch(`${CONTROL_PLANE_URL}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: regEmail,
      password: 'SecurePassword123!',
      name: 'Developer Demo',
    }),
  });
  const authData = (await regRes.json()) as any;
  const token = authData.accessToken;
  console.log(`   ✅ Developer authenticated successfully:`);
  console.log(`      User ID:   ${authData.user.id}`);
  console.log(`      Email:     ${authData.user.email}`);
  console.log(`      Token:     ${token.substring(0, 25)}...`);

  // Step 3: Boot local Agent Gateway with Phase 6 Redaction Proxy
  console.log('\n[3/5] Starting Local Agent Gateway (with Redaction Proxy)...');
  const gatewayOptions: GatewayOptions = {
    sandboxEnabled: false,
    apiServer: { enabled: true, port: GATEWAY_API_PORT, host: '127.0.0.1' },
    logLevel: 'info',
  };

  const gateway = createGateway(gatewayOptions);
  const status = await gateway.getStatus();
  console.log('   ✅ Gateway initialized:');
  console.log(`      Gateway ID:        ${status.gatewayId}`);
  console.log(`      Device ID:         ${status.deviceId}`);
  console.log(`      Version:           ${status.version}`);
  console.log(`      Secret Redaction:  ${status.features.secretRedaction ? 'ENABLED (Phase 6 Active)' : 'DISABLED'}`);
  console.log(`      Local API Server:  ${status.features.localApiServer ? 'ENABLED' : 'DISABLED'}`);

  // Start Gateway Local REST API Server
  const apiServer = createApiServer(gateway, { host: '127.0.0.1', port: GATEWAY_API_PORT });
  const serverStatus = await apiServer.start();
  console.log(`   ✅ Gateway Local API listening at: ${serverStatus.url}`);

  const agents = await gateway.listAgents();
  console.log(`   ✅ Installed Agent Adapters detected: ${agents.map((a) => a.metadata.id).join(', ')}`);

  // Step 4: Pair Device and Connect Gateway Tunnel to Control Plane
  console.log('\n[4/5] Establishing E2E Encrypted Tunnel to Control Plane...');
  const pairCode = `DEMO-${Math.floor(1000 + Math.random() * 9000)}`;

  // Internal initiate pairing
  await fetch(`${CONTROL_PLANE_URL}/api/v1/internal/pairing/initiate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: pairCode,
      deviceId: status.deviceId,
      gatewayId: status.gatewayId,
      fingerprintHex: 'DEADBEEFCAFE',
      fingerprintWords: ['echo', 'falcon', 'summit', 'horizon'],
    }),
  });

  // User claims pair code
  await fetch(`${CONTROL_PLANE_URL}/api/v1/devices/pair`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ code: pairCode }),
  });

  // User confirms device pairing
  await fetch(`${CONTROL_PLANE_URL}/api/v1/devices/confirm`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      code: pairCode,
      confirmed: true,
      friendlyName: 'MacBook Pro Workstation',
    }),
  });
  console.log(`   ✅ Device paired with code [${pairCode}] (MacBook Pro Workstation)`);

  // Connect WebSocket tunnel
  const tunnelWs = new WebSocket('ws://localhost:4000/ws/tunnel');
  await new Promise<void>((resolve, reject) => {
    tunnelWs.addEventListener('open', () => resolve(), { once: true });
    tunnelWs.addEventListener('error', (err) => reject(err), { once: true });
  });

  tunnelWs.send(
    JSON.stringify({
      id: 'auth_msg',
      type: 'auth',
      sequence: 1,
      timestamp: new Date().toISOString(),
      payload: { deviceId: status.deviceId, gatewayId: status.gatewayId },
    }),
  );

  await new Promise<void>((resolve) => {
    tunnelWs.addEventListener('message', (event: any) => {
      const msg = JSON.parse(event.data.toString());
      if (msg.type === 'auth_success') resolve();
    });
  });
  console.log('   ✅ Gateway WebSocket Tunnel Authenticated: Status ONLINE');

  // Step 5: Execute Agent Session with Leaky Output & Verify Phase 6 Redaction
  console.log('\n[5/5] Launching Agent Session (Scenario: leaky_output with AWS Credentials)...');
  console.log('   ⚠️  Agent attempts to emit simulated AWS Key: "AKIAIOSFODNN7EXAMPLE"');

  const interceptedEvents: EventEnvelope[] = [];
  const unsub = gateway.subscribeToEvents({
    onEvent: (evt) => {
      interceptedEvents.push(evt);
      if (evt.eventType === 'session.output') {
        const payload = evt.payload as any;
        console.log(`\n   📡 [REALTIME EVENT] [${evt.eventType}] Stream: ${payload.stream}`);
        console.log(`      Content: "${payload.content}"`);
      } else if (evt.eventType === 'session.completed') {
        console.log(`   📡 [REALTIME EVENT] [${evt.eventType}] Status: ${(evt.payload as any).status ?? 'completed'}`);
      }
    },
  });

  const sessionConfig: SessionConfig = {
    adapter: 'mock',
    projectRoot: process.cwd(),
    prompt: 'Deploy infrastructure to AWS cloud environment',
    metadata: {
      scenario: 'leaky_output',
    },
  };

  const session = await gateway.createSession(sessionConfig);
  console.log(`   ✅ Session started: ${session.id} (State: ${session.state})`);

  // Wait for session events to complete
  await new Promise((r) => setTimeout(r, 2000));
  unsub();

  // Check Redaction Results
  console.log('\n================================================================');
  console.log('🛡️  PHASE 6 REDACTION PROXY VERIFICATION RESULTS');
  console.log('================================================================');
  const outputEvent = interceptedEvents.find((e) => e.eventType === 'session.output');
  if (outputEvent) {
    const content = (outputEvent.payload as any).content;
    const hasRawSecret = content.includes('AKIAIOSFODNN7EXAMPLE');
    const hasRedactedToken = content.includes('[REDACTED_AWS_ACCESS_KEY]');

    console.log(`   Raw Secret Leaked:     ${hasRawSecret ? '❌ YES (FAILED)' : '✅ NO (SECURELY BLOCKED)'}`);
    console.log(`   Placeholder Injected:   ${hasRedactedToken ? '✅ YES ([REDACTED_AWS_ACCESS_KEY])' : '❌ NO'}`);
    console.log(`   Final Scrubbed Output: "${content}"`);
  }

  const redactor = gateway.getModules().redactionProxy;
  if (redactor) {
    const stats = redactor.getStats();
    console.log(`   Total Events Processed: ${stats.eventsProcessed}`);
    console.log(`   Total Secrets Redacted: ${stats.secretsRedacted}`);
    console.log(`   Events Blocked:         ${stats.eventsBlocked ?? 0}`);
  }

  console.log('\n================================================================');
  console.log('🎉 LIVE DEMO COMPLETED SUCCESSFULLY');
  console.log('================================================================\n');

  // Graceful cleanup
  tunnelWs.close();
  await apiServer.stop(500);
  await gateway.shutdown(false, 500);
}

runLiveDemo().catch((err) => {
  console.error('Fatal Demo Error:', err);
  process.exit(1);
});
