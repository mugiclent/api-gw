# API Gateway — Build Specification

This document is a complete prompt for Claude Code to bootstrap the `api-gw`
microservice. Read it in full before writing any code. All decisions here are
final — do not substitute alternatives unless a constraint is explicitly marked
as flexible.

---

## What this service does

The `api-gw` is the **single entry point** for all clients (mobile and web).
It:

1. Reads a `routes.yaml` file from a **private GitHub repository** and builds
   an in-memory route table. Polls for changes every 30 s; no server restart
   is ever needed to add or modify routes.
2. For protected routes, verifies the `Authorization: Bearer <jwt>` header
   (RS256) using the public key in env. Rejects invalid or expired tokens with
   `401 UNAUTHORIZED`.
3. Strips the `Authorization` header and injects `X-User-*` identity headers
   so downstream services never touch JWTs.
4. Forwards `X-Client-Type` from the original request unchanged.
5. Reverse-proxies the request to the target container on `katisha-net`.
6. Proxies the response back as-is — never reformat or unwrap it.

The gateway does **not** implement business logic, rate limiting (each service
owns its own), or response transformation.

---

## Tech stack

| Concern | Package |
|---|---|
| Runtime | Node.js 22 + TypeScript (strict) |
| HTTP framework | Express 5 |
| Reverse proxy | `http-proxy-middleware` v3 |
| JWT verification | `jsonwebtoken` |
| YAML parsing | `js-yaml` |
| Config fetching | Node.js built-in `fetch` |
| Env validation | `joi` |
| Test runner | Vitest |
| HTTP test client | Supertest |
| Linter | ESLint (typescript-eslint) |
| Formatter | Prettier |

No Passport.js. No session middleware. No body parsing on the gateway
(requests are streamed through the proxy unchanged).

---

## Project structure

```
api-gw/
  src/
    config/
      env.ts          # Joi schema — validates process.env at startup
      index.ts        # Typed config object — never use process.env outside here
    loaders/
      configWatcher.ts  # Polls GitHub for routes.yaml; rebuilds route table
    middleware/
      authenticate.ts   # JWT verification + X-User-* header injection
      errorHandler.ts   # Maps errors → platform error shape
    routes/
      index.ts          # Mounts proxy routes from the in-memory route table
      health.ts         # GET /health → { status: 'ok' }
      jwks.ts           # GET /.well-known/jwks.json → proxy to user-service
    utils/
      routeTable.ts     # In-memory route table with getter/setter
      logger.ts         # console.warn / console.error wrapper
    app.ts              # Express app factory (no listen call)
    index.ts            # process listen + graceful shutdown
  tests/
    unit/
      authenticate.test.ts
      configWatcher.test.ts
    integration/
      proxy.test.ts
  skills/               # Copy from user-service/skills/ (see CLAUDE.md)
  docs/
  Dockerfile
  docker-compose.yml
  eslint.config.mjs
  tsconfig.json
  tsconfig.eslint.json
  vitest.config.ts
  .env.example
```

---

## Environment variables

Validate every variable with Joi at startup. Crash immediately if any
required variable is missing or invalid — do not start with a broken config.

```
NODE_ENV            string    "development" | "production" | "test"
PORT                number    Default 3000

# JWT
JWT_PUBLIC_KEY      string    PEM-format RS256 public key, stored with literal \n
                              (same key the user-service signs with)

# Config repo
CONFIG_REPO_URL     string    Full raw GitHub URL to routes.yaml in the private repo.
                              Format: https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}
                              Example: https://raw.githubusercontent.com/acme/katisha-config/main/api-gw/routes.yaml
CONFIG_REPO_TOKEN   string    GitHub Personal Access Token with Contents: Read on the config repo.
                              Fine-grained PAT recommended over classic PAT.
CONFIG_POLL_INTERVAL_MS  number  Default 30000 (30 s). How often to poll for config changes.

# User service (for JWKS proxy)
USER_SERVICE_URL    string    Internal Docker URL. Example: http://katisha-user-service:3001
```

### How to get `CONFIG_REPO_TOKEN`

1. Go to GitHub → Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token.
2. Set **Resource owner** to the account/org that owns the config repo.
3. Under **Repository access** select only the config repo.
4. Under **Permissions → Repository permissions** set **Contents** to `Read-only`.
5. No other permissions needed.
6. Copy the token (starts with `github_pat_`) and add it to `.env` as
   `CONFIG_REPO_TOKEN`.

