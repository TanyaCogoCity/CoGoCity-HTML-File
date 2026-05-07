-- Add direct-hire job listing fields used by the staging frontend.
ALTER TABLE "jobs"
  ADD COLUMN IF NOT EXISTS "company_name" TEXT,
  ADD COLUMN IF NOT EXISTS "job_type" TEXT,
  ADD COLUMN IF NOT EXISTS "work_mode" TEXT,
  ADD COLUMN IF NOT EXISTS "compensation_text" TEXT,
  ADD COLUMN IF NOT EXISTS "requirements" TEXT,
  ADD COLUMN IF NOT EXISTS "schedule" TEXT,
  ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "posting_package" TEXT,
  ADD COLUMN IF NOT EXISTS "posting_fee" DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS "listing_months" INTEGER,
  ADD COLUMN IF NOT EXISTS "listing_duration_days" INTEGER,
  ADD COLUMN IF NOT EXISTS "payment_status" TEXT;
