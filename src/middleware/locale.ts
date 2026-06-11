import type { Request, Response, NextFunction } from 'express';

/**
 * Locale resolution for the trusted `x-user-locale` header that services read
 * (and propagate to async work like notifications).
 *
 * Precedence (highest first):
 *   1. `X-Locale` request header — the language the user explicitly picked in the UI.
 *      Wins even for logged-in users, so a mid-session switch takes effect without
 *      re-issuing the JWT.
 *   2. JWT `locale` claim — the logged-in user's saved preference (applied in authenticate.ts).
 *   3. `Accept-Language` — the browser's default, used only when nothing above applies
 *      (e.g. an anonymous visitor who never picked a language).
 *   4. Service default ('rw').
 *
 * Anti-spoof: clients may NOT set the trusted `x-user-locale` directly — it is
 * stripped on every request and only ever set by the gateway.
 */
export const SUPPORTED_LOCALES = ['rw', 'en', 'fr'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

const isSupported = (v: string): v is SupportedLocale =>
  (SUPPORTED_LOCALES as readonly string[]).includes(v);

/** The user's explicit UI selection (`X-Locale`), validated — or undefined. */
export const selectedLocale = (req: Request): SupportedLocale | undefined => {
  const header = req.headers['x-locale'];
  const picked = (Array.isArray(header) ? header[0] : header)?.trim().toLowerCase();
  return picked && isSupported(picked) ? picked : undefined;
};

/** First supported tag in `Accept-Language` (e.g. "fr-RW,fr;q=0.9,en") — or undefined. */
export const acceptLanguageLocale = (req: Request): SupportedLocale | undefined => {
  const accept = req.headers['accept-language'];
  if (typeof accept !== 'string') return undefined;
  for (const part of accept.split(',')) {
    const tag = part.split(';')[0]?.trim().slice(0, 2).toLowerCase();
    if (tag && isSupported(tag)) return tag;
  }
  return undefined;
};

/**
 * Runs for every proxied request (authenticated or not), before authenticate.
 * Strips any client-supplied trusted header, then sets it from the explicit pick,
 * else the browser default. For authenticated requests, authenticate.ts re-resolves
 * with the JWT claim slotted between the two (X-Locale > JWT > Accept-Language).
 */
export const localeResolver = (req: Request, _res: Response, next: NextFunction): void => {
  delete req.headers['x-user-locale'];
  const loc = selectedLocale(req) ?? acceptLanguageLocale(req);
  if (loc) req.headers['x-user-locale'] = loc;
  next();
};
