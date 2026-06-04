const crypto = require('crypto');
const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { ok, created, fail } = require('../lib/http');
const { normalizeRegisterPayload, serializeService } = require('../lib/compat');
const { hashPassword, comparePassword, signAccessToken, signRefreshToken, hashToken, verifyRefreshToken } = require('../lib/auth');
const { requireAuth, requireRoles } = require('../middleware/auth');
const { writeAuditLog } = require('../lib/audit');
const { onboardingRequirementsForUser, userProfileMetadata } = require('../lib/onboardingGate');
const { sendEmail, buildAppLink } = require('../lib/email');
const { notifyAdminNewUser } = require('../lib/adminEmails');

const router = express.Router();

const US_ONLY_SIGNUP_MESSAGE = 'Thanks for your interest in CoGo City. At this moment, we can only support users and opportunities within the United States, but we hope to expand to other countries soon.';
const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);
const US_STATE_NAMES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS',
  kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX',
  utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'district of columbia': 'DC',
};
const NON_US_COUNTRY_WORDS = /\b(canada|mexico|united kingdom|uk|england|france|germany|india|china|australia|brazil|italy|spain|israel|russia|japan)\b/i;

function truthySignupConfirmation(value) {
  if (value === true || value === 1) return true;
  const normalized = String(value || '').trim().toLowerCase();
  return ['true', 'yes', 'y', '1', 'on'].includes(normalized);
}

function getSignupUsConfirmation(payload = {}) {
  return payload.usOnlyConfirmed ?? payload.us_only_confirmed ?? payload.usaOnlyConfirmed ?? payload.usa_only_confirmed ?? payload.usConfirmation ?? payload.us_confirmation;
}

function isValidUsPhone(value = '') {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
}

function addressValueFromPayload(payload = {}) {
  const profile = payload.profile || {};
  return profile.address || payload.address || '';
}

function businessAddressValueFromPayload(payload = {}) {
  const profile = payload.profile || {};
  const business = payload.businessProfile || profile.businessProfile || {};
  return business.address || payload.businessAddress || '';
}

function normalizeUsAddressText(value = '') {
  let address = String(value || '').trim().replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ');
  address = address.replace(/\b(?:United States of America|United States|USA|US)\b\.?$/i, '').replace(/,\s*$/g, '').trim();
  Object.entries(US_STATE_NAMES).forEach(([name, code]) => {
    address = address.replace(new RegExp(`\\b${name}\\b`, 'gi'), code);
  });
  return address;
}

function isUsAddress(value = '') {
  const address = normalizeUsAddressText(value);
  if (!address || NON_US_COUNTRY_WORDS.test(address)) return false;
  const stateZipMatch = address.match(/\b([A-Z]{2})\s*,?\s+\d{5}(?:-\d{4})?\b/i);
  if (!stateZipMatch) return false;
  return US_STATES.has(stateZipMatch[1].toUpperCase());
}

function validateUsOnlySignup(payload = {}, normalizedPayload = {}) {
  if (!truthySignupConfirmation(getSignupUsConfirmation(payload))) {
    return 'Please confirm that you live in the United States and will use CoGo City only for U.S.-based opportunities.';
  }
  if (!isValidUsPhone(normalizedPayload.phone || payload.phone || '')) {
    return 'Please enter a valid 10-digit U.S. phone number.';
  }
  const homeAddress = addressValueFromPayload(payload);
  if (!isUsAddress(homeAddress)) return US_ONLY_SIGNUP_MESSAGE;
  if (normalizedPayload.role === 'employer' && !isUsAddress(businessAddressValueFromPayload(payload))) return US_ONLY_SIGNUP_MESSAGE;
  return '';
}


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


const adminUserUpdateSchema = z.object({
  first_name: z.string().trim().min(1).optional(),
  firstName: z.string().trim().min(1).optional(),
  last_name: z.string().trim().min(1).optional(),
  lastName: z.string().trim().min(1).optional(),
  display_name: z.string().trim().optional(),
  displayName: z.string().trim().optional(),
  email: z.string().email().optional(),
  phone: z.string().trim().optional().nullable(),
  role: z.enum(['student', 'employer', 'neighbor', 'admin']).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  city: z.string().trim().optional().nullable(),
  address: z.string().trim().optional().nullable(),
  about: z.string().trim().optional().nullable(),
  photo: z.string().trim().optional().nullable(),
  profile_image_id: z.string().trim().optional().nullable(),
  profileImageId: z.string().trim().optional().nullable(),
  business_name: z.string().trim().optional().nullable(),
  businessName: z.string().trim().optional().nullable(),
  business_about: z.string().trim().optional().nullable(),
  businessAbout: z.string().trim().optional().nullable(),
  business_logo: z.string().trim().optional().nullable(),
  businessLogo: z.string().trim().optional().nullable(),
  migration_onboarding_required: z.boolean().optional(),
  migrationOnboardingRequired: z.boolean().optional(),
  payment_method_required: z.boolean().optional(),
  paymentMethodRequired: z.boolean().optional(),
});

