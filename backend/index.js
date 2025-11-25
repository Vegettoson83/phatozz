// backend/index.js
const net = require('net');
const { SocksProxyAgent } = require('socks-proxy-agent'); // Assuming CommonJS
const { createBrotliCompress, createBrotliDecompress } = require('zlib');
const crypto = require('crypto');

const logger = {
  info: (...args) => console.log(`[INFO ${new Date().toISOString()}]`, ...args),
  error: (...args) => console.error(`[ERROR ${new Date().toISOString()}]`, ...args),
  debug: (...args) => { if (process.env.NODE_ENV === 'debug') console.log(`[DEBUG ${new Date().toISOString()}]`, ...args); }
};

class PhantomBackend {
  constructor() {
    this.connections = new Map(); // connectionId -> { socket, targetSocket, host, port }
    this.metrics = {
      activeConnections: 0,
      totalConnections: 0,
      bytesTransferredToTarget: 0,
      bytesTransferredFromTarget: 0,
      errorCount: 0
    };
    this.server = null;
  }

  start(port = 3000) {
    if (this.server) {
        logger.info("Backend server already started.");
        return;
    }
    this.server = net.createServer(socket => {
      const connectionId = crypto.randomBytes(4).toString('hex');
      logger.info(`[${connectionId}] Client connected from ${socket.remoteAddress}:${socket.remotePort}`);

      this.metrics.totalConnections++;
      this.metrics.activeConnections++;
      this.connections.set(connectionId, { socket }); // Store socket early

      let headerBuffer = Buffer.alloc(0);
      let targetHost = '';
      let targetPort = 0;
      let useCompression = false;
      let targetSocket = null;
      let compressionStream = null;
      let decompressionStream = null;
      let connectionSetupDone = false;

      const handleError = (err, context = "General") => {
        this.metrics.errorCount++;
        logger.error(`[${connectionId}] Error (${context}) for ${targetHost}:${targetPort}: ${err.message}`);
        if (targetSocket && !targetSocket.destroyed) targetSocket.destroy();
        if (socket && !socket.destroyed) socket.destroy(); // client socket to worker
        this.connections.delete(connectionId);
        this.metrics.activeConnections = this.connections.size;
      };

      socket.on('data', data => {
        if (!connectionSetupDone) {
          headerBuffer = Buffer.concat([headerBuffer, data]);
          const newlineIndex = headerBuffer.indexOf('\n');

          if (newlineIndex !== -1) {
            const headerLine = headerBuffer.subarray(0, newlineIndex).toString();
            const remainingData = headerBuffer.subarray(newlineIndex + 1);
            headerBuffer = Buffer.alloc(0); // Clear buffer

            logger.debug(`[${connectionId}] Received header: ${headerLine}`);
            const parts = headerLine.split(':');
            if (parts.length < 2) {
              handleError(new Error(`Invalid header format: ${headerLine}`), "Header Parsing");
              return;
            }
            targetHost = parts[0];
            targetPort = parseInt(parts[1], 10);
            if (parts[2] && parts[2].toLowerCase() === 'br') {
              useCompression = true;
              logger.debug(`[${connectionId}] Compression enabled for ${targetHost}:${targetPort}`);
            }

            if (isNaN(targetPort) || targetPort <= 0 || targetPort > 65535) {
              handleError(new Error(`Invalid port: ${parts[1]}`), "Header Parsing");
              return;
            }

            const connectionDetails = this.connections.get(connectionId);
            if(connectionDetails) {
                connectionDetails.host = targetHost;
                connectionDetails.port = targetPort;
            }


            try {
              const agent = process.env.EXTERNAL_PROXY
                ? new SocksProxyAgent(process.env.EXTERNAL_PROXY)
                : undefined;

              logger.info(`[${connectionId}] Attempting to connect to target: ${targetHost}:${targetPort}`);
              targetSocket = net.connect({
                host: targetHost,
                port: targetPort,
                agent,
                servername: targetHost // SNI for TLS, important for HTTPS
              });

              const conn = this.connections.get(connectionId);
              if (conn) conn.targetSocket = targetSocket;


              targetSocket.on('connect', () => {
                logger.info(`[${connectionId}] Successfully connected to target: ${targetHost}:${targetPort}`);
                connectionSetupDone = true;

                if (useCompression) {
                  compressionStream = createBrotliCompress();
                  decompressionStream = createBrotliDecompress();

                  // Pipe with compression: socket (from worker) -> decompress -> targetSocket
                  // targetSocket -> compress -> socket (to worker)
                  socket.pipe(decompressionStream).pipe(targetSocket);
                  targetSocket.pipe(compressionStream).pipe(socket);

                  decompressionStream.on('error', (err) => handleError(err, "DecompressionStream"));
                  compressionStream.on('error', (err) => handleError(err, "CompressionStream"));

                } else {
                  // Pipe without compression
                  socket.pipe(targetSocket);
                  targetSocket.pipe(socket);
                }

                if (remainingData.length > 0) {
                  logger.debug(`[${connectionId}] Forwarding ${remainingData.length} bytes of remaining data after header.`);
                  if (useCompression && decompressionStream) {
                    decompressionStream.write(remainingData);
                  } else {
                    targetSocket.write(remainingData);
                  }
                }
              });

              targetSocket.on('data', chunk => {
                this.metrics.bytesTransferredFromTarget += chunk.length;
                logger.debug(`[${connectionId}] Received ${chunk.length} bytes from target, forwarding to client.`);
              });

              targetSocket.on('end', () => {
                logger.info(`[${connectionId}] Target ${targetHost}:${targetPort} ended connection.`);
                if (!socket.destroyed) socket.end(); // End the client socket if target closes
                this.connections.delete(connectionId);
                this.metrics.activeConnections = this.connections.size;
              });
              targetSocket.on('error', (err) => handleError(err, "TargetSocket"));
              targetSocket.on('close', (hadError) => {
                logger.debug(`[${connectionId}] Target socket closed. Had error: ${hadError}`);
                if (!socket.destroyed) socket.destroy(); // Ensure client socket is also closed
                this.connections.delete(connectionId);
                this.metrics.activeConnections = this.connections.size;
              });

            } catch (err) {
              handleError(err, "TargetConnectionSetup");
            }
          } else if (headerBuffer.length > 4096) { // Protection against large headers
            handleError(new Error("Header too long"), "Header Parsing");
          }
        } else { // connectionSetupDone is true
          // This path should not be hit if piping is set up correctly,
          // as data flows directly via pipes.
          // However, if direct .write() was used instead of piping remainingData:
          logger.debug(`[${connectionId}] Data received after setup, forwarding ${data.length} bytes.`);
          if (useCompression && decompressionStream && !decompressionStream.destroyed) {
            decompressionStream.write(data);
          } else if (!useCompression && targetSocket && !targetSocket.destroyed) {
            targetSocket.write(data);
          } else {
            logger.warn(`[${connectionId}] Received data but no valid stream/socket to write to.`);
          }
        }
      });

      socket.on('data', (chunk) => { // This listener is for data from worker to target
          if(connectionSetupDone && !useCompression && targetSocket && !targetSocket.destroyed) {
              // Only if not using compression and targetSocket is ready
              // This is mostly handled by piping, but for direct writes if any
              this.metrics.bytesTransferredToTarget += chunk.length;
          } else if (connectionSetupDone && useCompression && compressionStream && !compressionStream.destroyed) {
              // If using compression, this data is before compression
              // Actual bytes to target might be different after compression
              // This metric might need refinement if exact compressed bytes are needed.
          }
      });


      socket.on('end', () => {
        logger.info(`[${connectionId}] Client (worker) ended connection.`);
        if (targetSocket && !targetSocket.destroyed) targetSocket.end();
        this.connections.delete(connectionId);
        this.metrics.activeConnections = this.connections.size;
      });
      socket.on('error', (err) => handleError(err, "ClientSocket"));
      socket.on('close', (hadError) => {
          logger.debug(`[${connectionId}] Client socket closed. Had error: ${hadError}`);
          if (targetSocket && !targetSocket.destroyed) targetSocket.destroy();
          this.connections.delete(connectionId);
          this.metrics.activeConnections = this.connections.size;
      });
    });

    this.server.listen(port, () => {
      logger.info(`🚀 Phantom Backend server listening on port ${port}`);
    });

    this.server.on('error', (err) => {
        logger.error("Backend Server Global Error:", err.message);
        if (err.code === 'EADDRINUSE') {
            logger.error(`Port ${port} is already in use. Backend server cannot start.`);
            process.exit(1);
        }
        this.metrics.errorCount++;
    });

    // Report metrics periodically
    setInterval(() => this.reportMetrics(), 30000);
  }

