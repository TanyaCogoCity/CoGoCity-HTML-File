# CoGo City Staging Backend Deploy Notes

Goal: deploy `backend/` as a DigitalOcean App Platform service and attach a staging PostgreSQL database.

## Current status
- Backend code is pushed to GitHub on `main`.
- Backend service `cogocity-api` is deployed on DigitalOcean App Platform under `seal-app`.
- Staging PostgreSQL dev database component is attached as `db`.
- Public API route is `https://staging.cogocity.com/api`.
- Verified `GET /api/health` returns `{ "ok": true }`.
- Verified `GET /api/health/db` returns `{ "database": "connected" }`.
- Initial staging database schema was synced successfully by DigitalOcean at 5:58 PM using Prisma `db push` against the empty dev database.
- Stripe real payments remain disabled; Stripe secret env vars are blank placeholders.

## DigitalOcean settings to add
App: `seal-app`

Backend service:
- Name: `cogocity-api`
- Source repo: `TanyaCogoCity/CoGoCity-HTML-File`
- Branch: `main`
- Source directory: `backend`
- Build command: `npm ci && npx prisma generate`
- Run command: `npx prisma db push --accept-data-loss && npm start` for the initial empty staging DB bootstrap.
  - Before importing real/live data, replace this with `npx prisma migrate deploy && npm start` after resolving/verifying migration history.
- HTTP port: `4000`
- Health check path: `/health`

Database:
- Type: PostgreSQL
- Component name: `db`
- Version: PostgreSQL 17
- Environment: staging/dev database is okay for now
- Attach `DATABASE_URL` to the backend service as a secret runtime env var using `${db.DATABASE_URL}`

Runtime env vars:
```text
NODE_ENV=production
PORT=4000
API_BASE_URL=https://staging.cogocity.com/api
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
1. Open `https://staging.cogocity.com/api/health` and verify `{ "ok": true }`.
2. Open `https://staging.cogocity.com/api/health/db` and verify `{ "database": "connected" }`.
3. Commit Prisma migrations under `backend/prisma/migrations/`.
4. For the initial empty staging DB bootstrap, `npx prisma db push --accept-data-loss && npm start` was used and verified in DigitalOcean deploy logs.
5. Before importing live/real data, resolve/verify Prisma migration history and change the run command back to `npx prisma migrate deploy && npm start`.
6. Only after backend-backed flows are implemented/tested, point frontend migration bridge to the backend API.

## Important safety notes
- Do not add real Stripe keys yet.
- Do not put database passwords or JWT secrets in GitHub.
- Do not switch production `cogocity.com` to this backend yet.
