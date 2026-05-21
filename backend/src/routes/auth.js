const crypto = require('crypto');
const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { ok, created, fail } = require('../lib/http');
const { normalizeRegisterPayload, serializeService } = require('../lib/compat');
const { hashPassword, comparePassword, signAccessToken, signRefreshToken, hashToken, verifyRefreshToken } = require('../lib/auth');
const { requireAuth, requireRoles } = require('../middleware/auth');
const { writeAuditLog } = require('../lib/audit');
const { sendEmail, buildAppLink } = require('../lib/email');

const router = express.Router();


function passwordResetEmailHtml({ displayName, resetUrl }) {
  const safeName = String(displayName || 'there').replace(/[<>&"']/g, '');
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#18212f;max-width:600px;margin:0 auto;padding:24px">
      <h2 style="margin:0 0 12px;color:#18212f">Reset your CoGo City password</h2>
      <p style="margin:0 0 16px">Hi ${safeName},</p>
      <p style="margin:0 0 20px">We received a request to reset your CoGo City password. Use the button below to choose a new password. This link expires in 60 minutes.</p>
      <p style="margin:0 0 24px">
        <a href="${resetUrl}" style="display:inline-block;background:#2251ff;color:white;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600">Reset Password</a>
      </p>
      <p style="font-size:13px;color:#667085;margin:0 0 12px">If you did not request this, you can ignore this email.</p>
      <p style="font-size:12px;color:#667085;word-break:break-all;margin-top:24px">${resetUrl}</p>
    </div>
  `;
}

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
    businessTin: null,
    metadata,
  };
}

function registerPayloadErrorMessage(error) {
  if (!error || error.name !== 'ZodError' || !Array.isArray(error.issues)) return '';
  const labelByPath = {
    first_name: 'first name',
    firstName: 'first name',
    last_name: 'last name',
    lastName: 'last name',
    display_name: 'display name',
    displayName: 'display name',
    email: 'email address',
    phone: 'phone number',
    password: 'password',
    role: 'account type',
    date_of_birth: 'birthday',
    dateOfBirth: 'birthday',
    city: 'city',
  };
  const messages = error.issues.map((issue) => {
    const path = issue.path && issue.path.length ? String(issue.path[0]) : '';
    const label = labelByPath[path] || path || 'required information';
    if (issue.code === 'invalid_type' && issue.received === 'undefined') return `Please enter your ${label}.`;
    if (issue.code === 'invalid_string' && issue.validation === 'email') return 'Please enter a valid email address.';
    if (issue.code === 'too_small' && path === 'password') return 'Please create a password with at least 8 characters.';
    if (issue.code === 'too_small') return `Please enter your ${label}.`;
    if (issue.code === 'invalid_enum_value' && path === 'role') return 'Please choose a valid account type.';
    return `Please check your ${label}.`;
  });
  return [...new Set(messages)].join(' ');
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
        sensitive_info_custodian: 'stripe_connect',
        stores_sensitive_tax_identity_locally: false,
        tax_forms_provider: 'stripe_connect_tax_reporting',
      },
    },
  };
}

router.post('/register', async (req, res) => {
  try {
    const payload = normalizeRegisterPayload(req.body || {});
    if (payload.role === 'admin') return fail(res, 403, 'Admin accounts cannot be created through public registration');
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
              metadata: {
                images: Array.isArray(service.images) ? service.images : Array.isArray(service.entity_images) ? service.entity_images : [],
                entity_images: Array.isArray(service.entity_images) ? service.entity_images : Array.isArray(service.images) ? service.images : [],
                video_url: service.video_url || service.videoUrl || '',
                video_type: service.video_type || service.videoType || '',
                video_id: service.video_id || service.videoId || '',
              },
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
    const friendlyMessage = registerPayloadErrorMessage(error) || 'Please check the highlighted signup fields and try again.';
    return fail(res, 400, friendlyMessage, error.message);
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


router.post('/password-reset/request', async (req, res) => {
  try {
    const schema = z.object({ email: z.string().email() });
    const payload = schema.parse(req.body || {});
    const email = payload.email.toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });

    // Always return a generic success when the account does not exist to avoid account enumeration.
    if (!user || user.deletedAt || user.status !== 'active') return ok(res, { requested: true });

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash, expiresAt } });

    const resetUrl = buildAppLink(`/#/reset-password?token=${encodeURIComponent(token)}`);
    const displayName = user.displayName || [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;
    const emailResult = await sendEmail({
      to: { email: user.email, name: displayName },
      subject: 'Reset your CoGo City password',
      htmlContent: passwordResetEmailHtml({ displayName, resetUrl }),
      textContent: `Reset your CoGo City password\n\nOpen this link to choose a new password. It expires in 60 minutes:\n${resetUrl}\n\nIf you did not request this, ignore this email.`,
    });

    if (emailResult?.skipped) return fail(res, 503, 'Password reset email is not configured');
    await writeAuditLog({ userId: user.id, action: 'auth.password_reset_requested', entityType: 'user', entityId: user.id });
    return ok(res, { requested: true });
  } catch (error) {
    return fail(res, 400, 'Invalid password reset request', error.message);
  }
});

router.post('/password-reset/confirm', async (req, res) => {
  try {
    const schema = z.object({ token: z.string().min(32), new_password: z.string().min(8) });
    const payload = schema.parse(req.body || {});
    const tokenHash = hashToken(payload.token);
    const resetToken = await prisma.passwordResetToken.findUnique({ where: { tokenHash }, include: { user: true } });
    if (!resetToken || resetToken.usedAt || resetToken.expiresAt <= new Date()) return fail(res, 400, 'This password reset link is invalid or expired');
    if (!resetToken.user || resetToken.user.deletedAt || resetToken.user.status !== 'active') return fail(res, 400, 'This password reset link is invalid or expired');

    const passwordHash = await hashPassword(payload.new_password);
    await prisma.$transaction([
      prisma.user.update({ where: { id: resetToken.userId }, data: { passwordHash } }),
      prisma.passwordResetToken.update({ where: { id: resetToken.id }, data: { usedAt: new Date() } }),
      prisma.passwordResetToken.updateMany({ where: { userId: resetToken.userId, usedAt: null, id: { not: resetToken.id } }, data: { usedAt: new Date() } }),
      prisma.refreshToken.updateMany({ where: { userId: resetToken.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await writeAuditLog({ userId: resetToken.userId, action: 'auth.password_reset_completed', entityType: 'user', entityId: resetToken.userId });
    return ok(res, { updated: true });
  } catch (error) {
    return fail(res, 400, 'Invalid password reset confirmation', error.message);
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



router.get('/admin/users', requireAuth, requireRoles(['admin']), async (_req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { deletedAt: null },
      include: { userProfile: true, studentProfiles: { where: { deletedAt: null }, include: { services: { where: { deletedAt: null } } }, take: 1 } },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { displayName: 'asc' }],
    });

    return ok(res, users.map((user) => {
      const studentProfile = user.studentProfiles?.[0] || null;
      return {
        ...serializeUser(user, { userProfile: user.userProfile, studentProfile, services: studentProfile?.services || [] }),
        phone: user.phone,
        status: user.status,
        created_at: user.createdAt,
        updated_at: user.updatedAt,
        last_login: user.lastLogin,
      };
    }));
  } catch (error) {
    return fail(res, 500, 'Unable to load users', error.message);
  }
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { userProfile: true, studentProfiles: { where: { deletedAt: null }, include: { services: { where: { deletedAt: null } } } } },
    });
    if (!user) return fail(res, 404, 'User not found');
    const studentProfile = user.studentProfiles?.[0] || null;
    return ok(res, {
      ...serializeUser(user, { userProfile: user.userProfile, studentProfile, services: studentProfile?.services || [] }),
      phone: user.phone,
      status: user.status,
      created_at: user.createdAt,
    });
  } catch (error) {
    return fail(res, 500, 'Unable to load current user', error.message);
  }
});

module.exports = router;
