import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// ── Mock jose BEFORE importing authenticate ───────────────────────────────────
const mockJwtVerify = vi.fn();
const mockImportSPKI = vi.fn().mockResolvedValue('mock-public-key');

vi.mock('jose', () => ({
  jwtVerify: mockJwtVerify,
  importSPKI: mockImportSPKI,
}));

vi.mock('../../src/config/index.js', () => ({
  config: {
    jwt: { publicKey: 'test-public-key' },
  },
}));

// Import after mocks
const { authenticate } = await import('../../src/middleware/authenticate.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    cookies: {},
    ...overrides,
  } as unknown as Request;
}

function makeRes(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const res = { status } as unknown as Response;
  return { res, status, json };
}

const validPayload = {
  sub: 'user-uuid-123',
  org_id: 'org-uuid-456',
  user_type: 'staff' as const,
  phone_number: '+250788123456',
  name: 'Aline Uwase',
  role_slugs: ['admin'],
  rules: [],
  locale: 'rw',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 900,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => vi.clearAllMocks());

describe('authenticate middleware', () => {
  it('valid JWT → strips Authorization, injects X-User-* headers, calls next()', async () => {
    mockJwtVerify.mockResolvedValueOnce({ payload: validPayload });
    const req = makeReq({ headers: { authorization: 'Bearer valid-token' } });
    const { res } = makeRes();
    const next: NextFunction = vi.fn();

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.headers['authorization']).toBeUndefined();
    expect(req.headers['x-user-id']).toBe(validPayload.sub);
    expect(req.headers['x-org-id']).toBe(validPayload.org_id);
    expect(req.headers['x-user-type']).toBe(validPayload.user_type);
    expect(req.headers['x-user-phone']).toBe(validPayload.phone_number);
    expect(req.headers['x-user-name']).toBe(validPayload.name);
    expect(req.headers['x-user-roles']).toBe(JSON.stringify(validPayload.role_slugs));
    expect(req.headers['x-user-rules']).toBe(JSON.stringify(validPayload.rules));
    expect(req.headers['x-user-locale']).toBe('rw');
  });

  it('access_token cookie used as fallback when no Authorization header', async () => {
    mockJwtVerify.mockResolvedValueOnce({ payload: validPayload });
    const req = makeReq({ headers: {}, cookies: { access_token: 'cookie-token' } });
    const { res } = makeRes();
    const next: NextFunction = vi.fn();

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.headers['x-user-id']).toBe(validPayload.sub);
  });

  it('missing Authorization header and no cookie → 401 UNAUTHORIZED', async () => {
    const req = makeReq({ headers: {}, cookies: {} });
    const { res, status, json } = makeRes();
    const next: NextFunction = vi.fn();

    await authenticate(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: { code: 'UNAUTHORIZED', message: expect.any(String) } });
  });

  it('expired JWT (verify throws) → 401 UNAUTHORIZED', async () => {
    mockJwtVerify.mockRejectedValueOnce(new Error('jwt expired'));
    const req = makeReq({ headers: { authorization: 'Bearer expired-token' } });
    const { res, status, json } = makeRes();
    const next: NextFunction = vi.fn();

    await authenticate(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: { code: 'UNAUTHORIZED', message: expect.any(String) } });
  });

  it('invalid JWT (verify throws) → 401 UNAUTHORIZED', async () => {
    mockJwtVerify.mockRejectedValueOnce(new Error('invalid signature'));
    const req = makeReq({ headers: { authorization: 'Bearer bad-token' } });
    const { res, status } = makeRes();
    const next: NextFunction = vi.fn();

    await authenticate(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  it('org_id: null → x-org-id header is omitted (not set to "null")', async () => {
    mockJwtVerify.mockResolvedValueOnce({ payload: { ...validPayload, org_id: null } });
    const req = makeReq({ headers: { authorization: 'Bearer valid-token' } });
    const { res } = makeRes();
    const next: NextFunction = vi.fn();

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.headers['x-org-id']).toBeUndefined();
  });

  it('phone_number: null → x-user-phone header is omitted (not set to "null")', async () => {
    mockJwtVerify.mockResolvedValueOnce({ payload: { ...validPayload, phone_number: null } });
    const req = makeReq({ headers: { authorization: 'Bearer valid-token' } });
    const { res } = makeRes();
    const next: NextFunction = vi.fn();

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.headers['x-user-phone']).toBeUndefined();
  });

  it('empty name → x-user-name header is omitted (not set to "")', async () => {
    mockJwtVerify.mockResolvedValueOnce({ payload: { ...validPayload, name: '' } });
    const req = makeReq({ headers: { authorization: 'Bearer valid-token' } });
    const { res } = makeRes();
    const next: NextFunction = vi.fn();

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.headers['x-user-name']).toBeUndefined();
  });
});
