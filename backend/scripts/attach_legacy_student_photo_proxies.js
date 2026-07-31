#!/usr/bin/env node
/*
  Rewrites student user_profiles.metadata.photo legacy WordPress URLs to the
  backend proxy route so profile photos render without waiting for a full image
  migration.

  Safety:
  - Dry-run by default: node scripts/attach_legacy_student_photo_proxies.js
  - Execute requires BOTH:
      COGOCITY_ATTACH_LEGACY_MEDIA=yes
      node scripts/attach_legacy_student_photo_proxies.js --execute
*/

const { PrismaClient } = require('@prisma/client');
const { normalizeProfileMetadataMedia, parseLegacyWordPressUploadUrl } = require('../src/lib/media');

const prisma = new PrismaClient();
const args = new Set(process.argv.slice(2));
const execute = args.has('--execute');
const displayNameArg = process.argv.find((value, index, all) => value === '--display-name' ? all[index + 1] : null);
const emailArg = process.argv.find((value, index, all) => value === '--email' ? all[index + 1] : null);
const targetDisplayName = String(process.env.TARGET_DISPLAY_NAME || displayNameArg || '').trim().toLowerCase();
const targetEmail = String(process.env.TARGET_EMAIL || emailArg || '').trim().toLowerCase();

function changedKeys(before = {}, after = {}) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...keys].filter((key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]));
}

async function main() {
  const profiles = await prisma.userProfile.findMany({
    where: {
      user: {
        role: 'student',
        deletedAt: null,
        status: 'active',
      },
    },
    include: {
      user: {
        select: { id: true, email: true, displayName: true },
      },
    },
    orderBy: { updatedAt: 'desc' },
  });

  const candidates = profiles.map((profile) => {
    const before = profile.metadata && typeof profile.metadata === 'object' && !Array.isArray(profile.metadata)
      ? profile.metadata
      : {};
    const after = normalizeProfileMetadataMedia(before);
    const changed = changedKeys(before, after);
    const hasLegacyPhoto = Boolean(
      parseLegacyWordPressUploadUrl(before.photo || '')
      || (Array.isArray(before.profile_images) && before.profile_images.some((value) => parseLegacyWordPressUploadUrl(value)))
    );
    if (!hasLegacyPhoto || !changed.length) return null;
    return {
      profileId: profile.id,
      userId: profile.userId,
      email: profile.user?.email || '',
      displayName: profile.user?.displayName || '',
      before,
      after,
      changed,
    };
  }).filter(Boolean).filter((row) => {
    if (targetDisplayName && String(row.displayName || '').trim().toLowerCase() !== targetDisplayName) return false;
    if (targetEmail && String(row.email || '').trim().toLowerCase() !== targetEmail) return false;
    return true;
  });

  console.log(JSON.stringify({
    execute,
    target_display_name: targetDisplayName || '',
    target_email: targetEmail || '',
    count: candidates.length,
    candidates: candidates.slice(0, 200).map((row) => ({
      profileId: row.profileId,
      userId: row.userId,
      email: row.email,
      displayName: row.displayName,
      changed: row.changed,
      beforePhoto: row.before.photo || '',
      afterPhoto: row.after.photo || '',
    })),
  }, null, 2));

  if (!execute) return;
  if (process.env.COGOCITY_ATTACH_LEGACY_MEDIA !== 'yes') {
    throw new Error('Refusing to execute without COGOCITY_ATTACH_LEGACY_MEDIA=yes');
  }

  for (const row of candidates) {
    await prisma.userProfile.update({
      where: { id: row.profileId },
      data: { metadata: row.after },
    });
  }

  console.log(`Updated ${candidates.length} student profiles.`);
}

main()
  .catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
