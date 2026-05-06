# CoGo City Launch-Readiness Checklist

_Last updated: 2026-05-06_

## Staging verified
- Staging URL: https://staging.cogocity.com
- Main app source: `index.html`
- Core routes render without browser console errors: Home, Community, Jobs, Workshops & Classes, Blog, Dashboard, About Us.
- Mobile smoke test at phone width completed with no horizontal overflow on key pages.
- Basic accessibility smoke test completed: visible controls on tested pages have labels/text, and tested images have alt text.
- Transaction/CSV area is present in dashboard and shows CSV export button where rows exist.
- Mock payment records are working for holds, charges, refunds, transfers, and workshop platform-fee calculations.

## Safe staging polish prepared locally
- Browser title changed from `CoGo City Test Flow` to `CoGo City`.
- Added page description metadata.
- Added mobile browser theme color.
- Added favicon.
- Replaced disabled local backend URL default with same-origin `/api` to avoid local-only staging references.

## Working now in static/demo staging
- Public landing/navigation pages.
- Student/employer/community demo flows.
- Jobs and workshops/classes pages.
- Dashboard sections.
- Mock Stripe-ready payment event records.
- Mock workshop/class fee split: default 30% platform fee / 70% host payout.
- Dashboard transaction summaries and CSV export.

## Mock-only / not real money yet
- Card charging, escrow/holds, refunds, payouts, transfer IDs, Stripe customer/payment IDs.
- Password reset email.
- Stripe Connect/balance placeholders.
- Any data that appears persistent but is still local/static demo data.

## Required before true public live launch
1. GitHub/repo deploy access fixed so staging polish can be pushed.
2. Backend/API selected and deployed for auth, database, payments, emails, admin tools, and file/media storage.
3. Stripe test-mode integration implemented on the backend only.
4. Stripe publishable key used in frontend; Stripe secret key stored only as backend environment variable.
5. Real user account model and permissions finalized.
6. Production database backup/export policy confirmed.
7. Privacy, terms, youth safety, labor-law, and payment/refund wording reviewed by owner/legal advisor.
8. Final production domain/deploy target confirmed.

## Known blocker as of this note
- Local commit `dc9ef7c Polish staging live-readiness metadata` exists, but `git push origin main` failed with GitHub 403 for the currently active credential. Staging has not received this polish commit yet.
