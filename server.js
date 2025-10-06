// steam_worker/server.js

const express = require('express');
const WorkerLogic = require('./src/worker_logic');
require('dotenv').config();

const app = express();
const PORT = process.env.STEAM_WORKER_PORT || 3003;
const API_KEY = process.env.LINK_HARVESTER_API_KEY;

// Middleware
app.use(express.json({ limit: '10mb' }));

// Logger
const logger = {
  info: (msg) => console.log(`[${new Date().toISOString()}] [STEAM_WORKER] INFO: ${msg}`),
  warn: (msg) => console.log(`[${new Date().toISOString()}] [STEAM_WORKER] WARN: ${msg}`),
  error: (msg) => console.log(`[${new Date().toISOString()}] [STEAM_WORKER] ERROR: ${msg}`),
  debug: (msg) => console.log(`[${new Date().toISOString()}] [STEAM_WORKER] DEBUG: ${msg}`)
};

// API Key authentication middleware
const authenticateApiKey = (req, res, next) => {
  const providedKey = req.headers['x-api-key'];
  
  if (!providedKey) {
    logger.warn('Request without API key');
    return res.status(401).json({
      success: false,
      error: 'API key required'
    });
  }
  
  if (providedKey !== API_KEY) {
    logger.warn('Request with invalid API key');
    return res.status(403).json({
      success: false,
      error: 'Invalid API key'
    });
  }
  
  next();
};

// Health check endpoint (no auth required)
app.get('/api/steam/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    timestamp: new Date().toISOString(),
    worker_id: process.env.RENDER_SERVICE_NAME || 'local',
    port: PORT
  });
});

// Main processing endpoint
app.post('/api/steam/process-invites', authenticateApiKey, async (req, res) => {
  const startTime = Date.now();
  logger.info('Received process-invites request');
  
  try {
    // Validate request body
    const { account, credentials, targets, options } = req.body;
    
    if (!account || !credentials || !targets || !options) {
      logger.warn('Invalid request: missing required fields');
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: account, credentials, targets, options'
      });
    }
    
    if (!Array.isArray(targets) || targets.length === 0) {
      logger.warn('Invalid request: targets must be non-empty array');
      return res.status(400).json({
        success: false,
        error: 'Targets must be a non-empty array'
      });
    }
    
    // Validate credentials
    if (!credentials.username || !credentials.password || !credentials.sharedSecret) {
      logger.warn('Invalid request: incomplete credentials');
      return res.status(400).json({
        success: false,
        error: 'Incomplete credentials (username, password, sharedSecret required)'
      });
    }
    
    logger.info(`Processing request for account: ${account.username || account.steam_login}`);
    logger.info(`Targets: ${targets.length}, Max batch: ${options.max_invites_per_batch || 30}`);
    
    // Initialize worker logic
    const worker = new WorkerLogic(logger);
    
    // Process invites
    const result = await worker.processInvites({
      account,
      credentials,
      targets,
      options
    });
    
    const processingTime = Date.now() - startTime;
    logger.info(`Request processed in ${processingTime}ms: success=${result.success}, ` +
      `successful=${result.results.successful.length}, failed=${result.results.failed.length}`);
    
    // Add worker metadata to response
    result.worker_info = {
      worker_id: process.env.RENDER_SERVICE_NAME || 'local',
      processing_time_ms: processingTime,
      timestamp: new Date().toISOString()
    };
    
    res.json(result);
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    logger.error(`Request failed after ${processingTime}ms: ${error.message}`);
    logger.error(`Stack: ${error.stack}`);
    
    res.status(500).json({
      success: false,
      error: error.message,
      worker_info: {
        worker_id: process.env.RENDER_SERVICE_NAME || 'local',
        processing_time_ms: processingTime,
        timestamp: new Date().toISOString()
      }
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.message}`);
  logger.error(`Stack: ${err.stack}`);
  
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    worker_info: {
      worker_id: process.env.RENDER_SERVICE_NAME || 'local',
      timestamp: new Date().toISOString()
    }
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Steam Worker API listening on port ${PORT}`);
  logger.info(`Worker ID: ${process.env.RENDER_SERVICE_NAME || 'local'}`);
  logger.info(`Health check: http://localhost:${PORT}/api/steam/health`);
  logger.info(`Process invites: POST http://localhost:${PORT}/api/steam/process-invites`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully...');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

module.exports = app;