---

## `routes.yaml` schema

The gateway loads this file from the private config repo. Define every route
the platform exposes here.

```yaml
# api-gw/routes.yaml  (lives in the config repo, not this repo)

routes:
  - path: /api/v1/auth        # matched as prefix — all sub-paths included
    target: http://katisha-user-service:3001
    auth: false               # no JWT required (login, register, refresh, logout)

  - path: /api/v1/users
    target: http://katisha-user-service:3001
    auth: true

  - path: /api/v1/organizations
    target: http://katisha-user-service:3001
    auth: true

  - path: /api/v1/invitations
    target: http://katisha-user-service:3001
    auth: true
```

Rules:
- `path` is a **prefix match**. `/api/v1/users` matches `/api/v1/users`,
  `/api/v1/users/123`, `/api/v1/users/me`, etc.
- Routes are evaluated in order; first match wins.
- `auth: false` routes are proxied without JWT verification.
- `auth: true` routes go through the `authenticate` middleware first.

---

## Config hot-reload (polling GitHub)

### File: `src/loaders/configWatcher.ts`

At startup and every `CONFIG_POLL_INTERVAL_MS` milliseconds:

1. Fetch `CONFIG_REPO_URL` with header `Authorization: token ${CONFIG_REPO_TOKEN}`.
2. Compute a SHA-256 hash of the response body.
3. If the hash matches the last known hash, do nothing.
4. If different (or first load), parse the YAML, validate the schema, update
   the in-memory route table via `routeTable.set(routes)`.
5. Log `console.warn('[config-watcher] routes reloaded — N routes active')`.
6. On HTTP error (non-200) or parse error: log `console.error(...)` and keep
   the last known routes. Never crash; never serve zero routes.

No `fs.watch`. No local file. No `POST /_internal/reload` endpoint.

The poll interval governs maximum staleness. A 30 s default means a config
push propagates to all running api-gw containers within 30 s with no
deployment.

### Startup behaviour

The watcher must load routes **before** the HTTP server starts accepting
connections. Use `await configWatcher.init()` in `index.ts` before
`app.listen()`. If the initial fetch fails (GitHub unreachable), crash with a
clear error — do not start the server with an empty route table.

---

## In-memory route table

### File: `src/utils/routeTable.ts`

```typescript
interface Route {
  path: string;    // prefix, e.g. "/api/v1/users"
  target: string;  // e.g. "http://katisha-user-service:3001"
  auth: boolean;
}

let routes: Route[] = [];

export const routeTable = {
  set: (r: Route[]) => { routes = r; },
  get: (): Route[]  => routes,
  match: (reqPath: string): Route | undefined =>
    routes.find((r) => reqPath === r.path || reqPath.startsWith(r.path + '/')),
};
```

`match` is called on every request. The proxy middleware reads from
`routeTable.match(req.path)` so it always uses the current in-memory state —
no restart needed.

---

## Authentication middleware

### File: `src/middleware/authenticate.ts`

Called only on routes where `auth: true`.

1. Read `Authorization` header. If missing → `401 UNAUTHORIZED`.
2. Extract Bearer token. If malformed → `401 UNAUTHORIZED`.
3. Verify with `jsonwebtoken.verify(token, config.jwt.publicKey, { algorithms: ['RS256'] })`.
   On any error (`JsonWebTokenError`, `TokenExpiredError`, etc.) → `401 UNAUTHORIZED`.
4. Cast payload to `JwtPayload` (typed interface below).
5. Strip the `Authorization` header: `delete req.headers['authorization']`.
6. Inject identity headers:

```typescript
req.headers['x-user-id']    = payload.sub;
req.headers['x-org-id']     = payload.org_id ?? undefined;  // omit entirely for null
req.headers['x-user-type']  = payload.user_type;
req.headers['x-user-roles'] = JSON.stringify(payload.role_slugs);
req.headers['x-user-rules'] = JSON.stringify(payload.rules);
```

**Header names are case-sensitive.** Use exactly: `x-user-id`, `x-org-id`,
`x-user-type`, `x-user-roles`, `x-user-rules`. Express lowercases incoming
headers but outgoing headers set on `req.headers` are forwarded as-is by
`http-proxy-middleware`.

