import { createGatewayClient, createTestServer, GatewayClient } from '../src';

async function runBasicConnectionTest() {
  console.log('=== Basic Connection Test ===\n');

  const server = createTestServer(8081);
  await new Promise(resolve => setTimeout(resolve, 500));

  const client = createGatewayClient({
    url: 'ws://localhost:8081',
    deviceId: 'test-device-001',
    authToken: 'Bearer test-token-123',
    reconnect: { maxAttempts: 3, baseDelay: 500, maxDelay: 5000, jitter: 0.1, backoffMultiplier: 2 },
    onStateChange: (state) => console.log(`[CLIENT] State: ${state}`),
    onError: (err) => console.error(`[CLIENT] Error:`, err.message)
  });

  try {
    console.log('Connecting...');
    await client.connect();
    console.log('Connected!\n');

    await new Promise(resolve => setTimeout(resolve, 500));

    console.log('Sending test event...');
    await client.sendEvent('test.event', 'sess_123', { message: 'Hello World' });
    console.log('Event sent\n');

    await new Promise(resolve => setTimeout(resolve, 500));

    console.log('Sending command...');
    const response = await client.sendCommand('session.status', { sessionId: 'sess_123' });
    console.log('Command response:', response);

    await new Promise(resolve => setTimeout(resolve, 500));

    console.log('\nDisconnecting...');
    await client.disconnect();
    console.log('Disconnected cleanly');

  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  } finally {
    server.close();
  }

  console.log('\n=== Test Passed ===');
}

runBasicConnectionTest();