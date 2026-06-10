import { env } from './env.js';

export const config = {
  port: env.PORT,
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',

  jwt: {
    // PEM key — replace literal \n from .env with real newlines
    publicKey: env.JWT_PUBLIC_KEY.replace(/\\n/g, '\n'),
  },

  configRepo: {
    url: env.ROUTES_URL,
    token: env.ROUTES_TOKEN,
    pollIntervalMs: env.ROUTES_POLL_INTERVAL_MS,
  },

  userService: {
    url: env.USER_SERVICE_URL,
  },

  cors: {
    // true = reflect request origin (allows all origins, compatible with credentials: true)
    origins: env.CORS_ORIGINS.trim() === '*' ? true : env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
  },
} as const;
