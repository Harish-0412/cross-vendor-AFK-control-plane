import { createGatewayClient, createTestServer, GatewayClient } from '../src';

async function runNetworkDropTest() {
  console.log('=== Network Drop & Reconnect Test ===\n');

  const server = createTestServer(8082);
  await new Promise(resolve => setTimeout(resolve, 500));

  const client = createGatewayClient({
    url: 'ws://localhost:8082',
    deviceId: 'test-device-002',
    authToken: 'Bearer test-token-123',
    reconnect: { maxAttempts: 5, baseDelay: 500, maxDelay: 10000, jitter: 0.1, backoffMultiplier: 2 },
    onStateChange: (state) => console.log(`[CLIENT] State: ${state}`),
    onError: (err) => console.error(`[CLIENT] Error:`, err.message)
  });

  const receivedEvents: any[] = [];
  client.on('message', (msg) => {
    if (msg.type === 'event') {
      receivedEvents.push(msg);
      console.log(`[CLIENT] Received event: ${msg.payload.eventType}`);
    }
  });

  try {
    console.log('Connecting...');
    await client.connect();
    console.log('Connected!\n');

    await new Promise(resolve => setTimeout(resolve, 500));

    console.log('Sending initial events...');
    for (let i = 1; i <= 5; i++) {
      await client.sendEvent('test.sequence', 'sess_123', { seq: i, data: `message-${i}` });
    }
    console.log('5 events sent\n');

    await new Promise(resolve => setTimeout(resolve, 500));

    console.log('Simulating network drop (terminating connection)...');
    const clients = server.getClientInfo();
    if (clients.length > 0) {
      server.simulateNetworkDrop(clients[0].id);
    }

    console.log('Waiting for reconnect...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log('Sending events after reconnect...');
    for (let i = 6; i <= 10; i++) {
      await client.sendEvent('test.sequence', 'sess_123', { seq: i, data: `message-${i}` });
    }
    console.log('5 more events sent\n');

    await new Promise(resolve => setTimeout(resolve, 1000));

    console.log('\nDisconnecting...');
    await client.disconnect();

    console.log(`\nTotal events received: ${receivedEvents.length}`);
    console.log('Events:', receivedEvents.map(e => e.payload?.data).join(', '));

  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  } finally {
    server.close();
  }

  console.log('\n=== Test Passed ===');
}

runNetworkDropTest();