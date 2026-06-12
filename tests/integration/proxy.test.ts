import { vi, describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';

// ── Mock http-proxy-middleware — no real upstream calls ───────────────────────
const { mockProxyHandler } = vi.hoisted(() => {
  const mockProxyHandler = vi.fn((_req: Request, res: Response, _next: NextFunction) => {
    res.status(200).json({ proxied: true });
  });
  return { mockProxyHandler };
});

vi.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: vi.fn(() => mockProxyHandler),
}));

// ── Mock config so env validation is skipped ─────────────────────────────────
vi.mock('../../src/config/index.js', () => ({
  config: {
    jwt: { publicKey: 'test-public-key' },
    userService: { url: 'http://katisha-user-service:3001' },
    cors: { origins: ['http://localhost:3000'] },
  },
}));

// ── Mock jose ─────────────────────────────────────────────────────────────────
const { mockJwtVerify } = vi.hoisted(() => {
  const mockJwtVerify = vi.fn();
  return { mockJwtVerify };
});

vi.mock('jose', () => ({
  jwtVerify: mockJwtVerify,
  importSPKI: vi.fn().mockResolvedValue('mock-public-key'),
}));

// ── Seed route table with known routes ────────────────────────────────────────
import { routeTable } from '../../src/utils/routeTable.js';
import type { Route } from '../../src/utils/routeTable.js';
import { createApp } from '../../src/app.js';

const testRoutes: Route[] = [
  { path: '/api/v1/auth', target: 'http://katisha-user-service:3001', auth: false },
  { path: '/api/v1/users', target: 'http://katisha-user-service:3001', auth: true },
  { path: '/api/v1/prices', target: 'http://trip-svc:8092', auth: 'optional' },
];

const validJwtPayload = {
  sub: 'user-uuid-123',
  org_id: 'org-uuid-456',
  user_type: 'staff',
  role_slugs: ['admin'],
  rules: [],
  locale: 'rw',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 900,
};

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  routeTable.set(testRoutes);
  app = createApp();
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 { status: "ok", routes: N }', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', routes: testRoutes.length });
  });
});

describe('proxy routing', () => {
  it('auth: false route → request proxied without JWT check', async () => {
    mockProxyHandler.mockImplementationOnce((_req, res) => {
      res.status(200).json({ proxied: true });
    });

    const res = await request(app).post('/api/v1/auth/login').send({ foo: 'bar' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ proxied: true });
    expect(mockJwtVerify).not.toHaveBeenCalled();
  });

  it('auth: true route with valid JWT → headers injected, request proxied', async () => {
    mockJwtVerify.mockResolvedValueOnce({ payload: validJwtPayload });
    mockProxyHandler.mockImplementationOnce((req: Request, res: Response) => {
      res.status(200).json({
        proxied: true,
        userId: req.headers['x-user-id'],
        orgId: req.headers['x-org-id'],
      });
    });

    const res = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body.proxied).toBe(true);
    expect(res.body.userId).toBe(validJwtPayload.sub);
    expect(res.body.orgId).toBe(validJwtPayload.org_id);
  });

  it('auth: true route without JWT → 401 before reaching upstream', async () => {
    const res = await request(app).get('/api/v1/users/me');

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    expect(mockProxyHandler).not.toHaveBeenCalled();
  });

  it('unknown path → 404 NOT_FOUND', async () => {
    const res = await request(app).get('/unknown/path');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('auth: optional route without JWT → proxied anonymously (no identity headers)', async () => {
    mockProxyHandler.mockImplementationOnce((req: Request, res: Response) => {
      res.status(200).json({ proxied: true, userId: req.headers['x-user-id'] ?? null });
    });

    const res = await request(app).get('/api/v1/prices');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ proxied: true, userId: null });
    expect(mockJwtVerify).not.toHaveBeenCalled();
  });

  it('auth: optional route with valid JWT → identity headers injected', async () => {
    mockJwtVerify.mockResolvedValueOnce({ payload: validJwtPayload });
    mockProxyHandler.mockImplementationOnce((req: Request, res: Response) => {
      res.status(200).json({ userId: req.headers['x-user-id'], orgId: req.headers['x-org-id'] });
    });

    const res = await request(app).get('/api/v1/prices').set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(validJwtPayload.sub);
    expect(res.body.orgId).toBe(validJwtPayload.org_id);
  });

  it('auth: optional route with invalid JWT → proceeds anonymously (no 401)', async () => {
    mockJwtVerify.mockRejectedValueOnce(new Error('bad token'));
    mockProxyHandler.mockImplementationOnce((req: Request, res: Response) => {
      res.status(200).json({ proxied: true, userId: req.headers['x-user-id'] ?? null });
    });

    const res = await request(app).get('/api/v1/prices').set('Authorization', 'Bearer garbage');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ proxied: true, userId: null });
  });

  it('strips spoofed identity headers from a public/anonymous request', async () => {
    mockProxyHandler.mockImplementationOnce((req: Request, res: Response) => {
      res.status(200).json({
        userId: req.headers['x-user-id'] ?? null,
        orgId: req.headers['x-org-id'] ?? null,
        rules: req.headers['x-user-rules'] ?? null,
      });
    });

    const res = await request(app)
      .get('/api/v1/prices')
      .set('X-User-Id', 'attacker')
      .set('X-Org-Id', 'victim-org')
      .set('X-User-Rules', JSON.stringify([{ action: 'manage', subject: 'all' }]));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userId: null, orgId: null, rules: null });
  });

  it('X-Client-Type forwarded unchanged on auth: false route', async () => {
    mockProxyHandler.mockImplementationOnce((req: Request, res: Response) => {
      res.status(200).json({ clientType: req.headers['x-client-type'] });
    });

    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('X-Client-Type', 'mobile');

    expect(res.status).toBe(200);
    expect(res.body.clientType).toBe('mobile');
  });
});
