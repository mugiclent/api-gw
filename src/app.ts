import express from 'express';
import { healthRouter } from './routes/health.js';
import { jwksRouter } from './routes/jwks.js';
import { proxyRouter } from './routes/index.js';
import { errorHandler } from './middleware/errorHandler.js';

export function createApp() {
  const app = express();

  // Special routes — always registered first so routes.yaml can never shadow them
  app.use(healthRouter);
  app.use(jwksRouter);

  // Dynamic proxy router — reads from in-memory route table on every request
  app.use(proxyRouter);

  // Error handler — catches unhandled exceptions
  app.use(errorHandler);

  return app;
}
