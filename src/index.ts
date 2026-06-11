import 'dotenv/config';
import { config } from './config/index.js';
import { configWatcher } from './loaders/configWatcher.js';
import { initRedis, closeRedis } from './loaders/redis.js';
import { createApp } from './app.js';

async function main(): Promise<void> {
  // Load routes before accepting connections — crash if initial fetch fails
  await configWatcher.init();

  // Connect Redis for token-revocation checks (non-blocking; fail-open if down)
  initRedis();

  const app = createApp();

  const server = app.listen(config.port, () => {
    console.warn(`[api-gw] listening on port ${config.port}`);
  });

  const shutdown = (): void => {
    console.warn('[api-gw] shutting down...');
    configWatcher.stop();
    void closeRedis();
    server.close(() => {
      console.warn('[api-gw] graceful shutdown complete');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  console.error('[api-gw] fatal startup error:', err);
  process.exit(1);
});
