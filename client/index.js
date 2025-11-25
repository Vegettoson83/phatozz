// client/index.js
const { SocksProxyAgent } = require('socks-proxy-agent'); // Assuming CommonJS, adjust if ESM
const WebSocket = require('ws');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs'); // For reading config.json
const path = require('path'); // For path.join

// --- Configuration Loading ---
let config = {
  workerUrl: '',
  secret: '',
  socksPort: 1080, // Default SOCKS port
  trafficGenerator: { // Default traffic generator settings
    enabled: true,
    minIntervalMs: 15000,
    maxIntervalMs: 45000,
    requestTimeoutMs: 5000,
    endpoints: [
      'https://www.google.com/gen_204',
      'https://static.cloudflareinsights.com/beacon.min.js',
      'https://www.gstatic.com/generate_204',
      'https://firefox.settings.services.mozilla.com/v1/',
    ],
    userAgents: [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15',
      'Mozilla/5.0 (Linux; Android 10; SM-A505FN) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0'
    ]
  }
};

try {
  // The deploy-ultimate.sh script creates config.json in the client directory
  const configPath = path.join(__dirname, 'config.json');
  if (fs.existsSync(configPath)) {
    const rawConfig = fs.readFileSync(configPath, 'utf8');
    const loadedConfig = JSON.parse(rawConfig);
    config = { ...config, ...loadedConfig }; // Merge, allowing config.json to override defaults
    // Merge trafficGenerator settings specifically if present in config.json
    if (loadedConfig.trafficGenerator) {
        config.trafficGenerator = { ...config.trafficGenerator, ...loadedConfig.trafficGenerator };
    }
    console.log("[CONFIG] Loaded configuration from config.json");
  } else {
    console.warn("[CONFIG] config.json not found. Using default/environment variable configuration.");
    // Allow overrides via environment variables if config.json is not present
    config.workerUrl = process.env.PHANTOM_WORKER_URL || config.workerUrl;
    config.secret = process.env.PHANTOM_SECRET || config.secret;
    config.socksPort = parseInt(process.env.PHANTOM_SOCKS_PORT, 10) || config.socksPort;
  }
} catch (err) {
  console.error('[CONFIG] Error loading config.json:', err.message);
  // Exit if essential config like workerUrl or secret is missing
  if (!config.workerUrl || !config.secret) {
    console.error("[FATAL] Worker URL or secret is missing. Cannot start client. Check config.json or environment variables.");
    process.exit(1);
  }
}


const logger = {
  info: (...args) => console.log(`[INFO ${new Date().toISOString()}]`, ...args),
  error: (...args) => console.error(`[ERROR ${new Date().toISOString()}]`, ...args),
  debug: (...args) => { if (process.env.NODE_ENV === 'debug' || config.debug) console.log(`[DEBUG ${new Date().toISOString()}]`, ...args); }
};

class PhantomClient {
  constructor(clientConfig) {
    this.config = clientConfig;
    this.ws = null;
    this.connections = new Map(); // sessionId -> { clientSocket, host, port }
    this.reconnectAttempts = 0;
    this.stats = {
      bytesSent: 0,
      bytesReceived: 0,
      activeConnections: 0,
      totalConnections: 0,
      errors: 0,
      wsStatus: 'DISCONNECTED'
    };
    this.trafficGenTimeout = null;
    this.socksServer = null; // To properly close it
  }

  generateAuthToken() {
    const timestamp = Date.now().toString();
    const signature = crypto.createHmac('sha256', this.config.secret)
      .update(timestamp)
      .digest('hex');
    return `${timestamp}.${signature}`;
  }

