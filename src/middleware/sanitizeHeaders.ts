import type { Request, Response, NextFunction } from 'express';

/**
 * The trusted identity headers (`x-user-*`, `x-org-id`, `x-session-id`) are set
 * ONLY by the gateway from a cryptographically verified JWT. Downstream services
 * trust them implicitly. Strip any a client tries to inject so that public and
 * optional-auth routes — which may skip JWT verification — can never be spoofed
 * into impersonating a user or org.
 *
 * `x-user-locale` is intentionally omitted: it is re-derived from trusted sources
 * by localeResolver, which already deletes the inbound value.
 */
const SPOOFABLE_IDENTITY_HEADERS = [
  'x-user-id',
  'x-org-id',
  'x-user-type',
  'x-user-roles',
  'x-user-rules',
  'x-session-id',
];

export const sanitizeHeaders = (req: Request, _res: Response, next: NextFunction): void => {
  for (const header of SPOOFABLE_IDENTITY_HEADERS) {
    delete req.headers[header];
  }
  next();
};
