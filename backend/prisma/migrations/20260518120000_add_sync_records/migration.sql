CREATE TABLE "sync_records" (
    "entity" TEXT NOT NULL,
    "record_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "sync_records_pkey" PRIMARY KEY ("entity", "record_id")
);

CREATE INDEX "sync_records_entity_updated_at_idx" ON "sync_records"("entity", "updated_at");
