const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { ok, created, fail } = require('../lib/http');
const { normalizeRegisterPayload, serializeService } = require('../lib/compat');
const { hashPassword, comparePassword, signAccessToken, signRefreshToken, hashToken, verifyRefreshToken } = require('../lib/auth');
const { requireAuth } = require('../middleware/auth');
const { writeAuditLog } = require('../lib/audit');

const router = express.Router();

function buildUserProfileData(userId, payload = {}) {
  const profile = payload.profile || {};
  const business = payload.businessProfile || profile.businessProfile || {};
  const metadata = {
    photo: profile.photo || payload.photo || '',
    profile_images: profile.profileImages || [],
    video_url: profile.video_url || profile.videoUrl || '',
  };
  return {
    userId,
    type: payload.type || profile.type || null,
    about: profile.about || payload.about || null,
    address: profile.address || payload.address || null,
    school: profile.school || payload.school || null,
    age: profile.age ? Number(profile.age) : null,
    avatar: profile.avatar || payload.avatar || null,
    businessName: business.name || payload.businessName || null,
    businessAbout: business.about || payload.businessAbout || null,
    businessPhone: business.phone || payload.businessPhone || null,
    businessAddress: business.address || payload.businessAddress || null,
    businessCity: business.city || payload.businessCity || null,
    businessTin: business.tin || payload.tin || null,
    metadata,
  };
}

function serializeUser(user, extras = {}) {
  return {
    id: user.id,
    first_name: user.firstName,
    last_name: user.lastName,
    display_name: user.displayName,
    email: user.email,
    role: user.role,
    city: user.city,
    profile: extras.userProfile || null,
    student_profile: extras.studentProfile || null,
    services: (extras.services || []).map(serializeService),
    stripe_onboarding: {
      payer: {
        stripe_customer_id: user.stripeCustomerId || null,
        default_payment_method_id: user.stripeDefaultPaymentMethodId || null,
        payment_setup_status: user.stripePaymentSetupStatus || 'not_started',
        ready: Boolean(user.stripeCustomerId && user.stripeDefaultPaymentMethodId && user.stripePaymentSetupStatus === 'complete'),
      },
      connect: {
        stripe_account_id: user.stripeAccountId || null,
        onboarding_status: user.stripeConnectOnboardingStatus || 'not_started',
        charges_enabled: Boolean(user.stripeChargesEnabled),
        payouts_enabled: Boolean(user.stripePayoutsEnabled),
        details_submitted: Boolean(user.stripeDetailsSubmitted),
        ready: Boolean(user.stripeAccountId && user.stripePayoutsEnabled && user.stripeDetailsSubmitted),
      },
    },
  };
}

router.post('/register', async (req, res) => {
  try {
    const payload = normalizeRegisterPayload(req.body || {});
    const exists = await prisma.user.findUnique({ where: { email: payload.email } });
    if (exists) return fail(res, 409, 'Email already in use');

    const rawPayload = req.body || {};
    const passwordHash = await hashPassword(payload.password);
    const profilePayload = rawPayload.profile || {};
    const servicesPayload = Array.isArray(rawPayload.services) ? rawPayload.services : Array.isArray(profilePayload.services) ? profilePayload.services : [];

    const createdRecords = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          firstName: payload.firstName,
          lastName: payload.lastName,
          displayName: payload.displayName,
          email: payload.email,
          phone: payload.phone,
          role: payload.role,
          city: payload.city,
          dateOfBirth: payload.dateOfBirth ? new Date(payload.dateOfBirth) : null,
          passwordHash,
        },
      });

      const userProfile = await tx.userProfile.create({ data: buildUserProfileData(user.id, rawPayload) });
      let studentProfile = null;
      let services = [];

      if (payload.role === 'student') {
        const firstService = servicesPayload[0] || {};
        studentProfile = await tx.studentProfile.create({
          data: {
            userId: user.id,
            title: firstService.title || profilePayload.title || rawPayload.title || 'Student Service',
            bio: profilePayload.bio || profilePayload.about || rawPayload.about || '',
            experience: profilePayload.experience || rawPayload.experience || '',
            isActive: true,
          },
        });

        if (servicesPayload.length) {
          services = await Promise.all(servicesPayload.map((service) => tx.service.create({
            data: {
              profileId: studentProfile.id,
              title: String(service.title || 'Student Service').trim(),
              description: service.description || service.about || '',
              hourlyRate: Number(service.hourly_rate ?? service.hourlyRate ?? service.rate ?? 0) || 0,
              availability: service.availability || '',
              location: service.location || rawPayload.city || '',
              isActive: service.is_active ?? service.isActive ?? true,
            },
          })));
        }
      }

      return { user, userProfile, studentProfile, services };
    });

    const user = createdRecords.user;
    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    await writeAuditLog({ userId: user.id, action: 'auth.register', entityType: 'user', entityId: user.id });

    return created(res, {
      user: serializeUser(user, createdRecords),
      access_token: accessToken,
      refresh_token: refreshToken,
    });
  } catch (error) {
    return fail(res, 400, 'Invalid register payload', error.message);
  }
});