7. Call `next()`.

### `JwtPayload` interface

```typescript
import type { PackRule } from '@casl/ability/extra';

interface JwtPayload {
  sub: string;
  org_id: string | null;
  user_type: 'passenger' | 'staff';
  role_slugs: string[];
  rules: PackRule<unknown>[];
  iat: number;
  exp: number;
}
```

---

## Proxy middleware

### File: `src/routes/index.ts`

Use a **single** `http-proxy-middleware` instance per matched route. Build
proxy instances lazily (cache by target URL) and reuse them.

```typescript
import { createProxyMiddleware } from 'http-proxy-middleware';

const proxyCache = new Map<string, RequestHandler>();

function getProxy(target: string): RequestHandler {
  if (!proxyCache.has(target)) {
    proxyCache.set(target, createProxyMiddleware({
      target,
      changeOrigin: true,
      on: {
        error: (err, _req, res) => {
          // downstream unreachable
          (res as Response).status(502).json({
            error: { code: 'BAD_GATEWAY', message: 'Upstream service unavailable' },
          });
        },
      },
    }));
  }
  return proxyCache.get(target)!;
}
```

The router middleware:

```typescript
app.use((req, res, next) => {
  const route = routeTable.match(req.path);
  if (!route) {
    return res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
  }
  if (route.auth) {
    return authenticate(req, res, () => getProxy(route.target)(req, res, next));
  }
  return getProxy(route.target)(req, res, next);
});
```

**Never reformat upstream responses.** Proxy them through verbatim. The
platform error shape contract is enforced by each downstream service.

---

## Special routes (always registered, not in routes.yaml)

### `GET /health`
Returns `200 { "status": "ok", "routes": N }` where N is the number of routes
currently loaded. Used by Docker healthcheck and load balancer.

### `GET /.well-known/jwks.json`
Proxied to `${USER_SERVICE_URL}/.well-known/jwks.json`. No auth required.
This endpoint allows any other microservice that needs to verify JWTs to
fetch the RS256 public key as a JWK Set.

Both routes are registered **before** the dynamic proxy middleware so they
are never shadowed by a routes.yaml entry.

---

## Error response shape

All errors produced **by the gateway itself** (not proxied from upstream) must
follow the platform shape:

```json
{ "error": { "code": "SCREAMING_SNAKE_CASE", "message": "Human readable" } }
```

Error codes the gateway produces:

| Situation | HTTP | Code |
|---|---|---|
| No `Authorization` header | 401 | `UNAUTHORIZED` |
| Malformed / invalid / expired JWT | 401 | `UNAUTHORIZED` |
| No route matched | 404 | `NOT_FOUND` |
| Upstream unreachable | 502 | `BAD_GATEWAY` |
| Unhandled exception | 500 | `INTERNAL_SERVER_ERROR` |

Upstream error responses (4xx/5xx from downstream services) are proxied
as-is — the gateway never touches them.

---

## `X-Client-Type` forwarding

The gateway forwards this header from the client request to the upstream
service unchanged. Never strip, override, or add it. Downstream services use
it to decide whether to return tokens in the body (mobile) or set cookies
(web).

---

## Dockerfile

Follow the same multi-stage pattern as `user-service`:

- Stage 1 (`builder`): `node:22-bookworm-slim` — `npm ci`, `tsc`, `npm prune --omit=dev`
- Stage 2 (production): `gcr.io/distroless/nodejs22-debian12`
- `CMD ["dist/index.js"]` (distroless nodejs has node as entrypoint — do not write `node dist/index.js`)
- `EXPOSE 3000`
- No argon2 native addons here, so no python3/make/g++ needed in builder

---

## `docker-compose.yml`

```yaml
services:
  api-gw:
    image: ${DOCKER_USERNAME}/katisha-api-gw:${IMAGE_TAG:-latest}
    container_name: katisha-api-gw
    restart: unless-stopped
    ports:
      - "3000:3000"        # api-gw is the ONLY service with a public port
    environment:
      NODE_ENV: ${NODE_ENV}
      PORT: ${PORT}
      JWT_PUBLIC_KEY: ${JWT_PUBLIC_KEY}
      CONFIG_REPO_URL: ${CONFIG_REPO_URL}
      CONFIG_REPO_TOKEN: ${CONFIG_REPO_TOKEN}
      CONFIG_POLL_INTERVAL_MS: ${CONFIG_POLL_INTERVAL_MS}
      USER_SERVICE_URL: ${USER_SERVICE_URL}
    networks:
      - katisha-net

networks:
  katisha-net:
    external: true
```