  connectToWorker() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
        logger.info('WebSocket connection attempt already in progress or open.');
        return;
    }

    logger.info(`Attempting to connect to Worker: ${this.config.workerUrl}`);
    this.stats.wsStatus = 'CONNECTING';
    this.ws = new WebSocket(this.config.workerUrl, {
      headers: {
        'X-Phantom-Auth': this.generateAuthToken(),
        'User-Agent': this.config.trafficGenerator.userAgents[Math.floor(Math.random() * this.config.trafficGenerator.userAgents.length)]
      },
      // Add timeout for WebSocket connection attempt
      handshakeTimeout: 10000 // 10 seconds
    });

    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.stats.wsStatus = 'CONNECTED';
      logger.info('🔥 Successfully connected to Phantom Worker.');
    });

    this.ws.on('message', (data) => this.handleWorkerMessage(data));

    this.ws.on('close', (code, reason) => {
      this.stats.wsStatus = 'DISCONNECTED';
      const reasonStr = reason ? reason.toString() : 'No reason given';
      logger.error(`💀 WebSocket connection closed (Code: ${code}, Reason: ${reasonStr})`);

      // Clean up all active SOCKS connections associated with this WebSocket instance
      this.connections.forEach((conn, sessionId) => {
        conn.clientSocket.destroy(); // Close the SOCKS client socket
      });
      this.connections.clear(); // Clear the map
      this.stats.activeConnections = 0;

      const delay = Math.min(30000, Math.pow(2, this.reconnectAttempts) * 1000); // Exponential backoff
      logger.info(`Retrying connection in ${delay / 1000}s... (Attempt: ${this.reconnectAttempts + 1})`);
      setTimeout(() => this.connectToWorker(), delay);
      this.reconnectAttempts++;
    });

    this.ws.on('error', (err) => {
      this.stats.errors++;
      logger.error('WebSocket error:', err.message);
      // 'close' event will typically follow and handle reconnection logic
      if (this.ws.readyState !== WebSocket.CLOSED && this.ws.readyState !== WebSocket.CLOSING) {
        this.ws.terminate(); // Force close if not already closing
      }
    });
  }

  handleWorkerMessage(rawData) {
    try {
      const message = JSON.parse(rawData.toString());
      logger.debug('Received message from worker:', JSON.stringify(message).substring(0, 200));

      switch (message.type) {
        case 'data':
          if (message.sessionId && message.data) {
            this.handleDataMessage(message.sessionId, message.data);
          } else {
            logger.error("Invalid 'data' message format from worker:", message);
          }
          break;
        case 'error':
          this.stats.errors++;
          logger.error(`Received error from worker: ${message.message || 'Unknown error'}`);
          if (message.sessionId) {
            this.cleanupConnection(message.sessionId, "Worker error for session");
          }
          break;
        case 'close':
          if (message.sessionId) {
            logger.info(`Worker closed session: ${message.sessionId}`);
            this.cleanupConnection(message.sessionId, "Worker closed session");
          }
          break;
        default:
          logger.info(`Received unhandled message type from worker: ${message.type}`);
      }
    } catch (err) {
      this.stats.errors++;
      logger.error('Error processing message from worker:', err.message, rawData.toString());
    }
  }

  handleDataMessage(sessionId, base64Data) {
    const connection = this.connections.get(sessionId);
    if (connection && connection.clientSocket.writable) {
      try {
        const buffer = Buffer.from(base64Data, 'base64');
        connection.clientSocket.write(buffer);
        this.stats.bytesReceived += buffer.length;
        logger.debug(`Relayed ${buffer.length} bytes to SOCKS client for session ${sessionId}`);
      } catch (err) {
        this.stats.errors++;
        logger.error(`Error writing data to SOCKS client (session ${sessionId}):`, err.message);
        this.cleanupConnection(sessionId, "Error writing to SOCKS client");
      }
    } else {
      logger.debug(`No writable client socket for session ${sessionId} or connection not found.`);
    }
  }

  startSocksServer() {
    if (this.socksServer) {
        logger.info("SOCKS server already started.");
        return;
    }
    this.socksServer = net.createServer(clientSocket => {
      const sessionId = crypto.randomBytes(8).toString('hex');
      let FSM_state = 'VERSION_NEGOTIATION'; // Finite State Machine for SOCKS handshake

      clientSocket.on('data', (data) => {
        logger.debug(`[${sessionId}] SOCKS data received in state ${FSM_state}, length: ${data.length}`);
        try {
            if (FSM_state === 'VERSION_NEGOTIATION') {
                if (data[0] !== 0x05) {
                    logger.error(`[${sessionId}] Unsupported SOCKS version: ${data[0]}. Closing.`);
                    clientSocket.end(); return;
                }
                // VER | NMETHODS | METHODS -> VER | METHOD (No Auth)
                clientSocket.write(Buffer.from([0x05, 0x00]));
                FSM_state = 'REQUEST_NEGOTIATION';
            } else if (FSM_state === 'REQUEST_NEGOTIATION') {
                // VER | CMD | RSV | ATYP | DST.ADDR | DST.PORT
                if (data[0] !== 0x05 || data[1] !== 0x01) { // CONNECT command
                    logger.error(`[${sessionId}] Invalid SOCKS request or not CONNECT. CMD: ${data[1]}. Closing.`);
                    clientSocket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0,0,0,0, 0,0])); // Command not supported
                    clientSocket.end(); return;
                }

                const atyp = data[3];
                let targetHost, targetPort;
                let offset = 4;

                if (atyp === 0x01) { // IPv4
                    targetHost = `${data[offset++]}.${data[offset++]}.${data[offset++]}.${data[offset++]}`;
                } else if (atyp === 0x03) { // Domain name
                    const len = data[offset++];
                    targetHost = data.subarray(offset, offset + len).toString();
                    offset += len;
                } else if (atyp === 0x04) { // IPv6
                    targetHost = Array.from({length: 8}, (_, i) => data.subarray(offset + i*2, offset + i*2 + 2).toString('hex')).join(':');
                    offset += 16;
                } else {
                    logger.error(`[${sessionId}] Unsupported address type: ${atyp}. Closing.`);
                    clientSocket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0,0,0,0, 0,0])); // Address type not supported
                    clientSocket.end(); return;
                }
                targetPort = data.readUInt16BE(offset);

                logger.info(`[${sessionId}] SOCKS request for ${targetHost}:${targetPort}`);
                this.connections.set(sessionId, { clientSocket, host: targetHost, port: targetPort });
                this.stats.activeConnections = this.connections.size;
                this.stats.totalConnections++;

                if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                    logger.error(`[${sessionId}] WebSocket not connected. Cannot establish tunnel for ${targetHost}:${targetPort}.`);
                    clientSocket.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0,0,0,0, 0,0])); // General SOCKS server failure
                    this.cleanupConnection(sessionId, "WebSocket not open for SOCKS request");
                    return;
                }

                this.ws.send(JSON.stringify({ type: 'connect', sessionId, host: targetHost, port: targetPort }));
                // VER | REP | RSV | ATYP | BND.ADDR | BND.PORT (0.0.0.0:0)
                clientSocket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0,0,0,0, 0,0]));
                FSM_state = 'DATA_TRANSFER';
            } else if (FSM_state === 'DATA_TRANSFER') {
                if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                    logger.error(`[${sessionId}] WebSocket not open. Dropping data.`);
                    this.cleanupConnection(sessionId, "WebSocket not open during data phase");
                    return;
                }
                const base64Chunk = data.toString('base64');
                this.ws.send(JSON.stringify({ type: 'data', sessionId, data: base64Chunk }));
                this.stats.bytesSent += data.length;
                logger.debug(`Relayed ${data.length} bytes from SOCKS client (session ${sessionId}) to worker.`);
            }
        } catch (e) {
            logger.error(`[${sessionId}] Error in SOCKS FSM state ${FSM_state}: ${e.message}`);
            this.cleanupConnection(sessionId, `SOCKS FSM error: ${e.message}`);
        }
      });

      clientSocket.on('end', () => {
        logger.info(`SOCKS client disconnected (session ${sessionId}). State: ${FSM_state}`);
        this.cleanupConnection(sessionId, "SOCKS client ended connection");
      });

      clientSocket.on('error', (err) => {
        this.stats.errors++;
        logger.error(`SOCKS client error (session ${sessionId}):`, err.message);
        this.cleanupConnection(sessionId, "SOCKS client error");
      });
    }).listen(this.config.socksPort, '127.0.0.1', () => {
      logger.info(`🔌 SOCKS5 proxy server listening on 127.0.0.1:${this.config.socksPort}`);
    });

    this.socksServer.on('error', (err) => {
        this.stats.errors++;
        logger.error('SOCKS Server Global Error:', err.message);
        if (err.code === 'EADDRINUSE') {
            logger.error(`Port ${this.config.socksPort} is already in use. Phantom Client SOCKS server cannot start.`);
            process.exit(1); // Fatal if SOCKS server can't start
        }
    });
  }

  cleanupConnection(sessionId, reason = "Unknown") {
    const connection = this.connections.get(sessionId);
    if (connection) {
      if (!connection.clientSocket.destroyed) {
        connection.clientSocket.destroy();
      }
      this.connections.delete(sessionId);
      this.stats.activeConnections = this.connections.size;
      logger.info(`Cleaned up connection for session ${sessionId}. Reason: ${reason}`);

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'close', sessionId, reason }));
      }
    }
  }

  startHealthMonitor() {
    setInterval(() => {
      this.stats.activeConnections = this.connections.size;
      logger.info(`[HEALTH] ${JSON.stringify(this.stats)}`);
    }, 60000);
  }

  startTrafficGenerator() {
    if (!this.config.trafficGenerator.enabled) {
      logger.info("[TRAFFIC GEN] Disabled.");
      return;
    }
    logger.info("[TRAFFIC GEN] Starting traffic generator...");

    const makeRequest = async () => {
      const { endpoints, userAgents, requestTimeoutMs } = this.config.trafficGenerator;
      if (endpoints.length === 0) {
        const { minIntervalMs, maxIntervalMs } = this.config.trafficGenerator;
        const nextInterval = minIntervalMs + Math.random() * (maxIntervalMs - minIntervalMs);
        this.trafficGenTimeout = setTimeout(makeRequest, nextInterval);
        return;
      }
      const endpoint = endpoints[Math.floor(Math.random() * endpoints.length)];
      const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];

      try {
        logger.debug(`[TRAFFIC GEN] Sending request to ${endpoint}`);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);

        const agent = (this.ws && this.ws.readyState === WebSocket.OPEN && this.config.socksPort && this.socksServer && this.socksServer.listening) ?
                 new SocksProxyAgent(`socks5h://127.0.0.1:${this.config.socksPort}`) : undefined;

        if (!agent && this.config.trafficGenerator.enabled) {
            logger.debug("[TRAFFIC GEN] SOCKS proxy not available for traffic generation, sending direct.");
        }

        const response = await fetch(endpoint, {
          method: 'GET',
          headers: { 'User-Agent': userAgent, 'Accept': '*/*' },
          signal: controller.signal,
          agent: agent
        });
        clearTimeout(timeoutId);
        logger.debug(`[TRAFFIC GEN] Request to ${endpoint} status: ${response.status}`);
        await response.text();
      } catch (err) {
        if (err.name === 'AbortError') {
          logger.debug(`[TRAFFIC GEN] Request to ${endpoint} timed out.`);
        } else {
          logger.debug(`[TRAFFIC GEN] Request to ${endpoint} failed: ${err.message}`);
        }
      } finally {
        const { minIntervalMs, maxIntervalMs } = this.config.trafficGenerator;
        const nextInterval = minIntervalMs + Math.random() * (maxIntervalMs - minIntervalMs);
        if(this.config.trafficGenerator.enabled) { // Check again in case it was disabled during async op
            this.trafficGenTimeout = setTimeout(makeRequest, nextInterval);
            logger.debug(`[TRAFFIC GEN] Next request in ${Math.round(nextInterval/1000)}s`);
        } else {
            logger.info("[TRAFFIC GEN] Stopped during async operation.");
        }
      }
    };
    if (this.config.trafficGenerator.enabled) makeRequest();
  }

  async start() {
    logger.info("🚀 Starting Phantom Client...");
    if (!this.config.workerUrl || !this.config.secret) {
      logger.error("[FATAL] Worker URL or Secret is not configured. Exiting.");
      process.exit(1);
    }
    this.connectToWorker();
    this.startSocksServer();
    this.startHealthMonitor();
    this.startTrafficGenerator();
  }

  stop() {
    logger.info("🔌 Stopping Phantom Client...");
    this.config.trafficGenerator.enabled = false; // Signal to stop generator
    if (this.trafficGenTimeout) clearTimeout(this.trafficGenTimeout);

    if (this.ws) {
      this.ws.removeAllListeners(); // Remove listeners to prevent reconnection attempts
      this.ws.close(1000, "Client shutting down");
    }
    this.connections.forEach((conn) => {
      if (!conn.clientSocket.destroyed) conn.clientSocket.destroy();
    });
    this.connections.clear();

    if (this.socksServer) {
        this.socksServer.close(() => {
            logger.info("SOCKS server closed.");
        });
    }
    logger.info("Phantom Client shutdown sequence complete.");
  }
}

const client = new PhantomClient(config);
client.start().catch(err => {
    logger.error("Unhandled error during client startup:", err);
    process.exit(1);
});

let shuttingDown = false;
const gracefulShutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received. Shutting down client gracefully...`);
    client.stop();
    // Allow some time for cleanup before exiting
    setTimeout(() => {
        logger.info("Exiting now.");
        process.exit(0);
    }, 2000); // 2 seconds for cleanup
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
    logger.error('UNCAUGHT EXCEPTION:', error);
    // In a real app, you might try to gracefully shutdown or just log and exit
    gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', (reason, promise) => {
    logger.error('UNHANDLED REJECTION at:', promise, 'reason:', reason);
    gracefulShutdown('unhandledRejection');
});
