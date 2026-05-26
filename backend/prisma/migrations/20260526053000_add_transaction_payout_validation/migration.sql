ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "payout_validation_status" TEXT;
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "payout_validation_checked_at" TIMESTAMP(3);
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "payout_validation_details" JSONB;
