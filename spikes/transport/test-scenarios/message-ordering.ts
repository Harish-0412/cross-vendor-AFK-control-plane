import { createGatewayClient, createTestServer } from '../src';

async function runMessageOrderingTest() {
  console.log('=== Message Ordering Test ===\n');

  const server = createTestServer(8083);
  await new Promise(resolve => setTimeout(resolve, 500));

  const client = createGatewayClient({
    url: 'ws://localhost:8083',
    deviceId: 'test-device-003',
    authToken: 'Bearer test-token-123',
    reconnect: { maxAttempts: 3, baseDelay: 500, maxDelay: 5000, jitter: 0, backoffMultiplier: 2 },
    onStateChange: (state) => console.log(`[CLIENT] State: ${state}`)
  });

  const sentSequence: number[] = [];
  const receivedSequence: number[] = [];

  const originalSendEvent = client.sendEvent.bind(client);
  client.sendEvent = async (eventType, sessionId, data) => {
    sentSequence.push(data.seq);
    return originalSendEvent(eventType, sessionId, data);
  };

  client.on('message', (msg) => {
    if (msg.type === 'event' && msg.payload.data?.seq) {
      receivedSequence.push(msg.payload.data.seq);
    }
  });

  try {
    console.log('Connecting...');
    await client.connect();
    console.log('Connected!\n');

    await new Promise(resolve => setTimeout(resolve, 500));

    console.log('Sending 100 messages rapidly...');
    const promises = [];
    for (let i = 1; i <= 100; i++) {
      promises.push(client.sendEvent('test.ordering', 'sess_123', { seq: i, timestamp: Date.now() }));
    }
    await Promise.all(promises);
    console.log('100 messages sent\n');

    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log('Verifying order...');
    console.log(`Sent:   [${sentSequence.slice(0, 10).join(', ')}...${sentSequence.slice(-10).join(', ')}]`);
    console.log(`Received: [${receivedSequence.slice(0, 10).join(', ')}...${receivedSequence.slice(-10).join(', ')}]`);

    const ordered = JSON.stringify(sentSequence) === JSON.stringify(receivedSequence);
    console.log(`\nOrder preserved: ${ordered ? 'YES ✓' : 'NO ✗'}`);

    if (!ordered) {
      const mismatches = sentSequence.filter((v, i) => v !== receivedSequence[i]);
      console.log(`Mismatches: ${mismatches.length}`);
      process.exit(1);
    }

    const uniqueReceived = new Set(receivedSequence);
    console.log(`Duplicates: ${receivedSequence.length - uniqueReceived.size === 0 ? 'NO ✓' : 'YES ✗'}`);

    await client.disconnect();

  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  } finally {
    server.close();
  }

  console.log('\n=== Test Passed ===');
}

runMessageOrderingTest();