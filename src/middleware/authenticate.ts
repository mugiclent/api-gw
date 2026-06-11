import { jwtVerify, importSPKI } from 'jose';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config/index.js';
import { isRevoked } from '../loaders/redis.js';
import { selectedLocale, acceptLanguageLocale } from './locale.js';

interface JwtPayload {
  sub: string;
  org_id: string | null;
  user_type: 'passenger' | 'staff';
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

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Prefer Authorization: Bearer header; fall back to access_token cookie (web clients)
  let token: string | undefined;

  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (req.cookies?.access_token) {
    token = req.cookies.access_token as string;
  }

  if (!token) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing authorization header' } });
    return;
  }

  try {
    const key = await getPublicKey();
    const { payload } = await jwtVerify(token, key, { algorithms: ['EdDSA'] });
    const p = payload as unknown as JwtPayload;

    // Revocation: the JWT is cryptographically valid, but the session may have
    // been killed before its 15-min expiry (logout, suspend, delete, org block).
    if (await isRevoked({ sub: p.sub, org_id: p.org_id, session_id: p.session_id })) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Session revoked' } });
      return;
    }

    delete req.headers['authorization'];

    req.headers['x-user-id'] = p.sub;
    if (p.org_id !== null && p.org_id !== undefined) {
      req.headers['x-org-id'] = p.org_id;
    } else {
      delete req.headers['x-org-id'];
    }
    req.headers['x-user-type'] = p.user_type;
    req.headers['x-user-roles'] = JSON.stringify(p.role_slugs);
    req.headers['x-user-rules'] = JSON.stringify(p.rules);
    // X-Locale (explicit pick) > JWT claim (saved preference) > Accept-Language
    // (browser default) > 'rw'. So a mid-session switch via X-Locale takes effect
    // without re-issuing the token, but the saved preference beats the browser.
    req.headers['x-user-locale'] = selectedLocale(req) ?? p.locale ?? acceptLanguageLocale(req) ?? 'rw';
    if (p.session_id) {
      req.headers['x-session-id'] = p.session_id;
    } else {
      delete req.headers['x-session-id'];
    }

    next();
  } catch {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
  }
}
