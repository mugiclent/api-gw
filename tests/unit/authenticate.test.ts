import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// ── Mock jsonwebtoken BEFORE importing authenticate ──────────────────────────
const mockVerify = vi.fn();
vi.mock('jsonwebtoken', () => ({
  default: { verify: mockVerify },
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
  role_slugs: ['admin'],
  rules: [],
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 900,
};

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => vi.clearAllMocks());

describe('authenticate middleware', () => {
  it('valid JWT → strips Authorization, injects X-User-* headers, calls next()', () => {
    mockVerify.mockReturnValueOnce(validPayload);
    const req = makeReq({ headers: { authorization: 'Bearer valid-token' } });
    const { res } = makeRes();
    const next: NextFunction = vi.fn();

    authenticate(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.headers['authorization']).toBeUndefined();
    expect(req.headers['x-user-id']).toBe(validPayload.sub);
    expect(req.headers['x-org-id']).toBe(validPayload.org_id);
    expect(req.headers['x-user-type']).toBe(validPayload.user_type);
    expect(req.headers['x-user-roles']).toBe(JSON.stringify(validPayload.role_slugs));
    expect(req.headers['x-user-rules']).toBe(JSON.stringify(validPayload.rules));
  });

  it('missing Authorization header → 401 UNAUTHORIZED', () => {
    const req = makeReq({ headers: {} });
    const { res, status, json } = makeRes();
    const next: NextFunction = vi.fn();

    authenticate(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: { code: 'UNAUTHORIZED', message: expect.any(String) } });
  });

  it('malformed Bearer (no token part) → 401 UNAUTHORIZED', () => {
    const req = makeReq({ headers: { authorization: 'Bearer' } });
    const { res, status, json } = makeRes();
    const next: NextFunction = vi.fn();

    authenticate(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: { code: 'UNAUTHORIZED', message: expect.any(String) } });
  });

  it('non-Bearer scheme → 401 UNAUTHORIZED', () => {
    const req = makeReq({ headers: { authorization: 'Basic dXNlcjpwYXNz' } });
    const { res, status, json } = makeRes();
    const next: NextFunction = vi.fn();

    authenticate(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: { code: 'UNAUTHORIZED', message: expect.any(String) } });
  });

  it('expired JWT (verify throws TokenExpiredError) → 401 UNAUTHORIZED', () => {
    mockVerify.mockImplementationOnce(() => {
      const err = new Error('jwt expired');
      err.name = 'TokenExpiredError';
      throw err;
    });
    const req = makeReq({ headers: { authorization: 'Bearer expired-token' } });
    const { res, status, json } = makeRes();
    const next: NextFunction = vi.fn();

    authenticate(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: { code: 'UNAUTHORIZED', message: expect.any(String) } });
  });

  it('invalid JWT (verify throws JsonWebTokenError) → 401 UNAUTHORIZED', () => {
    mockVerify.mockImplementationOnce(() => {
      const err = new Error('invalid signature');
      err.name = 'JsonWebTokenError';
      throw err;
    });
    const req = makeReq({ headers: { authorization: 'Bearer bad-token' } });
    const { res, status } = makeRes();
    const next: NextFunction = vi.fn();

    authenticate(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  it('org_id: null → x-org-id header is omitted (not set to "null")', () => {
    mockVerify.mockReturnValueOnce({ ...validPayload, org_id: null });
    const req = makeReq({ headers: { authorization: 'Bearer valid-token' } });
    const { res } = makeRes();
    const next: NextFunction = vi.fn();

    authenticate(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.headers['x-org-id']).toBeUndefined();
  });
});
