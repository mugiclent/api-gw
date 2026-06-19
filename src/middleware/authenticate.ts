import { jwtVerify, importSPKI } from 'jose';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config/index.js';
import { isRevoked } from '../loaders/redis.js';
import { selectedLocale, acceptLanguageLocale } from './locale.js';

interface JwtPayload {
  sub: string;
  org_id: string | null;
  user_type: 'passenger' | 'staff';
  phone_number?: string | null;
  name?: string | null;
  role_slugs: string[];
  rules: unknown[];
  locale?: string;
  session_id?: string;
  iat: number;
  exp: number;
}

// Lazy-cached public key
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _publicKey: any;
const getPublicKey = async () => {
  if (!_publicKey) _publicKey = await importSPKI(config.jwt.publicKey, 'EdDSA');
  return _publicKey;
};

const extractToken = (req: Request): string | undefined => {
  // Prefer Authorization: Bearer header; fall back to access_token cookie (web clients)
  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
  if (req.cookies?.access_token) return req.cookies.access_token as string;
  return undefined;
};

class AuthError extends Error {}

/**
 * Verify the token and stamp the trusted identity headers onto the request.
 * Throws AuthError if the token is invalid/expired or the session was revoked.
 * Inbound identity headers were already stripped by sanitizeHeaders, so a missing
 * claim simply means the header stays absent.
 */
async function applyIdentity(req: Request, token: string): Promise<void> {
  const key = await getPublicKey();
  const { payload } = await jwtVerify(token, key, { algorithms: ['EdDSA'] });
  const p = payload as unknown as JwtPayload;

  // Revocation: the JWT is cryptographically valid, but the session may have
  // been killed before its 15-min expiry (logout, suspend, delete, org block).
  if (await isRevoked({ sub: p.sub, org_id: p.org_id, session_id: p.session_id })) {
    throw new AuthError('Session revoked');
  }

  delete req.headers['authorization'];

  req.headers['x-user-id'] = p.sub;
  if (p.org_id !== null && p.org_id !== undefined) {
    req.headers['x-org-id'] = p.org_id;
  }
  req.headers['x-user-type'] = p.user_type;
  if (p.phone_number !== null && p.phone_number !== undefined) {
    req.headers['x-user-phone'] = p.phone_number;
  }
  if (p.name !== null && p.name !== undefined && p.name !== '') {
    req.headers['x-user-name'] = p.name;
  }
  req.headers['x-user-roles'] = JSON.stringify(p.role_slugs);
  req.headers['x-user-rules'] = JSON.stringify(p.rules);
  // X-Locale (explicit pick) > JWT claim (saved preference) > Accept-Language
  // (browser default) > 'rw'. So a mid-session switch via X-Locale takes effect
  // without re-issuing the token, but the saved preference beats the browser.
  req.headers['x-user-locale'] = selectedLocale(req) ?? p.locale ?? acceptLanguageLocale(req) ?? 'rw';
  if (p.session_id) {
    req.headers['x-session-id'] = p.session_id;
  }
}

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing authorization header' } });
    return;
  }

  try {
    await applyIdentity(req, token);
    next();
  } catch (err) {
    const message = err instanceof AuthError ? err.message : 'Invalid or expired token';
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message } });
  }
}

/**
 * Optional auth for public-but-personalisable routes (browse trips/routes/prices
 * while logged in, or anonymously). A valid token is translated into identity
 * headers so a logged-in user's mutations still work; a missing OR invalid token
 * proceeds anonymously — downstream services enforce auth on writes. Spoofed
 * identity headers were already stripped by sanitizeHeaders.
 */
export async function optionalAuthenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = extractToken(req);
  if (token) {
    try {
      await applyIdentity(req, token);
    } catch {
      // Invalid/expired/revoked token on a public route → proceed anonymously.
    }
  }
  next();
}