function serializeAdminUser(user) {
  const studentProfile = user.studentProfiles?.[0] || null;
  return {
    ...serializeUser(user, { userProfile: user.userProfile, studentProfile, services: studentProfile?.services || [] }),
    phone: user.phone,
    status: user.status,
    created_at: user.createdAt,
    updated_at: user.updatedAt,
    last_login: user.lastLogin,
  };
}

function serializeUser(user, extras = {}) {
  return {
    id: user.id,
    first_name: user.firstName,
    last_name: user.lastName,
    display_name: user.displayName,
    email: user.email,
    phone: user.phone,
    status: user.status,
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
    onboarding_requirements: onboardingRequirementsForUser(user, extras.userProfile || user.userProfile || null),
  };
}

router.post('/register', async (req, res) => {
  try {
    const payload = normalizeRegisterPayload(req.body || {});
    if (payload.role === 'admin') return fail(res, 403, 'Admin accounts cannot be created through public registration');
    const usOnlySignupProblem = validateUsOnlySignup(req.body || {}, payload);
    if (usOnlySignupProblem) return fail(res, 400, usOnlySignupProblem);
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
    await notifyAdminNewUser(user);

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

    return ok(res, users.map(serializeAdminUser));
  } catch (error) {
    return fail(res, 500, 'Unable to load users', error.message);
  }
});



router.patch('/admin/users/onboarding-requirements', requireAuth, requireRoles(['admin']), async (req, res) => {
  try {
    const emails = Array.isArray(req.body?.emails)
      ? [...new Set(req.body.emails.map((email) => String(email || '').trim().toLowerCase()).filter(Boolean))]
      : [];
    if (!emails.length) return fail(res, 400, 'emails array is required');
    if (emails.length > 250) return fail(res, 400, 'Too many emails in one request');

    const migrationRequired = req.body.migration_onboarding_required ?? req.body.migrationOnboardingRequired;
    const paymentRequired = req.body.payment_method_required ?? req.body.paymentMethodRequired;
    const allowedRoles = Array.isArray(req.body.roles)
      ? req.body.roles.map((role) => String(role || '').trim()).filter(Boolean)
      : ['employer', 'neighbor'];
    const profileFlagUpdates = {};
    if (migrationRequired !== undefined) profileFlagUpdates.migration_onboarding_required = Boolean(migrationRequired);
    if (paymentRequired !== undefined) profileFlagUpdates.payment_method_required = Boolean(paymentRequired);
    if (!Object.keys(profileFlagUpdates).length) return fail(res, 400, 'At least one onboarding flag is required');

    const result = await prisma.$transaction(async (tx) => {
      const users = await tx.user.findMany({
        where: { email: { in: emails }, deletedAt: null },
        include: { userProfile: true },
      });
      const matched = users.filter((user) => allowedRoles.includes(user.role));
      for (const user of matched) {
        const metadata = Object.assign({}, userProfileMetadata(user.userProfile), profileFlagUpdates);
        await tx.userProfile.upsert({
          where: { userId: user.id },
          create: { userId: user.id, metadata },
          update: { metadata },
        });
      }
      const foundEmails = new Set(users.map((user) => user.email.toLowerCase()));
      return {
        requested: emails.length,
        found: users.length,
        updated: matched.length,
        missing: emails.filter((email) => !foundEmails.has(email)),
        skipped_role_mismatch: users
          .filter((user) => !allowedRoles.includes(user.role))
          .map((user) => ({ email: user.email, role: user.role })),
      };
    });

    await writeAuditLog({ userId: req.user.id, action: 'admin.users.onboarding_requirements.update', entityType: 'user', payload: result });
    return ok(res, result);
  } catch (error) {
    if (error?.name === 'ZodError') return fail(res, 400, 'Invalid onboarding requirements payload', error.errors);
    return fail(res, 500, 'Unable to update onboarding requirements', error.message);
  }
});

