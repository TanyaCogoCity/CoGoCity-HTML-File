ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "stripe_default_payment_method_id" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "stripe_payment_setup_status" TEXT NOT NULL DEFAULT 'not_started';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "stripe_connect_onboarding_status" TEXT NOT NULL DEFAULT 'not_started';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "stripe_charges_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "stripe_payouts_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "stripe_details_submitted" BOOLEAN NOT NULL DEFAULT false;
