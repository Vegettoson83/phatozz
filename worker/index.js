// worker/index.js
import { connect } from 'cloudflare:sockets';

export default {
  async fetch(request, env, ctx) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader === 'websocket') {
      return this.handleWebSocket(request, env);
    }

    // Endpoint de salud
    if (new URL(request.url).pathname === '/health') {
      return new Response('🔥 PHANTOM GATEWAY OPERATIONAL 🔥');
    }

    return new Response('Invalid request', { status: 400 });
  },

  async handleWebSocket(request, env) {
    const authHeader = request.headers.get('X-Phantom-Auth');
    if (!this.verifyAuth(authHeader, env.AUTH_SECRET)) {
      return new Response('Unauthorized', { status: 401 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    server.addEventListener('message', async ({ data }) => {
      const message = JSON.parse(data);

      if (message.type === 'init') {
        try {
          const tunnelSocket = connect({
            hostname: env.TUNNEL_HOST,
            port: env.TUNNEL_PORT
          });

          const writer = tunnelSocket.writable.getWriter();
          await writer.write(new TextEncoder().encode(`${message.host}:${message.port}\n`));
          writer.releaseLock();

          this.setupBidirectionalForwarding(server, tunnelSocket, message.sessionId);
        } catch (err) {
          server.send(JSON.stringify({
            type: 'error',
            message: 'Tunnel connection failed'
          }));
          server.close(1008);
        }
      }
    });

    return new Response(null, { status: 101, webSocket: client });
  },

  setupBidirectionalForwarding(websocket, tunnelSocket, sessionId) {
    // WebSocket → Tunnel
    websocket.addEventListener('message', async ({ data }) => {
      try {
        const message = JSON.parse(data);
        if (message.type === 'data') {
          const writer = tunnelSocket.writable.getWriter();
          await writer.write(Buffer.from(message.data, 'base64'));
          writer.releaseLock();
        }
      } catch (err) {
        console.error('Error forwarding data:', err);
      }
    });

    // Tunnel → WebSocket
    const reader = tunnelSocket.readable.getReader();
    const readChunk = async () => {
      try {
        const { value, done } = await reader.read();
        if (done) {
          websocket.send(JSON.stringify({ type: 'close', sessionId }));
          return;
        }

        websocket.send(JSON.stringify({
          type: 'data',
          sessionId,
          data: value.toString('base64')
        }));

        readChunk();
      } catch (err) {
        websocket.close(1011, 'Tunnel error');
      }
    };

    readChunk();
  },

  verifyAuth(clientToken, serverSecret) {
    const [timestamp, signature] = clientToken.split('.');
    const expected = crypto.createHmac('sha256', serverSecret)
      .update(timestamp)
      .digest('hex');

    return signature === expected && Date.now() - parseInt(timestamp) < 5000;
  }
};
