# Stripe staging activation plan

This file is a preparation checklist only. Do not deploy, restart, or change active staging environment variables until the team is ready for Stripe test mode to go live on staging.

## Current code target

- Branch: `main`
- Remote: `https://github.com/TanyaCogoCity/CoGoCity-HTML-File.git`
- Next staging target: new Stripe marketplace/Connect reporting commit after local approval.

## Staging environment variables to add when ready

Set these only in the staging backend/app environment. Do not add them to `index.html`, Git, or static hosting config.

```bash
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PLATFORM_FEE_BPS=1000
```

Notes:
- Use Stripe **test mode** keys only for staging.
- `STRIPE_PLATFORM_FEE_BPS=1000` means 10% platform fee; adjust before activation if needed.
- Keep production/live Stripe keys separate and unset until the staging flow is fully verified.

## Prepared Stripe test-mode webhook

A Stripe **test/sandbox** webhook endpoint has been created, but its secrets have not been applied to staging yet.

```text
https://staging.cogocity.com/api/stripe/webhook
```

Webhook endpoint ID:

```text
we_1TUWsAIGDb9LYiIhXoBCVEIG
```

Enabled events originally prepared:

- `checkout.session.completed`
- `payment_intent.amount_capturable_updated`
- `payment_intent.succeeded`
- `payment_intent.canceled`
- `charge.refunded`

Additional events now needed for marketplace reconciliation/payout reporting:

- `transfer.created`
- `transfer.updated`
- `transfer.paid`
- `transfer.failed`
- `transfer.reversed`
- `application_fee.created`
- `application_fee.refunded`
- `payout.paid`
- `payout.failed`
- `payout.canceled`

The exact test `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` values are saved locally in ignored file:

```text
backend/.env.stripe-staging.local
```

Do not commit this local env file. Do not apply these values to DigitalOcean/staging until staging activation/deploy is explicitly approved.

## Activation sequence when ready

1. Confirm staging should receive the new Stripe marketplace/Connect reporting commit.
2. Add/confirm the staging env vars above in the hosting provider.
3. Add/update the Stripe test-mode webhook events and set `STRIPE_WEBHOOK_SECRET`.
4. Trigger/re-run the staging deployment.
5. Verify:
   - `https://staging.cogocity.com/api/health`
   - `https://staging.cogocity.com/api/health/db`
6. End-to-end Stripe test:
   - Employer starts a direct-hire project.
   - Stripe Checkout opens.
   - Pay with test card `4242 4242 4242 4242`.
   - Webhook marks funds as held/funded.
   - Employer approves final invoice.
   - Backend captures the manual PaymentIntent.
   - Project and transaction show completed/paid.

## Rollback/safe-disable

If staging payment behavior needs to be disabled:

1. Remove/unset `STRIPE_SECRET_KEY` from staging backend env.
2. Redeploy/restart staging backend.
3. The backend will return `Stripe is not configured`, and frontend project creation will keep the project saved but fail gracefully instead of exposing secrets.

## Staging status checked after Stripe prep

Read-only checks on 2026-05-07 found:

- `https://staging.cogocity.com/api/health` returns healthy.
- `https://staging.cogocity.com/api/health/db` returns database connected.
- The staging frontend now contains the new Stripe staging strings, so commit `b2087a3` has reached staging frontend/static hosting.
- Stripe backend secrets are still not active: `POST /api/stripe/webhook` returns `stripe_not_configured`.
- DigitalOcean dashboard confirms app `seal-app`, service `cogocity-api`, branch `main`, commit hash `b2087a3`, and `Autodeploy: On`.
- DigitalOcean active deployment `85663c29-0180-4f57-95f0-f8858d047704` was triggered by `commit b2087a3 pushed` and completed successfully.
- DigitalOcean shows `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` as secret env var entries, but the runtime behavior confirms they are still blank/inactive placeholders.
- No DigitalOcean settings were changed.
