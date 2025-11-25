// orchestrator/cloudflare/worker.js
import { connect } from 'cloudflare:sockets';
import { hmac } from 'cloudflare:crypto'; // Using Cloudflare's built-in crypto for HMAC

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('🔥 PHANTOM GATEWAY WORKER OPERATIONAL 🔥', { status: 200 });
    }

    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
      return this.handleWebSocket(request, env);
    }

    return new Response('Expected WebSocket upgrade or /health endpoint.', { status: 400 });
  },

  async handleWebSocket(request, env) {
    const authHeader = request.headers.get('X-Phantom-Auth');
    if (!authHeader) {
      return new Response('Unauthorized: Missing X-Phantom-Auth header', { status: 401 });
    }

    const [timestampStr, signatureHex] = authHeader.split('.');
    if (!timestampStr || !signatureHex) {
      return new Response('Unauthorized: Invalid X-Phantom-Auth format', { status: 401 });
    }

    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp) || Date.now() - timestamp > 5000) { // 5-second window
      return new Response('Unauthorized: Authentication timestamp expired or invalid', { status: 401 });
    }

    if (!env.AUTH_SECRET) {
      console.error("AUTH_SECRET is not configured in Worker environment.");
      return new Response('Server authentication error', { status: 500 });
    }

    // Cloudflare's hmac.verify expects the key to be ArrayBuffer or Uint8Array.
    // The signature should be hex, data also ArrayBuffer or Uint8Array.
    const secretKeyBytes = new TextEncoder().encode(env.AUTH_SECRET);
    const dataBytes = new TextEncoder().encode(timestampStr);

    let isValid = false;
    try {
        isValid = await hmac.verify('SHA-256', secretKeyBytes, signatureHex, dataBytes);
    } catch (e) {
        console.error("Error during HMAC verification:", e.message);
        // This could happen if signatureHex is not a valid hex string, for example.
        return new Response('Unauthorized: Invalid signature format', { status: 401 });
    }

    if (!isValid) {
      return new Response('Unauthorized: Invalid authentication signature', { status: 401 });
    }

    const [clientWebSocket, serverWebSocket] = Object.values(new WebSocketPair());
    serverWebSocket.accept();

    serverWebSocket.addEventListener('message', async (event) => {
      try {
        const message = JSON.parse(event.data);

        if (message.type === 'connect' && message.host && message.port) {
          if (!env.TUNNEL_HOST || !env.TUNNEL_PORT) {
            console.error("TUNNEL_HOST or TUNNEL_PORT is not configured in Worker environment.");
            serverWebSocket.send(JSON.stringify({ type: 'error', sessionId: message.sessionId, message: 'Tunnel misconfiguration on server.' }));
            // serverWebSocket.close(1011, "Server tunnel misconfiguration"); // Closing WebSocket might be too abrupt
            return;
          }

          const tunnelSocket = connect({
            hostname: env.TUNNEL_HOST,
            port: parseInt(env.TUNNEL_PORT, 10),
          });

          const writer = tunnelSocket.writable.getWriter();
          await writer.write(new TextEncoder().encode(`${message.host}:${message.port}\n`));
          writer.releaseLock();

          this.setupForwarding(serverWebSocket, tunnelSocket, message.sessionId || "N/A");

        } else {
          console.log("Received unhandled message type or format from client:", message.type);
        }
      } catch (err) {
        console.error('Error handling client message:', err.stack);
        serverWebSocket.send(JSON.stringify({ type: 'error', sessionId: "unknown", message: 'Error processing your request.' }));
      }
    });

    serverWebSocket.addEventListener('close', event => {
      console.log(`Server WebSocket closed: code ${event.code}, reason: ${event.reason}`);
    });
    serverWebSocket.addEventListener('error', error => {
      console.error('Server WebSocket error:', error.message || error);
    });

    return new Response(null, { status: 101, webSocket: clientWebSocket });
  },

  setupForwarding(websocket, tunnelSocket, sessionId) {
    let tunnelWriter;
    try {
        tunnelWriter = tunnelSocket.writable.getWriter();
    } catch (e) {
        console.error(`[${sessionId}] Failed to get tunnel writer:`, e);
        websocket.close(1011, "Tunnel connection error");
        return;
    }

    const clientWsListener = async (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'data' && message.data && message.sessionId === sessionId) {
          // Data from client is base64 encoded. Decode to binary for the tunnel.
          const binaryData = Uint8Array.from(atob(message.data), c => c.charCodeAt(0));
          await tunnelWriter.write(binaryData);
        } else if (message.type === 'close' && message.sessionId === sessionId) {
           console.log(`[${sessionId}] Client requested close for session.`);
           if (tunnelWriter) {
            await tunnelWriter.close(); // Close the writable side of the tunnel
           }
           // WebSocket will be closed by its own 'close' event handler or by client closing
        }
      } catch (err) {
        console.error(`[${sessionId}] Error forwarding data from client to tunnel:`, err.stack);
        // websocket.close(1011, "Forwarding error"); // Avoid abrupt close if possible
      }
    };
    websocket.addEventListener('message', clientWsListener);

    const processTunnelData = async () => {
      let tunnelReader;
      try {
        tunnelReader = tunnelSocket.readable.getReader();
      } catch (e) {
        console.error(`[${sessionId}] Failed to get tunnel reader:`, e);
        websocket.close(1011, "Tunnel connection error");
        return;
      }

      try {
        while (true) {
          const { value, done } = await reader.read(); // Corrected: use tunnelReader
          if (done) {
            console.log(`[${sessionId}] Tunnel stream ended. Notifying client.`);
            if (websocket.readyState === WebSocket.OPEN) {
                websocket.send(JSON.stringify({ type: 'close', sessionId }));
            }
            // Do not close websocket here, let client or other events handle it.
            break;
          }
          // Data from tunnel is binary. Encode to base64 for WebSocket.
          const base64Data = btoa(String.fromCharCode.apply(null, new Uint8Array(value)));
          if (websocket.readyState === WebSocket.OPEN) {
            websocket.send(JSON.stringify({
              type: 'data',
              sessionId,
              data: base64Data
            }));
          }
        }
      } catch (err) {
        console.error(`[${sessionId}] Error reading from tunnel or sending to client:`, err.stack);
        if (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING) {
            websocket.close(1011, 'Tunnel read/forward error');
        }
      } finally {
        if (tunnelReader) tunnelReader.releaseLock();
      }
    };

    processTunnelData().catch(e => {
        console.error(`[${sessionId}] Uncaught error in processTunnelData:`, e);
        if (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING) {
            websocket.close(1011, 'Tunnel processing error');
        }
    });

    websocket.addEventListener('close', async (event) => {
      console.log(`[${sessionId}] Client WebSocket closed (code: ${event.code}, reason: ${event.reason}). Cleaning up.`);
      websocket.removeEventListener('message', clientWsListener);
      if (tunnelWriter) {
        try {
          // Check if tunnelSocket is already closed or closing
          // if (tunnelSocket.writable && !tunnelSocket.writable.locked) { // This check is not standard/easy
          await tunnelWriter.close();
          // }
        } catch (e) {
          console.warn(`[${sessionId}] Error closing tunnel writer (may already be closed): ${e.message}`);
        }
      }
      if (tunnelSocket && typeof tunnelSocket.close === 'function') { // TCP Sockets from connect() might not have .close()
        try {
            // For cloudflare:sockets, direct .close() might not be available or needed.
            // Closing reader/writer should suffice.
            // await tunnelSocket.close();
        } catch(e) {
            console.warn(`[${sessionId}] Error closing tunnelSocket: ${e.message}`);
        }
      }
    });
  }
};
