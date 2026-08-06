ALTER TABLE "users"
  ADD COLUMN "co_go_verified" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "verified_at" TIMESTAMP(3),
  ADD COLUMN "verified_by" UUID;
