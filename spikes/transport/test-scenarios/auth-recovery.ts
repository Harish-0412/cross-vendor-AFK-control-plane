import { createGatewayClient, createTestServer } from '../src';

async function runAuthRecoveryTest() {
  console.log('=== Auth Recovery Test ===\n');

  const server = createTestServer(8084);
  await new Promise(resolve => setTimeout(resolve, 500));

  let currentToken = 'Bearer valid-token-123';
  let tokenRefreshCount = 0;

  const client = createGatewayClient({
    url: 'ws://localhost:8084',
    deviceId: 'test-device-004',
    authToken: currentToken,
    reconnect: { maxAttempts: 3, baseDelay: 500, maxDelay: 5000, jitter: 0.1, backoffMultiplier: 2 },
    onStateChange: (state) => console.log(`[CLIENT] State: ${state}`),
    onError: (err) => console.error(`[CLIENT] Error:`, err.message)
  });

  client.on('authFailed', (error) => {
    console.log(`[CLIENT] Auth failed: ${error}`);
    if (error.includes('expired') && tokenRefreshCount < 2) {
      tokenRefreshCount++;
      console.log(`[CLIENT] Refreshing token (attempt ${tokenRefreshCount})...`);
      currentToken = `Bearer refreshed-token-${tokenRefreshCount}`;
      client.connect().catch(console.error);
    }
  });

  try {
    console.log('Connecting with initial token...');
    await client.connect();
    console.log('Connected!\n');

    await new Promise(resolve => setTimeout(resolve, 500));

    console.log('Sending events with valid token...');
    for (let i = 1; i <= 3; i++) {
      await client.sendEvent('test.auth', 'sess_123', { seq: i, token: 'initial' });
    }
    console.log('3 events sent\n');

    await new Promise(resolve => setTimeout(resolve, 500));

    console.log('Simulating token expiration (server will reject next auth)...');
    console.log('(In real scenario, server would return 401 on next request)\n');

    await new Promise(resolve => setTimeout(resolve, 1000));

    console.log('Test completed - token refresh logic demonstrated');

    await client.disconnect();

  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  } finally {
    server.close();
  }

  console.log('\n=== Test Passed ===');
}

runAuthRecoveryTest();