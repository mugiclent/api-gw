import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config/index.js';

// The gateway forwards rules as opaque JSON — no need to unpack them
interface JwtPayload {
  sub: string;
  org_id: string | null;
  user_type: 'passenger' | 'staff';
  role_slugs: string[];
  rules: unknown[];
  iat: number;
  exp: number;
}

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing authorization header' } });
    return;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer' || !parts[1]) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid authorization format' } });
    return;
  }

  const token = parts[1];

  try {
    const payload = jwt.verify(token, config.jwt.publicKey, { algorithms: ['RS256'] }) as JwtPayload;

    delete req.headers['authorization'];

    req.headers['x-user-id'] = payload.sub;
    if (payload.org_id !== null) {
      req.headers['x-org-id'] = payload.org_id;
    } else {
      delete req.headers['x-org-id'];
    }
    req.headers['x-user-type'] = payload.user_type;
    req.headers['x-user-roles'] = JSON.stringify(payload.role_slugs);
    req.headers['x-user-rules'] = JSON.stringify(payload.rules);

    next();
  } catch {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
  }
}