The api-gw is the **only** service in the platform that exposes a public port.
All other services (user-service, etc.) have no `ports:` section and are
reachable only via `katisha-net` by container name.

---

## CI/CD pipeline (`.github/workflows/ci-cd.yml`)

Three jobs — same structure as `user-service`:

```
checks    → build-and-push → deploy
```

- `checks`: `npx tsc --noEmit`, `npx eslint src/ tests/`, `npx vitest run`
- `build-and-push`: Docker build, push SHA tag + `latest` tag to Docker Hub
- `deploy`: SSH to server → `sed -i IMAGE_TAG .env` → `docker compose pull` →
  `docker compose up -d --no-deps api-gw`

No Prisma generate step (no database in this service).

---

## Tests

### Unit — `tests/unit/authenticate.test.ts`
- Verify valid JWT → headers injected, `next()` called
- Verify missing `Authorization` → 401
- Verify malformed Bearer → 401
- Verify expired JWT → 401
- Verify `org_id: null` → `x-org-id` header is omitted (not set to `"null"`)

### Unit — `tests/unit/configWatcher.test.ts`
- First fetch succeeds → route table populated, server starts
- Fetch returns same hash → route table not updated (no unnecessary rebuilds)
- Fetch returns new hash → route table updated
- Fetch returns non-200 → error logged, previous routes kept
- Fetch throws network error → error logged, previous routes kept

### Integration — `tests/integration/proxy.test.ts`
- `auth: false` route → request proxied without JWT check
- `auth: true` route with valid JWT → headers injected, request proxied
- `auth: true` route without JWT → 401 before reaching upstream
- Unknown path → 404 `NOT_FOUND`
- `GET /health` → 200 `{ status: 'ok' }`

Mock `http-proxy-middleware` in integration tests — do not make real upstream
calls.

---

## ESLint + TypeScript

Follow `skills/LINT.md` exactly:
- `tsconfig.json` covers `src/` only (`"exclude": ["tests"]`, `"rootDir": "src"`)
- `tsconfig.eslint.json` extends it, overrides `exclude` (removes `"tests"`)
  and sets `"rootDir": "."` so ESLint can parse test files
- Two config blocks in `eslint.config.mjs`: `src/**` → `tsconfig.json`,
  `tests/**` → `tsconfig.eslint.json`
- Rules: `no-unused-vars`, `no-explicit-any`, `consistent-type-imports`,
  `no-require-imports`, `no-console` (allow warn/error)

---

## Platform contracts (non-negotiable)

All of the following are hard constraints from `CLAUDE.md` at the repo root.
Violating any of them breaks other services silently.

- Service name in event envelopes: `"api-gw"`
- Port: `3000` (already in the platform port registry — do not change)
- Header names injected downstream: exactly `x-user-id`, `x-org-id`,
  `x-user-type`, `x-user-roles`, `x-user-rules` (Express lowercases them)
- Error response shape: `{ "error": { "code": "...", "message": "..." } }`
- `X-Client-Type` forwarded unchanged
- No JWT verification in any downstream service — only the api-gw does this
- All containers on `katisha-net`, reached by container name
- No new RabbitMQ exchanges (api-gw does not publish to RabbitMQ directly)

---

## Implementation order

1. `src/config/env.ts` + `src/config/index.ts` — Joi validation, typed config
2. `src/utils/routeTable.ts` — in-memory route table
3. `src/loaders/configWatcher.ts` — GitHub polling, initial load
4. `src/middleware/authenticate.ts` — JWT verification + header injection
5. `src/routes/health.ts` + `src/routes/jwks.ts` — static routes
6. `src/routes/index.ts` — dynamic proxy router
7. `src/app.ts` + `src/index.ts` — assemble and start
8. `Dockerfile` + `docker-compose.yml`
9. `.github/workflows/ci-cd.yml`
10. Tests
11. `npx tsc --noEmit` + `npx eslint src/ tests/` — zero errors before committing
