import { Router } from 'express';
import type { RequestHandler, Response } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { routeTable } from '../utils/routeTable.js';
import { authenticate } from '../middleware/authenticate.js';

const proxyCache = new Map<string, RequestHandler>();

function getProxy(target: string): RequestHandler {
  if (!proxyCache.has(target)) {
    proxyCache.set(
      target,
      createProxyMiddleware({
        target,
        changeOrigin: true,
        on: {
          error: (_err, _req, res) => {
            (res as unknown as Response).status(502).json({
              error: { code: 'BAD_GATEWAY', message: 'Upstream service unavailable' },
            });
          },
        },
      }),
    );
  }
  return proxyCache.get(target)!;
}

export const proxyRouter = Router();

proxyRouter.use((req, res, next) => {
  const route = routeTable.match(req.path);
  if (!route) {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
    return;
  }
  if (route.auth) {
    authenticate(req, res, () => {
      getProxy(route.target)(req, res, next);
    });
    return;
  }
  getProxy(route.target)(req, res, next);
});
