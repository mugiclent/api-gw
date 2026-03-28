# katisha-api-gw

The single entry point for all Katisha clients (mobile and web). It authenticates
requests, injects identity headers, and reverse-proxies traffic to downstream
services — with zero business logic of its own.

---

## What it does

1. **Route table** — reads a `routes.yaml` from a private GitHub repository and
   builds an in-memory route table. Polls for changes every 30 s; no restart ever
   needed to add or modify routes.
2. **JWT verification** — for protected routes, verifies `Authorization: Bearer
   <jwt>` (RS256) using the configured public key. Rejects invalid or expired
   tokens with `401 UNAUTHORIZED`.
3. **Header injection** — strips `Authorization` and injects `X-User-*` identity
   headers so downstream services never touch JWTs.
4. **Transparent proxy** — forwards requests and responses verbatim via
   `http-proxy-middleware`. Never reformats upstream responses.

---

## Static endpoints

These are always registered regardless of `routes.yaml`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | None | Returns `{ "status": "ok", "routes": N }`. Used by Docker healthcheck and nginx upstream health checks. |
| `GET` | `/.well-known/jwks.json` | None | Proxied to `USER_SERVICE_URL`. Lets other services fetch the RS256 public key as a JWK Set. |

---

## Environment variables

Copy `.env.example` to `.env` and fill in every value before running locally.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | Yes | — | `development` \| `production` \| `test` |
| `PORT` | No | `3000` | Port the HTTP server listens on |
| `JWT_PUBLIC_KEY` | Yes | — | PEM RS256 public key (single-line, literal `\n`). Must match the private key used by user-service to sign tokens. |
| `CONFIG_REPO_URL` | Yes | — | Raw GitHub URL to `routes.yaml` in the private config repo. Format: `https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}` |
| `CONFIG_REPO_TOKEN` | Yes | — | GitHub fine-grained PAT with **Contents: Read** on the config repo (starts with `github_pat_`). See below for how to create one. |
| `CONFIG_POLL_INTERVAL_MS` | No | `30000` | How often (ms) to poll GitHub for config changes. |
| `USER_SERVICE_URL` | Yes | — | Internal Docker URL of the user-service, e.g. `http://katisha-user-service:3001` |

### Getting JWT_PUBLIC_KEY

The api-gw uses the **public** half of the RS256 key pair that user-service signs
tokens with. Copy it from user-service's `.env` (`JWT_PUBLIC_KEY`). It is safe to
share — it can only verify tokens, never sign them.

Store it as a single line with literal `\n`:

```bash
JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq...\n-----END PUBLIC KEY-----"
```

### Getting CONFIG_REPO_TOKEN

1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → **Generate new token**
2. **Resource owner**: the account/org that owns the config repo
3. **Repository access**: select only the config repo
4. **Permissions → Repository permissions → Contents**: `Read-only`
5. No other permissions needed
6. Copy the token (starts with `github_pat_`) → add to `.env` as `CONFIG_REPO_TOKEN`

---

## routes.yaml

The gateway loads this file from your private config repo at the path set in
`CONFIG_REPO_URL`. It defines every route the platform exposes.