router.patch('/admin/users/:id', requireAuth, requireRoles(['admin']), async (req, res) => {
  try {
    const targetId = String(req.params.id || '').trim();
    if (!targetId) return fail(res, 400, 'Missing user id');
    const payload = adminUserUpdateSchema.parse(req.body || {});
    const target = await prisma.user.findFirst({ where: { id: targetId, deletedAt: null } });
    if (!target) return fail(res, 404, 'User not found');
    if (target.id === req.user.id && payload.role && payload.role !== 'admin') return fail(res, 400, 'You cannot remove your own admin role.');
    if (target.id === req.user.id && payload.status === 'suspended') return fail(res, 400, 'You cannot suspend your own admin account.');

    const firstName = payload.firstName ?? payload.first_name;
    const lastName = payload.lastName ?? payload.last_name;
    const displayName = payload.displayName ?? payload.display_name;
    const data = {};
    if (firstName !== undefined) data.firstName = firstName;
    if (lastName !== undefined) data.lastName = lastName;
    if (displayName !== undefined) data.displayName = displayName || [firstName ?? target.firstName, lastName ?? target.lastName].filter(Boolean).join(' ').trim();
    else if (firstName !== undefined || lastName !== undefined) data.displayName = [firstName ?? target.firstName, lastName ?? target.lastName].filter(Boolean).join(' ').trim();
    if (payload.email !== undefined) data.email = payload.email.toLowerCase();
    if (payload.phone !== undefined) data.phone = payload.phone || null;
    if (payload.role !== undefined) data.role = payload.role;
    if (payload.status !== undefined) data.status = payload.status;
    if (payload.city !== undefined) data.city = payload.city || null;

    const photo = payload.photo ?? payload.profileImageId ?? payload.profile_image_id;
    const businessName = payload.businessName ?? payload.business_name;
    const businessAbout = payload.businessAbout ?? payload.business_about;
    const businessLogo = payload.businessLogo ?? payload.business_logo;

    const profileFlagUpdates = {};
    const migrationRequired = payload.migration_onboarding_required ?? payload.migrationOnboardingRequired;
    const paymentRequired = payload.payment_method_required ?? payload.paymentMethodRequired;
    if (migrationRequired !== undefined) profileFlagUpdates.migration_onboarding_required = Boolean(migrationRequired);
    if (paymentRequired !== undefined) profileFlagUpdates.payment_method_required = Boolean(paymentRequired);

    const updated = await prisma.$transaction(async (tx) => {
      if (Object.keys(data).length) {
        await tx.user.update({ where: { id: targetId }, data });
      }
      if (payload.address !== undefined || payload.about !== undefined || payload.role !== undefined || photo !== undefined || businessName !== undefined || businessAbout !== undefined || businessLogo !== undefined || Object.keys(profileFlagUpdates).length) {
        const existingProfile = await tx.userProfile.findUnique({ where: { userId: targetId } });
        const metadata = Object.assign({}, userProfileMetadata(existingProfile), profileFlagUpdates);
        if (photo !== undefined) metadata.photo = photo || '';
        if (businessLogo !== undefined) metadata.business_logo = businessLogo || '';
        const profileData = { metadata };
        if (payload.address !== undefined) profileData.address = payload.address || null;
        if (payload.about !== undefined) profileData.about = payload.about || null;
        if (payload.role !== undefined) profileData.type = payload.role === 'employer' ? 'business' : (payload.role === 'neighbor' ? 'neighbor' : null);
        if (businessName !== undefined) profileData.businessName = businessName || null;
        if (businessAbout !== undefined) profileData.businessAbout = businessAbout || null;
        if (payload.phone !== undefined) profileData.businessPhone = payload.phone || null;
        if (payload.address !== undefined) profileData.businessAddress = payload.address || null;
        if (payload.city !== undefined) profileData.businessCity = payload.city || null;
        await tx.userProfile.upsert({
          where: { userId: targetId },
          create: Object.assign({ userId: targetId }, profileData),
          update: profileData,
        });
      }
      return tx.user.findUnique({
        where: { id: targetId },
        include: { userProfile: true, studentProfiles: { where: { deletedAt: null }, include: { services: { where: { deletedAt: null } } }, take: 1 } },
      });
    });

    await writeAuditLog({ userId: req.user.id, action: 'admin.user.update', entityType: 'user', entityId: targetId, payload: { before: { role: target.role, status: target.status }, after: { role: updated.role, status: updated.status } } });
    return ok(res, serializeAdminUser(updated));
  } catch (error) {
    if (error?.code === 'P2002') return fail(res, 409, 'That email is already in use.');
    const message = error?.name === 'ZodError' ? 'Please check the user fields and try again.' : 'Unable to update user';
    return fail(res, 400, message, error.message);
  }
});