  reportMetrics() {
    this.metrics.activeConnections = this.connections.size; // Ensure up-to-date count
    logger.info(`[METRICS] ${JSON.stringify(this.metrics)}`);
    // Reset periodic counters if desired
    this.metrics.bytesTransferredToTarget = 0;
    this.metrics.bytesTransferredFromTarget = 0;
    // totalConnections and errorCount are cumulative
  }

  stop() {
      logger.info("🔌 Stopping Phantom Backend server...");
      this.connections.forEach(conn => {
          if (conn.socket && !conn.socket.destroyed) conn.socket.destroy();
          if (conn.targetSocket && !conn.targetSocket.destroyed) conn.targetSocket.destroy();
      });
      this.connections.clear();
      if (this.server) {
          this.server.close(() => {
              logger.info("Phantom Backend server closed.");
              this.server = null;
          });
      } else {
          logger.info("Phantom Backend server was not running.");
      }
  }
}

const backend = new PhantomBackend();
const port = parseInt(process.env.PORT, 10) || 3000;
backend.start(port);

let shuttingDownBackend = false;
const gracefulShutdownBackend = (signal) => {
    if (shuttingDownBackend) return;
    shuttingDownBackend = true;
    logger.info(`${signal} received for backend. Shutting down...`);
    backend.stop();
    setTimeout(() => {
        logger.info("Backend exiting.");
        process.exit(0);
    }, 2000);
};

process.on('SIGINT', () => gracefulShutdownBackend('SIGINT'));
process.on('SIGTERM', () => gracefulShutdownBackend('SIGTERM'));
process.on('uncaughtException', (error) => {
    logger.error('BACKEND UNCAUGHT EXCEPTION:', error);
    gracefulShutdownBackend('uncaughtException');
});
process.on('unhandledRejection', (reason, promise) => {
    logger.error('BACKEND UNHANDLED REJECTION at:', promise, 'reason:', reason);
    gracefulShutdownBackend('unhandledRejection');
});
