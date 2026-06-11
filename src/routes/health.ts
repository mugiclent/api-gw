import { Router } from 'express';
import { routeTable } from '../utils/routeTable.js';
import { getRedisHealth } from '../loaders/redis.js';

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  // Redis is a soft dependency (revocation checks fail-open), so a Redis outage
  // is reported but does not flip the gateway to unhealthy.
  const redis = getRedisHealth();
  res.json({
    status: 'ok',
    routes: routeTable.get().length,
    checks: { redis: redis.ok ? 'up' : 'down' },
  });
});
