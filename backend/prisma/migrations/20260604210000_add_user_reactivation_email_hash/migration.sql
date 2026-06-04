ALTER TABLE "users" ADD COLUMN "reactivation_email_hash" TEXT;

CREATE INDEX "users_reactivation_email_hash_idx" ON "users"("reactivation_email_hash");
