# CoGo City Backend (Migration-Safe)

This backend is designed for progressive migration from the current CoGo HTML frontend (localStorage/client state) to a production API.

## Stack
- Node.js + Express
- PostgreSQL + Prisma
- Stripe Connect (PaymentIntents + webhook updates)
- DigitalOcean App Platform + Managed PostgreSQL + Spaces-compatible media storage

## Migration Safety
- Legacy field compatibility layer (`src/lib/compat.js`) accepts aliases such as:
  - `thread_id` -> `conversation_id`
  - `video_url` -> normalized media fields
  - `rate` -> `hourly_rate`
- Status transition enforcement can be delayed via env:
  - `STRICT_STATUS_TRANSITIONS=false` (default behavior)

## Required Environment Variables
Copy `.env.example` to `.env` locally, or configure the same keys as private environment variables in DigitalOcean App Platform.

Never commit real `.env` files, Stripe secret keys, JWT secrets, database passwords, or DigitalOcean Spaces credentials.

## Install and Run
```bash
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run dev
```

Health endpoints:
- `GET /health` — works before the database is connected, useful for first staging deploy.
- `GET /health/db` — checks PostgreSQL connectivity.

First staging deploy can use `REQUIRE_DATABASE=false` so the API starts and exposes `/health` while the managed database is being attached. Set `REQUIRE_DATABASE=true` once `DATABASE_URL` is configured and migrations are deployed.

## Implemented API Routes
- Auth
  - `POST /api/auth/register`
  - `POST /api/auth/login`
  - `POST /api/auth/refresh`
  - `POST /api/auth/logout`
  - `GET /api/auth/me`
- Profiles
  - `GET /api/student-profiles`
  - `POST /api/student-profiles`
  - `PATCH /api/student-profiles/:id`
- Services
  - `GET /api/services`
  - `POST /api/services`
  - `PATCH /api/services/:id`
- Jobs
  - `GET /api/jobs`
  - `POST /api/jobs`
  - `POST /api/jobs/:id/apply`
- Applications
  - `PATCH /api/applications/:id/accept`
  - `PATCH /api/applications/:id/reject`
- Projects
  - `POST /api/projects/start`
  - `PATCH /api/projects/:id/complete`
  - `PATCH /api/projects/:id/approve`
- Payments / Stripe
  - `POST /api/stripe/create-payment-intent`
  - `POST /api/stripe/webhook`
- Messages
  - `GET /api/messages`
  - `POST /api/messages`
- Reviews
  - `POST /api/projects/:id/review`
- Workshops
  - `GET /api/workshops`
  - `POST /api/workshops`
  - `POST /api/workshops/:id/enroll`
- Transactions
  - `GET /api/transactions`
- Notifications
  - `GET /api/notifications`
  - `PATCH /api/notifications/:id/read`

## Security Features Included
- JWT auth + refresh token storage
- rate limiting
- validation with zod
- Stripe webhook signature verification
- audit logs for critical actions
- soft-delete columns in core models

## Frontend Integration
A migration-ready HTML was created:
- `Cogojobs-platform-V3-SERVICE-FIRST-MEDIA.backend-migration-v1.html`

It includes `window.CoGoBackend` bridge with API config and request helper.
Default mode keeps current UI behavior unchanged (`enabled: false`).

Enable backend mode in HTML script:
```js
BACKEND_MIGRATION.enabled = true;
```

Then progressively move flows phase-by-phase.
