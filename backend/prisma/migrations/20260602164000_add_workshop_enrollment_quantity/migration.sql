ALTER TABLE "workshop_enrollments"
  ADD COLUMN "quantity" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "total_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "platform_fee" DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "host_payout" DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "attendee_name" TEXT,
  ADD COLUMN "attendee_email" TEXT;

UPDATE "workshop_enrollments" we
SET
  "total_amount" = COALESCE(w."price", 0),
  "platform_fee" = ROUND((COALESCE(w."price", 0) * 0.30)::numeric, 2),
  "host_payout" = ROUND((COALESCE(w."price", 0) * 0.70)::numeric, 2)
FROM "workshops" w
WHERE we."workshop_id" = w."id";
