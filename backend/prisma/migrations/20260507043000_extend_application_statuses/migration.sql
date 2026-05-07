ALTER TYPE "ApplicationStatus" ADD VALUE IF NOT EXISTS 'reviewing';
ALTER TYPE "ApplicationStatus" ADD VALUE IF NOT EXISTS 'shortlisted';
ALTER TYPE "ApplicationStatus" ADD VALUE IF NOT EXISTS 'hired';
ALTER TYPE "ApplicationStatus" ADD VALUE IF NOT EXISTS 'withdrawn';

ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "resume_file_name" TEXT;
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "resume_data_url" TEXT;
