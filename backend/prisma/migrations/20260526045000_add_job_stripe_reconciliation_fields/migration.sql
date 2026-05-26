ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "stripe_checkout_session_id" TEXT;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "stripe_payment_intent_id" TEXT;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "stripe_charge_id" TEXT;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "stripe_payment_status" TEXT;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "paid_at" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "jobs_stripe_checkout_session_id_key" ON "jobs"("stripe_checkout_session_id");
CREATE UNIQUE INDEX IF NOT EXISTS "jobs_stripe_payment_intent_id_key" ON "jobs"("stripe_payment_intent_id");
