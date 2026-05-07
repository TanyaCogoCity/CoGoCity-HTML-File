# CoGo City Staging Backend Deploy Notes

Goal: deploy `backend/` as a DigitalOcean App Platform service and attach a staging PostgreSQL database.

## Current status
- Backend code is pushed to GitHub on `main`.
- Local health test passed for `GET /health`.
- `GET /health/db` is expected to fail until a real PostgreSQL `DATABASE_URL` is attached.
- Stripe real payments remain disabled; Stripe secret env vars are blank placeholders.

## DigitalOcean settings to add
App: `seal-app`

Backend service:
- Name: `cogocity-api`
- Source repo: `TanyaCogoCity/CoGoCity-HTML-File`
- Branch: `main`
- Source directory: `backend`
- Build command: `npm ci && npx prisma generate`
- Run command: `npm start`
- HTTP port: `4000`
- Health check path: `/health`

Database:
- Type: PostgreSQL
- Name: `cogocity-staging-db`
- Environment: staging/dev database is okay for now
- Attach `DATABASE_URL` to the backend service as a secret runtime env var

Runtime env vars:
```text
NODE_ENV=production
PORT=4000
API_BASE_URL=https://api-staging.cogocity.com
CORS_ORIGIN=https://staging.cogocity.com
DATABASE_URL=<DigitalOcean managed database URL, secret>
REQUIRE_DATABASE=true
JWT_ACCESS_SECRET=<generate strong secret in DigitalOcean>
JWT_REFRESH_SECRET=<generate different strong secret in DigitalOcean>
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=30d
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PLATFORM_FEE_BPS=1000
```

## After deploy
1. Open backend public URL and verify `/health` returns `{ "ok": true }`.
2. Run Prisma migrations against the staging database.
3. Verify `/health/db` returns database connected.
4. Only after that, point frontend migration bridge to the backend API.

## Important safety notes
- Do not add real Stripe keys yet.
- Do not put database passwords or JWT secrets in GitHub.
- Do not switch production `cogocity.com` to this backend yet.