router.post('/login', async (req, res) => {
  try {
    const schema = z.object({ email: z.string().email(), password: z.string().min(1) });
    const payload = schema.parse(req.body || {});

    const user = await prisma.user.findUnique({
      where: { email: payload.email.toLowerCase() },
      include: { userProfile: true, studentProfiles: { where: { deletedAt: null }, include: { services: { where: { deletedAt: null } } } } },
    });
    if (!user || user.deletedAt || user.status !== 'active') return fail(res, 401, 'Invalid credentials');

    const valid = await comparePassword(payload.password, user.passwordHash);
    if (!valid) return fail(res, 401, 'Invalid credentials');

    await prisma.user.update({ where: { id: user.id }, data: { lastLogin: new Date() } });

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    const studentProfile = user.studentProfiles?.[0] || null;
    return ok(res, {
      user: serializeUser(user, { userProfile: user.userProfile, studentProfile, services: studentProfile?.services || [] }),
      access_token: accessToken,
      refresh_token: refreshToken,
    });
  } catch (error) {
    return fail(res, 400, 'Invalid login payload', error.message);
  }
});

router.patch('/password', requireAuth, async (req, res) => {
  try {
    const schema = z.object({
      current_password: z.string().min(1),
      new_password: z.string().min(8),
    });
    const payload = schema.parse(req.body || {});

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user || user.deletedAt || user.status !== 'active') return fail(res, 401, 'Unauthorized user');

    const valid = await comparePassword(payload.current_password, user.passwordHash);
    if (!valid) return fail(res, 401, 'Current password is incorrect');

    const passwordHash = await hashPassword(payload.new_password);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    await prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await writeAuditLog({ userId: user.id, action: 'auth.password_update', entityType: 'user', entityId: user.id });

    return ok(res, { updated: true });
  } catch (error) {
    return fail(res, 400, 'Invalid password update payload', error.message);
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const token = String(req.body?.refresh_token || '').trim();
    if (!token) return fail(res, 400, 'Missing refresh token');

    const decoded = verifyRefreshToken(token);
    const tokenHash = hashToken(token);

    const dbToken = await prisma.refreshToken.findFirst({
      where: {
        userId: decoded.sub,
        tokenHash,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });

    if (!dbToken) return fail(res, 401, 'Invalid refresh token');

    const user = await prisma.user.findUnique({ where: { id: decoded.sub } });
    if (!user || user.status !== 'active' || user.deletedAt) return fail(res, 401, 'Unauthorized user');

    const accessToken = signAccessToken(user);
    return ok(res, { access_token: accessToken });
  } catch (error) {
    return fail(res, 401, 'Invalid refresh token');
  }
});

router.post('/logout', requireAuth, async (req, res) => {
  const token = String(req.body?.refresh_token || '').trim();
  if (!token) return ok(res, { revoked: false });
  await prisma.refreshToken.updateMany({ where: { userId: req.user.id, tokenHash: hashToken(token), revokedAt: null }, data: { revokedAt: new Date() } });
  return ok(res, { revoked: true });
});

router.get('/me', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { userProfile: true, studentProfiles: { where: { deletedAt: null }, include: { services: { where: { deletedAt: null } } } } },
  });
  const studentProfile = user.studentProfiles?.[0] || null;
  return ok(res, {
    ...serializeUser(user, { userProfile: user.userProfile, studentProfile, services: studentProfile?.services || [] }),
    phone: user.phone,
    status: user.status,
    created_at: user.createdAt,
  });
});

module.exports = router;