router.delete('/admin/users/:id', requireAuth, requireRoles(['admin']), async (req, res) => {
  try {
    const targetId = String(req.params.id || '').trim();
    if (!targetId) return fail(res, 400, 'User id is required');
    if (targetId === req.user.id) return fail(res, 400, 'Admins cannot delete their own account from the admin console.');

    const user = await prisma.user.findUnique({
      where: { id: targetId },
      include: { studentProfiles: { include: { services: true } } },
    });
    if (!user || user.deletedAt) return fail(res, 404, 'User not found');

    const now = new Date();
    const anonymizedEmail = `deleted+${user.id}@deleted.cogocity.local`;

    await prisma.$transaction(async (tx) => {
      const profileIds = user.studentProfiles.map((profile) => profile.id);

      if (profileIds.length) {
        await tx.service.updateMany({
          where: { profileId: { in: profileIds }, deletedAt: null },
          data: { deletedAt: now, isActive: false },
        });
        await tx.studentProfile.updateMany({
          where: { id: { in: profileIds }, deletedAt: null },
          data: { deletedAt: now, isActive: false },
        });
      }

      await tx.job.updateMany({
        where: { createdBy: user.id, deletedAt: null },
        data: { deletedAt: now, status: 'closed' },
      });
      await tx.communityPost.updateMany({
        where: { authorId: user.id, deletedAt: null },
        data: { deletedAt: now },
      });
      await tx.application.updateMany({
        where: { studentId: user.id, deletedAt: null },
        data: { deletedAt: now, status: 'withdrawn' },
      });
      await tx.refreshToken.deleteMany({ where: { userId: user.id } });
      await tx.passwordResetToken.deleteMany({ where: { userId: user.id } });
      await tx.userProfile.deleteMany({ where: { userId: user.id } });
      await tx.user.update({
        where: { id: user.id },
        data: {
          email: anonymizedEmail,
          firstName: 'Deleted',
          lastName: 'User',
          displayName: 'Deleted User',
          phone: null,
          city: null,
          dateOfBirth: null,
          profileImageId: null,
          status: 'suspended',
          deletedAt: now,
          stripeDefaultPaymentMethodId: null,
          stripePaymentSetupStatus: 'not_started',
        },
      });
    });

    await writeAuditLog({ userId: req.user.id, action: 'admin.user.delete', entityType: 'user', entityId: user.id });
    return ok(res, { deleted: true, id: user.id });
  } catch (error) {
    if (error?.code === 'P2002') return fail(res, 409, 'Unable to anonymize account email.');
    return fail(res, 500, 'Unable to delete user', error.message);
  }
});

router.delete('/me', requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { studentProfiles: { include: { services: true } } },
    });
    if (!user || user.deletedAt) return fail(res, 404, 'User not found');

    const now = new Date();
    const anonymizedEmail = `deleted+${user.id}@deleted.cogocity.local`;

    await prisma.$transaction(async (tx) => {
      const profileIds = user.studentProfiles.map((profile) => profile.id);

      if (profileIds.length) {
        await tx.service.updateMany({
          where: { profileId: { in: profileIds }, deletedAt: null },
          data: { deletedAt: now, isActive: false },
        });
        await tx.studentProfile.updateMany({
          where: { id: { in: profileIds }, deletedAt: null },
          data: { deletedAt: now, isActive: false },
        });
      }

      await tx.job.updateMany({
        where: { createdBy: user.id, deletedAt: null },
        data: { deletedAt: now, status: 'closed' },
      });
      await tx.communityPost.updateMany({
        where: { authorId: user.id, deletedAt: null },
        data: { deletedAt: now },
      });
      await tx.application.updateMany({
        where: { studentId: user.id, deletedAt: null },
        data: { deletedAt: now, status: 'withdrawn' },
      });
      await tx.refreshToken.deleteMany({ where: { userId: user.id } });
      await tx.passwordResetToken.deleteMany({ where: { userId: user.id } });
      await tx.userProfile.deleteMany({ where: { userId: user.id } });
      await tx.user.update({
        where: { id: user.id },
        data: {
          email: anonymizedEmail,
          firstName: 'Deleted',
          lastName: 'User',
          displayName: 'Deleted User',
          phone: null,
          city: null,
          dateOfBirth: null,
          profileImageId: null,
          status: 'suspended',
          deletedAt: now,
          stripeDefaultPaymentMethodId: null,
          stripePaymentSetupStatus: 'not_started',
        },
      });
    });

    await writeAuditLog({ userId: user.id, action: 'auth.user.delete', entityType: 'user', entityId: user.id });
    return ok(res, { deleted: true });
  } catch (error) {
    if (error?.code === 'P2002') return fail(res, 409, 'Unable to anonymize account email.');
    return fail(res, 500, 'Unable to delete account', error.message);
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
