const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:4000/ws/tunnel');

ws.on('open', () => {
  console.log('Connected to tunnel endpoint');
  ws.send(JSON.stringify({
    id: 'auth1',
    type: 'auth',
    sequence: 1,
    payload: { deviceId: 'dev_test_workstation_1', gatewayId: 'gw_my_github_desktop' }
  }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('Received:', msg.type);

  if (msg.type === 'auth_success') {
    console.log('Gateway authenticated! Device is now online.');
    ws.send(JSON.stringify({
      id: 'hb1', type: 'heartbeat', sequence: 2,
      payload: { cpu: 15, memoryMb: 8120 }
    }));
  }

  if (msg.type === 'heartbeat') {
    console.log('Heartbeat acknowledged');
    fetch('http://localhost:4000/api/v1/devices', {
      headers: { 'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c3JfNzRkMWU5OTljY2IyNDI2YWJmZjY1MjJmZWVlMTEwYTQiLCJlbWFpbCI6ImhhcmlzaDAwN2lzb250aGV3YXlAZ21haWwuY29tIiwicm9sZSI6InVzZXIiLCJ0eXBlIjoiYWNjZXNzIiwiaWF0IjoxNzg4Njg3NDI2LCJleHAiOjE3ODg3NzM4MjZ9.AayyyN9qNRSwDXHesey6irXnFNdHY344GIlxpyj5YW4' }
    }).then(function(res) { return res.json(); }).then(function(devices) {
      console.log('');
      console.log('Device list:');
      console.log(JSON.stringify(devices, null, 2));
      console.log('online should be: true');
      setTimeout(function() { ws.close(); }, 2000);
    });
  }
});

ws.on('error', (err) => console.error('Error:', err.message));
ws.on('close', (code, reason) => console.log('Connection closed:', code, reason.toString()));
