import { createHash } from 'crypto';
import yaml from 'js-yaml';
import { config } from '../config/index.js';
import { routeTable } from '../utils/routeTable.js';
import type { Route } from '../utils/routeTable.js';

interface RoutesYaml {
  routes: Route[];
}

let lastHash = '';
let pollInterval: ReturnType<typeof setInterval> | null = null;

async function fetchAndApply(): Promise<void> {
  let body: string;

  try {
    const headers: Record<string, string> = {};
    if (config.configRepo.token) {
      headers['Authorization'] = `token ${config.configRepo.token}`;
    }
    const response = await fetch(config.configRepo.url, { headers });

    if (!response.ok) {
      console.error(`[config-watcher] fetch failed: HTTP ${response.status}`);
      return;
    }

    body = await response.text();
  } catch (err) {
    console.error('[config-watcher] fetch error:', err);
    return;
  }

  const hash = createHash('sha256').update(body).digest('hex');
  if (hash === lastHash) return;

  try {
    const parsed = yaml.load(body) as RoutesYaml;
    const routes = parsed.routes;
    routeTable.set(routes);
    lastHash = hash;
    console.warn(`[config-watcher] routes reloaded — ${routes.length} routes active`);
  } catch (err) {
    console.error('[config-watcher] parse error:', err);
  }
}

export const configWatcher = {
  async init(): Promise<void> {
    await fetchAndApply();
    if (routeTable.get().length === 0) {
      throw new Error('[config-watcher] Initial config load failed — no routes loaded');
    }
    pollInterval = setInterval(() => {
      void fetchAndApply();
    }, config.configRepo.pollIntervalMs);
  },

  stop(): void {
    if (pollInterval !== null) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  },
};
