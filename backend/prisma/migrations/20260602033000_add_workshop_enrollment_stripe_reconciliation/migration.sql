ALTER TABLE "workshop_enrollments" ADD COLUMN IF NOT EXISTS "stripe_checkout_session_id" TEXT;
ALTER TABLE "workshop_enrollments" ADD COLUMN IF NOT EXISTS "stripe_payment_intent_id" TEXT;
ALTER TABLE "workshop_enrollments" ADD COLUMN IF NOT EXISTS "stripe_charge_id" TEXT;
ALTER TABLE "workshop_enrollments" ADD COLUMN IF NOT EXISTS "stripe_payment_status" TEXT;
ALTER TABLE "workshop_enrollments" ADD COLUMN IF NOT EXISTS "paid_at" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "workshop_enrollments_stripe_checkout_session_id_key" ON "workshop_enrollments"("stripe_checkout_session_id");
CREATE UNIQUE INDEX IF NOT EXISTS "workshop_enrollments_stripe_payment_intent_id_key" ON "workshop_enrollments"("stripe_payment_intent_id");
CREATE INDEX IF NOT EXISTS "workshop_enrollments_stripe_charge_id_idx" ON "workshop_enrollments"("stripe_charge_id");
