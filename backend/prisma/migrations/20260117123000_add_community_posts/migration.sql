CREATE TABLE "community_posts" (
    "id" TEXT NOT NULL,
    "author_id" TEXT,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "community_posts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "community_posts_author_id_idx" ON "community_posts"("author_id");
CREATE INDEX "community_posts_created_at_idx" ON "community_posts"("created_at");
