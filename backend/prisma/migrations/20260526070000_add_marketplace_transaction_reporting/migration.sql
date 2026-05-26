ALTER TABLE "transactions"
  ADD COLUMN IF NOT EXISTS "stripe_charge_id" TEXT,
  ADD COLUMN IF NOT EXISTS "stripe_application_fee_id" TEXT,
  ADD COLUMN IF NOT EXISTS "stripe_balance_transaction_id" TEXT,
  ADD COLUMN IF NOT EXISTS "stripe_processing_fee" DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS "platform_net_revenue" DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS "transfer_status" TEXT,
  ADD COLUMN IF NOT EXISTS "payout_status" TEXT;

CREATE INDEX IF NOT EXISTS "transactions_stripe_charge_id_idx" ON "transactions"("stripe_charge_id");
CREATE INDEX IF NOT EXISTS "transactions_stripe_transfer_id_idx" ON "transactions"("stripe_transfer_id");
CREATE INDEX IF NOT EXISTS "transactions_stripe_application_fee_id_idx" ON "transactions"("stripe_application_fee_id");
