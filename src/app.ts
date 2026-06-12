import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { healthRouter } from './routes/health.js';
import { jwksRouter } from './routes/jwks.js';
import { proxyRouter } from './routes/index.js';
import { errorHandler } from './middleware/errorHandler.js';
import { localeResolver } from './middleware/locale.js';
import { sanitizeHeaders } from './middleware/sanitizeHeaders.js';
import { config } from './config/index.js';

export function createApp() {
  const app = express();

  app.use(cors({
    origin: config.cors.origins,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Type', 'X-Sudo-Token', 'X-Locale'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  }));

  app.use(cookieParser());

  // Strip any client-injected identity headers (x-user-*, x-org-id, x-session-id)
  // BEFORE anything else — only the gateway may set them, from a verified JWT. This
  // protects public and optional-auth routes from header spoofing.
  app.use(sanitizeHeaders);

  // Resolve the trusted locale header (and strip any client-spoofed one) for
  // every request — including anonymous ones, which never reach authenticate.
  app.use(localeResolver);

  // Special routes — always registered first so routes.yaml can never shadow them
  app.use(healthRouter);
  app.use(jwksRouter);

  // Dynamic proxy router — reads from in-memory route table on every request
  app.use(proxyRouter);

  // Error handler — catches unhandled exceptions
  app.use(errorHandler);

  return app;
}
