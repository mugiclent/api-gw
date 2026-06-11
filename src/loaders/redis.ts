import { Redis } from 'ioredis';
import { config } from '../config/index.js';

let redisClient: Redis;

type RedisHealth = { ok: boolean; error?: string };
let redisHealth: RedisHealth = { ok: false, error: 'not yet connected' };

export const getRedisHealth = (): RedisHealth => redisHealth;

export const initRedis = (): void => {
  redisClient = new Redis(config.redis.url, {
    lazyConnect: false,
    // null = buffer commands while reconnecting instead of throwing after N retries
    maxRetriesPerRequest: null,
  });

  redisClient.on('ready', () => {
    redisHealth = { ok: true };
    console.warn('[redis] Connected');
  });

  redisClient.on('error', (err: Error) => {
    redisHealth = { ok: false, error: err.message };
    console.warn('[redis] Error:', err.message);
  });

  redisClient.on('close', () => {
    redisHealth = { ok: false, error: 'connection closed — reconnecting' };
  });

  redisClient.on('end', () => {
    redisHealth = { ok: false, error: 'connection ended' };
    console.warn('[redis] Connection ended');
  });
};

export const getRedisClient = (): Redis => {
  if (!redisClient) throw new Error('Redis client not initialized');
  return redisClient;
};

export const closeRedis = async (): Promise<void> => {
  if (redisClient) await redisClient.quit();
};

/**
 * Returns true if any revocation key applies to this token's identity.
 *
 * Checked in one round-trip (pipeline):
 *   blacklist:user:<sub>        — user deleted / suspended / logged-out-all / password-reset
 *   blacklist:org:<org_id>      — org blocked
 *   blacklist:session:<sid>     — that one session logged out
 *
 * Each key is written by user-service with a TTL matching the access-token
 * lifetime (900s), so the access token is blocked for the rest of its life and
 * the key then self-expires.
 *
 * Fail-open: if Redis is unreachable the request is allowed through (a Redis blip
 * must not take down all authenticated traffic). The window is bounded by the
 * 15-minute access-token TTL, and the write side is already best-effort.
 */
export const isRevoked = async (ids: {
  sub: string;
  org_id?: string | null;
  session_id?: string;
}): Promise<boolean> => {
  try {
    const keys = [`blacklist:user:${ids.sub}`];
    if (ids.org_id) keys.push(`blacklist:org:${ids.org_id}`);
    if (ids.session_id) keys.push(`blacklist:session:${ids.session_id}`);

    const hits = await getRedisClient().exists(...keys);
    return hits > 0;
  } catch (err) {
    console.warn('[redis] Revocation check failed (fail-open):', (err as Error).message);
    return false;
  }
};