```yaml
# Example: api-gw/routes.yaml  (lives in the config repo, not this repo)

routes:
  - path: /api/v1/auth        # prefix match — covers /login, /register, /refresh, etc.
    target: http://katisha-user-service:3001
    auth: false               # no JWT required

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

### Rules

- **`path`** is a prefix match. `/api/v1/users` matches `/api/v1/users`,
  `/api/v1/users/me`, `/api/v1/users/123`, etc.
- **First match wins** — order matters. Put more-specific paths before broader
  ones if they overlap.
- **`auth: false`** — proxied directly with no JWT check. Use for login,
  register, token refresh, and logout (anything a client hits before they have a
  token).
- **`auth: true`** — JWT is verified first, `Authorization` is stripped, and
  `X-User-*` headers are injected before proxying.
- **`target`** — must be a container name on `katisha-net` (never an IP). The
  full request path is forwarded unchanged.
- **Do not add** `/health` or `/.well-known/jwks.json` — those are registered
  statically and can never be shadowed by this file.

### Hot-reload

Push a change to `routes.yaml` in the config repo. The api-gw polls on the
configured interval and picks it up automatically — no deployment needed. A
SHA-256 hash of the file prevents unnecessary rebuilds when the content has not
changed.

---

## Authentication contract

When a request hits a route with `auth: true`:

1. `Authorization: Bearer <jwt>` header is required. Missing or malformed → `401`.
2. Token is verified with RS256 using `JWT_PUBLIC_KEY`. Invalid or expired → `401`.
3. `Authorization` header is **stripped** from the forwarded request.
4. Identity is injected as headers:

| Header | Value | Notes |
|--------|-------|-------|
| `x-user-id` | `sub` from JWT | User UUID |
| `x-org-id` | `org_id` from JWT | Omitted entirely when `null` (passengers) |
| `x-user-type` | `user_type` from JWT | `"passenger"` or `"staff"` |
| `x-user-roles` | JSON `string[]` | `role_slugs` array, serialised as JSON |
| `x-user-rules` | JSON array | `rules` array (packed CASL rules), serialised as JSON |

Downstream services trust these headers unconditionally and never verify JWTs
themselves.

### X-Client-Type

The gateway forwards this header from the original request unchanged. Downstream
services use it to decide whether to return tokens in the response body (mobile)
or set HttpOnly cookies (web).

---

## Error responses

All errors produced by the gateway itself follow the platform shape:

```json
{ "error": { "code": "SCREAMING_SNAKE_CASE", "message": "Human readable" } }
```

| Situation | HTTP | Code |
|-----------|------|------|
| Missing `Authorization` header | 401 | `UNAUTHORIZED` |
| Malformed / invalid / expired JWT | 401 | `UNAUTHORIZED` |
| No route matched | 404 | `NOT_FOUND` |
| Upstream service unreachable | 502 | `BAD_GATEWAY` |
| Unhandled exception | 500 | `INTERNAL_SERVER_ERROR` |

Upstream error responses (4xx/5xx from downstream services) are proxied as-is —
the gateway never touches them.

---

## Running locally

```bash
cp .env.example .env
# fill in .env

npm install
npm run dev       # tsx watch — restarts on source file changes
```

---

## Running with Docker

The api-gw does **not** expose a public port. Nginx (provisioned separately in
the infra repo) is the sole public entry point — it listens on 443/80 and
reverse-proxies to `http://katisha-api-gw:3000` over `katisha-net`. All
services are reachable only by container name on the internal network.

```bash
# Create the shared network once (idempotent)
docker network create katisha-net

docker compose pull
docker compose up -d
```

---

## Project structure

```
src/
  config/
    env.ts            Joi schema — validates process.env at startup, crashes if invalid
    index.ts          Typed config object — never use process.env outside here
  loaders/
    configWatcher.ts  Polls GitHub for routes.yaml; rebuilds route table on change
  middleware/
    authenticate.ts   JWT verification + X-User-* header injection
    errorHandler.ts   Maps unhandled errors → platform error shape
  routes/
    index.ts          Dynamic proxy router (reads in-memory route table per request)
    health.ts         GET /health
    jwks.ts           GET /.well-known/jwks.json → proxied to user-service
  utils/
    routeTable.ts     In-memory route table with get / set / match
    logger.ts         console.warn / console.error wrapper
  app.ts              Express app factory (no listen call)
  index.ts            Process listen + graceful shutdown
tests/
  unit/
    authenticate.test.ts
    configWatcher.test.ts
  integration/
    proxy.test.ts
```

---

## CI/CD

Three jobs on every push to `main`:

```
checks (tsc + eslint + vitest) → build-and-push (Docker Hub) → deploy (SSH)
```

See [`.github/workflows/ci-cd.yml`](.github/workflows/ci-cd.yml) and
[`skills/DEVOPS.md`](skills/DEVOPS.md) for setup instructions including the
7 required GitHub secrets.
