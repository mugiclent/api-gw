import { Router } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { config } from '../config/index.js';

export const jwksRouter = Router();

jwksRouter.get(
  '/.well-known/jwks.json',
  createProxyMiddleware({
    target: config.userService.url,
    changeOrigin: true,
  }),
);
