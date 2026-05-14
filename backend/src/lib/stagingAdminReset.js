const STAGING_HOST = 'staging.cogocity.com';
const TARGET_EMAIL = 'tanya@cogocity.com';
const FALLBACK_ADMIN_EMAIL = 'admin@cogocity.com';
const TEMP_PASSWORD_HASH = '$2a$12$ZIL/5N1xbh94W7eP8V4cAeV2b2XvuW.m4ZIMB2XdDc1rAdqBvpk/e';

function rawEnvIncludesStaging() {
  const values = [process.env.API_BASE_URL, process.env.APP_URL, process.env.CORS_ORIGIN]
    .map((value) => String(value || '').toLowerCase());
  return values.some((value) => value.includes(STAGING_HOST));
}

async function resetStagingAdmin(prisma) {
  if (!rawEnvIncludesStaging()) return;

  const existingTarget = await prisma.user.findUnique({ where: { email: TARGET_EMAIL } });
  let user = existingTarget;

  if (!user) {
    user = await prisma.user.findFirst({
      where: {
        email: FALLBACK_ADMIN_EMAIL,
        role: 'admin',
        deletedAt: null,
      },
    });
  }

  if (!user) {
    user = await prisma.user.findFirst({
      where: {
        role: 'admin',
        deletedAt: null,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  if (!user) {
    console.warn('Staging admin reset skipped: no admin user found.');
    return;
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      email: TARGET_EMAIL,
      role: 'admin',
      status: 'active',
      passwordHash: TEMP_PASSWORD_HASH,
      deletedAt: null,
    },
  });

  await prisma.refreshToken.updateMany({
    where: { userId: updated.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  console.log(`Staging admin reset applied for ${updated.email}.`);
}

module.exports = { resetStagingAdmin };
