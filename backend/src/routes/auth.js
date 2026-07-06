const crypto = require('crypto');
const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const config = require('../config');
const { ok, created, fail } = require('../lib/http');
const { normalizeRegisterPayload, normalizeServicePayload, serializeService } = require('../lib/compat');
const { hashPassword, comparePassword, signAccessToken, signRefreshToken, hashToken, verifyRefreshToken } = require('../lib/auth');
const { requireAuth, requireRoles } = require('../middleware/auth');
const { writeAuditLog } = require('../lib/audit');
const { onboardingRequirementsForUser, userProfileMetadata } = require('../lib/onboardingGate');
const { sendEmail, buildAppLink } = require('../lib/email');
const { notifyAdminNewUser } = require('../lib/adminEmails');
const { maybeSendOnboardingWelcomeEmail } = require('../lib/welcomeEmails');

const router = express.Router();

const US_ONLY_SIGNUP_MESSAGE = 'Thanks for your interest in CoGo City. At this moment, we can only support users and opportunities within the United States, but we hope to expand to other countries soon.';
const DELETED_ACCOUNT_REACTIVATION_MESSAGE = 'This email is connected to a deleted CoGo City account. Please reset your password to reactivate your account.';
const EMAIL_VERIFICATION_REQUIRED_MESSAGE = 'Please verify your email before signing in. Check your inbox for the CoGo City confirmation link.';
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
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

function normalizeEmail(value = '') {
  return String(value || '').trim().toLowerCase();
}

function reactivationEmailHash(email = '') {
  const normalized = normalizeEmail(email);
  if (!normalized) return '';
  return crypto.createHmac('sha256', config.deletedEmailHashSecret).update(normalized).digest('hex');
}

function reactivationProfileMetadata(existing = {}, extras = {}) {
  return {
    ...(existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}),
    ...extras,
    migration_onboarding_required: true,
    reactivated_account_review_required: true,
  };
}

function userDisplayName(user = {}) {
  return String(user.displayName || [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || '').trim();
}

function isDeletedPlaceholderName(name = '') {
  return /^deleted\s+user$/i.test(String(name || '').trim());
}

function isPurgeableStagingTestUser(user = {}) {
  const email = normalizeEmail(user.email);
  const firstName = String(user.firstName || '').trim();
  return email.startsWith('cogo-db-test-')
    || email.startsWith('codex-')
    || email.startsWith('stripe-smoke-')
    || email.startsWith('tanya+pmtest-')
    || email.startsWith('qa.')
    || email.startsWith('qa-')
    || /qa/i.test(firstName);
}

function nameFromEmail(email = '') {
  const local = String(email || '').split('@')[0] || '';
  const first = local.split(/[._+\-\s]+/).find(Boolean) || '';
  if (!first) return 'there';
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

async function preserveDeletedUserIdentity(tx, user = {}) {
  const originalName = userDisplayName(user);
  const payload = {
    user_id: user.id,
    first_name: user.firstName || '',
    last_name: user.lastName || '',
    display_name: originalName,
    email_hash: reactivationEmailHash(user.email),
    role: user.role,
    deleted_at: new Date().toISOString(),
  };
  await tx.syncRecord.upsert({
    where: { entity_recordId: { entity: 'deleted_user_identity', recordId: user.id } },
    create: { entity: 'deleted_user_identity', recordId: user.id, payload },
    update: { payload, deletedAt: null },
  });
}

async function passwordResetDisplayName(user = {}, email = '') {
  const currentName = userDisplayName(user);
  if (currentName && !isDeletedPlaceholderName(currentName) && !/@deleted\.cogocity\.local$/i.test(currentName)) return currentName;

  const identity = user?.id
    ? await prisma.syncRecord.findUnique({ where: { entity_recordId: { entity: 'deleted_user_identity', recordId: user.id } } })
    : null;
  const savedName = identity?.payload?.display_name || [identity?.payload?.first_name, identity?.payload?.last_name].filter(Boolean).join(' ');
  if (savedName && !isDeletedPlaceholderName(savedName)) return savedName;

  return nameFromEmail(email || user.email);
}

async function deletedUserIdentityPayload(tx, userId = '') {
  if (!userId) return null;
  const identity = await tx.syncRecord.findUnique({
    where: { entity_recordId: { entity: 'deleted_user_identity', recordId: userId } },
  });
  return identity?.payload && typeof identity.payload === 'object' ? identity.payload : null;
}

function restoredDeletedUserNameData(identity = {}) {
  const firstName = String(identity.first_name || '').trim();
  const lastName = String(identity.last_name || '').trim();
  const displayName = String(identity.display_name || [firstName, lastName].filter(Boolean).join(' ')).trim();
  const data = {};
  if (firstName && !/^deleted$/i.test(firstName)) data.firstName = firstName;
  if (lastName && !/^user$/i.test(lastName)) data.lastName = lastName;
  if (displayName && !isDeletedPlaceholderName(displayName)) data.displayName = displayName;
  return data;
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
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">Reset your CoGo City password</div>
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

function emailVerificationEmailHtml({ displayName, verificationUrl }) {
  const safeName = String(displayName || 'there').replace(/[<>&"']/g, '');
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#18212f;max-width:600px;margin:0 auto;padding:24px">
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">Confirm your CoGo City email</div>
      <h2 style="margin:0 0 12px;color:#18212f">Confirm your CoGo City email</h2>
      <p style="margin:0 0 16px">Hi ${safeName},</p>
      <p style="margin:0 0 20px">Please confirm this email address before signing in to CoGo City. This link expires in 24 hours.</p>
      <p style="margin:0 0 24px">
        <a href="${verificationUrl}" style="display:inline-block;background:#2251ff;color:white;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600">Confirm Email</a>
      </p>
      <p style="font-size:13px;color:#667085;margin:0 0 12px">If you did not create a CoGo City account, you can ignore this email.</p>
      <p style="font-size:12px;color:#667085;word-break:break-all;margin-top:24px">${verificationUrl}</p>
    </div>
  `;
}

function accountDeletedEmailHtml({ displayName, signupUrl }) {
  const safeName = String(displayName || 'there').replace(/[<>&"']/g, '');
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#18212f;max-width:600px;margin:0 auto;padding:24px">
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">Your CoGo City profile was deleted</div>
      <h2 style="margin:0 0 12px;color:#18212f">Your CoGo City profile was deleted</h2>
      <p style="margin:0 0 16px">Hi ${safeName},</p>
      <p style="margin:0 0 16px">This confirms that your CoGo City profile has been deleted.</p>
      <p style="margin:0 0 20px">If you decide to come back, you can sign up again at any time.</p>
      <p style="margin:0 0 24px">
        <a href="${signupUrl}" style="display:inline-block;background:#2251ff;color:white;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600">Visit CoGo City</a>
      </p>
      <p style="font-size:13px;color:#667085;margin:0">If you did not delete your profile, please contact CoGo City support.</p>
    </div>
  `;
}

function isEmailVerified(user = {}) {
  return Boolean(user.emailVerifiedAt || user.emailVerificationStatus === 'verified');
}

async function createEmailVerificationToken(tx, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);
  const tokenRecord = await tx.emailVerificationToken.create({ data: { userId, tokenHash, expiresAt } });
  return { token, tokenRecord, expiresAt };
}

async function sendEmailVerificationEmail({ user, token, tokenRecord, expiresAt }) {
  const verificationUrl = buildAppLink(`/#/verify-email?token=${encodeURIComponent(token)}`);
  const displayName = userDisplayName(user) || nameFromEmail(user.email);
  const subject = 'Confirm your CoGo City email';
  const emailResult = await sendEmail({
    to: { email: user.email, name: displayName },
    subject,
    htmlContent: emailVerificationEmailHtml({ displayName, verificationUrl }),
    textContent: `Confirm your CoGo City email\n\nOpen this link before signing in. It expires in 24 hours:\n${verificationUrl}\n\nIf you did not create this account, ignore this email.`,
  });

  await prisma.syncRecord.create({
    data: {
      entity: 'email_verification_email',
      recordId: tokenRecord.id,
      payload: {
        user_id: user.id,
        email: user.email,
        subject,
        status: emailResult?.skipped ? 'skipped' : 'sent',
        result: emailResult || null,
        requested_at: new Date().toISOString(),
        expires_at: expiresAt.toISOString(),
      },
    },
  }).catch((error) => console.error('email_verification_email_receipt_failed', error.message));

  return emailResult;
}

async function sendAccountDeletedEmail(user) {
  const displayName = userDisplayName(user) || nameFromEmail(user.email);
  const signupUrl = buildAppLink('/#/');
  const subject = 'Your CoGo City profile was deleted';
  const emailResult = await sendEmail({
    to: { email: user.email, name: displayName },
    subject,
    htmlContent: accountDeletedEmailHtml({ displayName, signupUrl }),
    textContent: `Your CoGo City profile was deleted\n\nThis confirms that your CoGo City profile has been deleted. If you decide to come back, you can sign up again at any time:\n${signupUrl}\n\nIf you did not delete your profile, please contact CoGo City support.`,
  });

  await prisma.syncRecord.upsert({
    where: { entity_recordId: { entity: 'account_deleted_email', recordId: user.id } },
    create: {
      entity: 'account_deleted_email',
      recordId: user.id,
      payload: {
        user_id: user.id,
        email: user.email,
        subject,
        status: emailResult?.skipped ? 'skipped' : 'sent',
        result: emailResult || null,
        requested_at: new Date().toISOString(),
      },
    },
    update: {
      payload: {
        user_id: user.id,
        email: user.email,
        subject,
        status: emailResult?.skipped ? 'skipped' : 'sent',
        result: emailResult || null,
        requested_at: new Date().toISOString(),
      },
      deletedAt: null,
    },
  }).catch((error) => console.error('account_deleted_email_receipt_failed', error.message));

  return emailResult;
}

async function issueAuthSession(user) {
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
  return { accessToken, refreshToken };
}

function buildUserProfileData(userId, payload = {}) {
  const profile = payload.profile || {};
  const business = payload.businessProfile || profile.businessProfile || {};
  const birthDate = profile.birthDate || profile.birth_date || profile.birthday || payload.dateOfBirth || payload.date_of_birth || '';
  const metadata = {
    photo: profile.photo || payload.photo || '',
    profile_images: profile.profileImages || [],
    video_url: profile.video_url || profile.videoUrl || '',
    video_type: profile.video_type || profile.videoType || '',
    video_id: profile.video_id || profile.videoId || '',
    birth_date: birthDate || '',
    birthday: birthDate || '',
    birth_year: profile.birthYear || profile.birth_year || (birthDate ? String(birthDate).slice(0, 4) : ''),
    private_email: profile.privateEmail || profile.private_email || payload.email || '',
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
  student_profile: z.object({
    title: z.string().trim().optional().nullable(),
    bio: z.string().optional().nullable(),
    experience: z.string().optional().nullable(),
    school: z.string().trim().optional().nullable(),
    birth_date: z.string().trim().optional().nullable(),
    birthDate: z.string().trim().optional().nullable(),
    birth_year: z.union([z.string(), z.number()]).optional().nullable(),
    birthYear: z.union([z.string(), z.number()]).optional().nullable(),
    age: z.union([z.string(), z.number()]).optional().nullable(),
    profile_images: z.array(z.string()).optional(),
    profileImages: z.array(z.string()).optional(),
    photo: z.string().trim().optional().nullable(),
    video_url: z.string().trim().optional().nullable(),
    videoUrl: z.string().trim().optional().nullable(),
    video_type: z.string().trim().optional().nullable(),
    videoType: z.string().trim().optional().nullable(),
    video_id: z.string().trim().optional().nullable(),
    videoId: z.string().trim().optional().nullable(),
    services: z.array(z.object({
      id: z.string().trim().optional().nullable(),
      title: z.string().trim().optional().nullable(),
      description: z.string().optional().nullable(),
      rate: z.union([z.string(), z.number()]).optional().nullable(),
      hourlyRate: z.union([z.string(), z.number()]).optional().nullable(),
      hourly_rate: z.union([z.string(), z.number()]).optional().nullable(),
      location: z.string().trim().optional().nullable(),
      availability: z.string().optional().nullable(),
      images: z.array(z.string()).optional(),
      entity_images: z.array(z.string()).optional(),
      video_url: z.string().trim().optional().nullable(),
      videoUrl: z.string().trim().optional().nullable(),
      video_type: z.string().trim().optional().nullable(),
      videoType: z.string().trim().optional().nullable(),
      video_id: z.string().trim().optional().nullable(),
      videoId: z.string().trim().optional().nullable(),
    })).optional(),
  }).optional(),
  migration_onboarding_required: z.boolean().optional(),
  migrationOnboardingRequired: z.boolean().optional(),
  payment_method_required: z.boolean().optional(),
  paymentMethodRequired: z.boolean().optional(),
});

const adminUserCreateSchema = z.object({
  first_name: z.string().trim().min(1).optional(),
  firstName: z.string().trim().min(1).optional(),
  last_name: z.string().trim().min(1).optional(),
  lastName: z.string().trim().min(1).optional(),
  display_name: z.string().trim().optional(),
  displayName: z.string().trim().optional(),
  name: z.string().trim().optional(),
  email: z.string().email(),
  phone: z.string().trim().optional().nullable(),
  password: z.string().min(8),
  role: z.enum(['student', 'employer', 'neighbor', 'admin']).default('student'),
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
  const reviewRequired = onboardingRequirementsForUser(user, extras.userProfile || user.userProfile || null).profile_review_required;
  const deletedPlaceholder = /^deleted$/i.test(String(user.firstName || '').trim())
    && /^user$/i.test(String(user.lastName || '').trim());
  const firstName = deletedPlaceholder && reviewRequired ? '' : user.firstName;
  const lastName = deletedPlaceholder && reviewRequired ? '' : user.lastName;
  const displayName = deletedPlaceholder && reviewRequired ? 'Review Profile' : user.displayName;
  return {
    id: user.id,
    first_name: firstName,
    last_name: lastName,
    display_name: displayName,
    email: user.email,
    phone: user.phone,
    status: user.status,
    role: user.role,
    email_verified: isEmailVerified(user),
    email_verified_at: user.emailVerifiedAt || null,
    email_verification_status: user.emailVerificationStatus || (user.emailVerifiedAt ? 'verified' : 'pending'),
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
    const emailHash = reactivationEmailHash(payload.email);
    const exists = await prisma.user.findUnique({ where: { email: payload.email } });
    const deletedByHash = !exists && emailHash
      ? await prisma.user.findFirst({ where: { reactivationEmailHash: emailHash, deletedAt: { not: null } } })
      : null;
    const reactivationCandidate = exists || deletedByHash;
    if (reactivationCandidate?.deletedAt) return fail(res, 409, DELETED_ACCOUNT_REACTIVATION_MESSAGE);
    if (reactivationCandidate?.status !== undefined && reactivationCandidate.status !== 'active') {
      return fail(res, 403, 'This account has been suspended. Please contact support@cogocity.com for help.');
    }
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
          emailVerifiedAt: null,
          emailVerificationStatus: 'pending',
          reactivationEmailHash: null,
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

      const verificationToken = await createEmailVerificationToken(tx, user.id);
      return { user, userProfile, studentProfile, services, verificationToken };
    });

    const user = createdRecords.user;
    const emailResult = await sendEmailVerificationEmail({
      user,
      token: createdRecords.verificationToken.token,
      tokenRecord: createdRecords.verificationToken.tokenRecord,
      expiresAt: createdRecords.verificationToken.expiresAt,
    });
    await writeAuditLog({ userId: user.id, action: 'auth.register_pending_email_verification', entityType: 'user', entityId: user.id });
    if (emailResult?.skipped) return fail(res, 503, 'Email verification is not configured. Please contact support@cogocity.com for help.');

    return created(res, {
      verification_required: true,
      email: user.email,
      message: 'Account created. Please check your email and confirm it before signing in.',
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

    const email = normalizeEmail(payload.email);
    const emailHash = reactivationEmailHash(email);
    const directUser = await prisma.user.findUnique({
      where: { email },
      include: { userProfile: true, studentProfiles: { where: { deletedAt: null }, include: { services: { where: { deletedAt: null } } } } },
    });
    const deletedByHash = !directUser && emailHash
      ? await prisma.user.findFirst({
        where: { reactivationEmailHash: emailHash, deletedAt: { not: null } },
        include: { userProfile: true, studentProfiles: { where: { deletedAt: null }, include: { services: { where: { deletedAt: null } } } } },
      })
      : null;
    const user = directUser || deletedByHash;
    if (!user) return fail(res, 401, 'Invalid credentials');
    if (user.deletedAt) {
      return fail(res, 403, 'This account has been deleted. Click Forgot Password to reset your password and access your account.');
    }
    if (user.status !== 'active') {
      return fail(res, 403, 'This account has been suspended. Please contact support@cogocity.com for help.');
    }

    const valid = await comparePassword(payload.password, user.passwordHash);
    if (!valid) return fail(res, 401, 'Invalid credentials');
    if (!isEmailVerified(user)) {
      return fail(res, 403, EMAIL_VERIFICATION_REQUIRED_MESSAGE, { code: 'email_not_verified', email: user.email });
    }

    await prisma.user.update({ where: { id: user.id }, data: { lastLogin: new Date() } });

    const { accessToken, refreshToken } = await issueAuthSession(user);

    const studentProfile = user.studentProfiles?.[0] || null;
    return ok(res, {
      user: serializeUser(user, { userProfile: user.userProfile, studentProfile, services: studentProfile?.services || [] }),
      access_token: accessToken,
      refresh_token: refreshToken,
    });
  } catch (error) {
    const friendlyMessage = registerPayloadErrorMessage(error) || 'Please enter a valid email address and password.';
    return fail(res, 400, friendlyMessage, error.message);
  }
});


router.post('/email-verification/resend', async (req, res) => {
  try {
    const schema = z.object({ email: z.string().email() });
    const payload = schema.parse(req.body || {});
    const email = normalizeEmail(payload.email);
    const user = await prisma.user.findUnique({ where: { email } });

    // Always return a generic success for missing, deleted, suspended, or already verified accounts.
    if (!user || user.deletedAt || user.status !== 'active' || isEmailVerified(user)) return ok(res, { requested: true });

    const verificationToken = await prisma.$transaction(async (tx) => {
      await tx.emailVerificationToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
      return createEmailVerificationToken(tx, user.id);
    });

    const emailResult = await sendEmailVerificationEmail({
      user,
      token: verificationToken.token,
      tokenRecord: verificationToken.tokenRecord,
      expiresAt: verificationToken.expiresAt,
    });
    if (emailResult?.skipped) return fail(res, 503, 'Email verification is not configured');
    await writeAuditLog({ userId: user.id, action: 'auth.email_verification_resent', entityType: 'user', entityId: user.id });
    return ok(res, { requested: true });
  } catch (error) {
    return fail(res, 400, 'Invalid email verification request', error.message);
  }
});

router.post('/email-verification/confirm', async (req, res) => {
  try {
    const schema = z.object({ token: z.string().min(32) });
    const payload = schema.parse(req.body || {});
    const tokenHash = hashToken(payload.token);
    const verificationToken = await prisma.emailVerificationToken.findUnique({
      where: { tokenHash },
      include: { user: { include: { userProfile: true, studentProfiles: { where: { deletedAt: null }, include: { services: { where: { deletedAt: null } } } } } } },
    });
    if (!verificationToken || verificationToken.usedAt || verificationToken.expiresAt <= new Date()) return fail(res, 400, 'This email confirmation link is invalid or expired');
    if (!verificationToken.user || verificationToken.user.deletedAt || verificationToken.user.status !== 'active') return fail(res, 400, 'This email confirmation link is invalid or expired');

    const updatedUser = await prisma.$transaction(async (tx) => {
      const verifiedAt = new Date();
      await tx.emailVerificationToken.update({ where: { id: verificationToken.id }, data: { usedAt: verifiedAt } });
      await tx.emailVerificationToken.updateMany({ where: { userId: verificationToken.userId, usedAt: null, id: { not: verificationToken.id } }, data: { usedAt: verifiedAt } });
      return tx.user.update({
        where: { id: verificationToken.userId },
        data: { emailVerifiedAt: verifiedAt, emailVerificationStatus: 'verified', lastLogin: verifiedAt },
        include: { userProfile: true, studentProfiles: { where: { deletedAt: null }, include: { services: { where: { deletedAt: null } } } } },
      });
    });

    await writeAuditLog({ userId: updatedUser.id, action: 'auth.email_verified', entityType: 'user', entityId: updatedUser.id });
    await notifyAdminNewUser(updatedUser);
    await maybeSendOnboardingWelcomeEmail(updatedUser);

    const { accessToken, refreshToken } = await issueAuthSession(updatedUser);
    const studentProfile = updatedUser.studentProfiles?.[0] || null;
    return ok(res, {
      verified: true,
      user: serializeUser(updatedUser, { userProfile: updatedUser.userProfile, studentProfile, services: studentProfile?.services || [] }),
      access_token: accessToken,
      refresh_token: refreshToken,
    });
  } catch (error) {
    return fail(res, 400, 'Invalid email verification confirmation', error.message);
  }
});


router.post('/password-reset/request', async (req, res) => {
  try {
    const schema = z.object({ email: z.string().email() });
    const payload = schema.parse(req.body || {});
    const email = normalizeEmail(payload.email);
    const emailHash = reactivationEmailHash(email);
    const directUser = await prisma.user.findUnique({ where: { email } });
    const user = directUser || (emailHash
      ? await prisma.user.findFirst({ where: { reactivationEmailHash: emailHash, deletedAt: { not: null } } })
      : null);

    // Always return a generic success when the account does not exist to avoid account enumeration.
    if (!user) return ok(res, { requested: true });
    if (!user.deletedAt && user.status !== 'active') return ok(res, { requested: true });

    if (user.deletedAt && user.email !== email) {
      await prisma.user.update({
        where: { id: user.id },
        data: { email, reactivationEmailHash: emailHash || user.reactivationEmailHash || null },
      });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const resetToken = await prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash, expiresAt } });

    const resetUrl = buildAppLink(`/#/reset-password?token=${encodeURIComponent(token)}`);
    const displayName = await passwordResetDisplayName(user, email);
    const subject = 'Reset your CoGo City password';
    const emailResult = await sendEmail({
      to: { email, name: displayName },
      subject,
      htmlContent: passwordResetEmailHtml({ displayName, resetUrl }),
      textContent: `Reset your CoGo City password\n\nOpen this link to choose a new password. It expires in 60 minutes:\n${resetUrl}\n\nIf you did not request this, ignore this email.`,
    });

    await prisma.syncRecord.create({
      data: {
        entity: 'password_reset_email',
        recordId: resetToken.id,
        payload: {
          user_id: user.id,
          email,
          subject,
          status: emailResult?.skipped ? 'skipped' : 'sent',
          result: emailResult || null,
          requested_at: new Date().toISOString(),
          expires_at: expiresAt.toISOString(),
          reactivation: Boolean(user.deletedAt),
        },
      },
    }).catch((error) => console.error('password_reset_email_receipt_failed', error.message));

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
    const resetToken = await prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      include: { user: { include: { userProfile: true, studentProfiles: { where: { deletedAt: null }, include: { services: { where: { deletedAt: null } } } } } } },
    });
    if (!resetToken || resetToken.usedAt || resetToken.expiresAt <= new Date()) return fail(res, 400, 'This password reset link is invalid or expired');
    if (!resetToken.user || (!resetToken.user.deletedAt && resetToken.user.status !== 'active')) return fail(res, 400, 'This password reset link is invalid or expired');

    const passwordHash = await hashPassword(payload.new_password);
    const wasDeleted = Boolean(resetToken.user.deletedAt);
    const updatedUser = await prisma.$transaction(async (tx) => {
      const restoredNameData = wasDeleted
        ? restoredDeletedUserNameData(await deletedUserIdentityPayload(tx, resetToken.userId))
        : {};
      const user = await tx.user.update({
        where: { id: resetToken.userId },
        data: {
          ...restoredNameData,
          passwordHash,
          status: 'active',
          deletedAt: null,
          emailVerifiedAt: new Date(),
          emailVerificationStatus: 'verified',
          reactivationEmailHash: null,
        },
        include: { userProfile: true, studentProfiles: { where: { deletedAt: null }, include: { services: { where: { deletedAt: null } } } } },
      });
      const existingMetadata = user.userProfile?.metadata || {};
      if (wasDeleted) {
        const metadata = reactivationProfileMetadata(existingMetadata, { reactivated_at: new Date().toISOString() });
        if (user.userProfile) {
          await tx.userProfile.update({ where: { userId: user.id }, data: { metadata } });
        } else {
          await tx.userProfile.create({
            data: {
              userId: user.id,
              type: user.role === 'employer' ? 'business' : user.role,
              metadata,
            },
          });
        }
      }
      await tx.passwordResetToken.update({ where: { id: resetToken.id }, data: { usedAt: new Date() } });
      await tx.passwordResetToken.updateMany({ where: { userId: resetToken.userId, usedAt: null, id: { not: resetToken.id } }, data: { usedAt: new Date() } });
      await tx.refreshToken.updateMany({ where: { userId: resetToken.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      return tx.user.findUnique({
        where: { id: resetToken.userId },
        include: { userProfile: true, studentProfiles: { where: { deletedAt: null }, include: { services: { where: { deletedAt: null } } } } },
      });
    });
    await writeAuditLog({ userId: resetToken.userId, action: wasDeleted ? 'auth.user.reactivated' : 'auth.password_reset_completed', entityType: 'user', entityId: resetToken.userId });
    const { accessToken, refreshToken } = await issueAuthSession(updatedUser);
    return ok(res, {
      updated: true,
      reactivated: wasDeleted,
      user: serializeUser(updatedUser),
      access_token: accessToken,
      refresh_token: refreshToken,
    });
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

router.post('/admin/users', requireAuth, requireRoles(['admin']), async (req, res) => {
  try {
    const payload = adminUserCreateSchema.parse(req.body || {});
    const email = payload.email.toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing && !existing.deletedAt) return fail(res, 409, 'That email is already in use.');

    const nameParts = String(payload.name || '').split(/\s+/).filter(Boolean);
    const firstName = payload.firstName ?? payload.first_name ?? nameParts[0] ?? 'User';
    const lastName = payload.lastName ?? payload.last_name ?? nameParts.slice(1).join(' ') ?? '';
    const displayName = payload.displayName ?? payload.display_name ?? [firstName, lastName].filter(Boolean).join(' ').trim();
    const passwordHash = await hashPassword(payload.password);

    const createdUser = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          firstName,
          lastName,
          displayName,
          email,
          phone: payload.phone || null,
          role: payload.role,
          city: null,
          passwordHash,
          emailVerifiedAt: new Date(),
          emailVerificationStatus: 'verified',
        },
      });
      await tx.userProfile.create({
        data: {
          userId: user.id,
          type: payload.role === 'employer' ? 'business' : (payload.role === 'neighbor' ? 'neighbor' : null),
          metadata: {},
        },
      });
      return tx.user.findUnique({
        where: { id: user.id },
        include: { userProfile: true, studentProfiles: { where: { deletedAt: null }, include: { services: { where: { deletedAt: null } } }, take: 1 } },
      });
    });

    await writeAuditLog({ userId: req.user.id, action: 'admin.user.create', entityType: 'user', entityId: createdUser.id, payload: { role: createdUser.role, email: createdUser.email } });
    return created(res, serializeAdminUser(createdUser));
  } catch (error) {
    if (error?.code === 'P2002') return fail(res, 409, 'That email is already in use.');
    const message = error?.name === 'ZodError' ? 'Please check the new user fields and try again.' : 'Unable to create user';
    return fail(res, 400, message, error.message);
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

router.get('/admin/password-reset-audit', requireAuth, requireRoles(['admin']), async (req, res) => {
  try {
    const email = normalizeEmail(req.query.email || '');
    if (!email) return fail(res, 400, 'email is required');
    const emailHash = reactivationEmailHash(email);
    const directUser = await prisma.user.findUnique({ where: { email } });
    const deletedUser = emailHash
      ? await prisma.user.findFirst({ where: { reactivationEmailHash: emailHash, deletedAt: { not: null } } })
      : null;
    const user = directUser || deletedUser;
    const recentRows = await prisma.syncRecord.findMany({
      where: { entity: 'password_reset_email', deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const recentResetEmails = recentRows
      .filter((row) => normalizeEmail(row.payload?.email || '') === email)
      .slice(0, 10)
      .map((row) => ({
        id: row.recordId,
        status: row.payload?.status || '',
        requested_at: row.payload?.requested_at || row.createdAt,
        expires_at: row.payload?.expires_at || '',
        reactivation: Boolean(row.payload?.reactivation),
        provider_message_id: row.payload?.result?.messageId || '',
        skipped_reason: row.payload?.result?.reason || '',
      }));

    return ok(res, {
      email,
      account_found: Boolean(user),
      deleted: Boolean(user?.deletedAt),
      status: user?.status || '',
      user_id: user?.id || '',
      anonymized_email: user?.deletedAt ? user.email : '',
      reactivation_hash_present: Boolean(user?.reactivationEmailHash),
      recent_reset_emails: recentResetEmails,
    });
  } catch (error) {
    return fail(res, 500, 'Unable to audit password reset email', error.message);
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
      const studentPayload = payload.student_profile || null;
      if (payload.address !== undefined || payload.about !== undefined || payload.role !== undefined || photo !== undefined || businessName !== undefined || businessAbout !== undefined || businessLogo !== undefined || studentPayload || Object.keys(profileFlagUpdates).length) {
        const existingProfile = await tx.userProfile.findUnique({ where: { userId: targetId } });
        const metadata = Object.assign({}, userProfileMetadata(existingProfile), profileFlagUpdates);
        if (photo !== undefined) metadata.photo = photo || '';
        if (studentPayload) {
          const studentPhoto = studentPayload.photo || photo || '';
          const profileImages = studentPayload.profileImages || studentPayload.profile_images || (studentPhoto ? [studentPhoto] : []);
          const birthDate = studentPayload.birthDate || studentPayload.birth_date || '';
          metadata.photo = studentPhoto || metadata.photo || '';
          metadata.profile_images = profileImages;
          metadata.birth_date = birthDate;
          metadata.birthday = birthDate;
          metadata.birth_year = studentPayload.birthYear || studentPayload.birth_year || (birthDate ? String(birthDate).slice(0, 4) : '');
          metadata.video_url = studentPayload.video_url || studentPayload.videoUrl || '';
          metadata.video_type = studentPayload.video_type || studentPayload.videoType || '';
          metadata.video_id = studentPayload.video_id || studentPayload.videoId || '';
          metadata.private_email = payload.email || metadata.private_email || '';
        }
        if (businessLogo !== undefined) metadata.business_logo = businessLogo || '';
        const profileData = { metadata };
        if (payload.address !== undefined) profileData.address = payload.address || null;
        if (payload.about !== undefined) profileData.about = payload.about || null;
        if (payload.role !== undefined) profileData.type = payload.role === 'employer' ? 'business' : (payload.role === 'neighbor' ? 'neighbor' : null);
        if (studentPayload) {
          profileData.type = 'student';
          if (studentPayload.bio !== undefined) profileData.about = studentPayload.bio || null;
          if (studentPayload.school !== undefined) profileData.school = studentPayload.school || null;
          if (studentPayload.age !== undefined) profileData.age = studentPayload.age ? Number(studentPayload.age) : null;
        }
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
      if (payload.student_profile) {
        const studentPayload = payload.student_profile;
        const existingStudentProfile = await tx.studentProfile.findFirst({ where: { userId: targetId, deletedAt: null } });
        const studentProfile = existingStudentProfile
          ? await tx.studentProfile.update({
            where: { id: existingStudentProfile.id },
            data: {
              title: studentPayload.title || existingStudentProfile.title,
              bio: studentPayload.bio ?? existingStudentProfile.bio,
              experience: studentPayload.experience ?? existingStudentProfile.experience,
              isActive: true,
            },
          })
          : await tx.studentProfile.create({
            data: {
              userId: targetId,
              title: studentPayload.title || 'Student Service',
              bio: studentPayload.bio || '',
              experience: studentPayload.experience || '',
              isActive: true,
            },
          });
        const services = Array.isArray(studentPayload.services) ? studentPayload.services : [];
        for (const servicePayload of services) {
          const normalizedService = normalizeServicePayload({ ...(servicePayload || {}), profileId: studentProfile.id });
          if (!normalizedService.title || normalizedService.hourlyRate <= 0) continue;
          const serviceId = String(servicePayload.id || '').trim();
          const existingService = serviceId
            ? await tx.service.findFirst({ where: { id: serviceId, profileId: studentProfile.id, deletedAt: null } })
            : null;
          const data = {
            title: normalizedService.title,
            description: normalizedService.description,
            hourlyRate: normalizedService.hourlyRate,
            availability: normalizedService.availability,
            location: normalizedService.location,
            isActive: Boolean(normalizedService.isActive),
            metadata: normalizedService.metadata,
          };
          if (existingService) await tx.service.update({ where: { id: existingService.id }, data });
          else await tx.service.create({ data: Object.assign({ profileId: studentProfile.id }, data) });
        }
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

router.post('/admin/users/purge-staging-test-accounts', requireAuth, requireRoles(['admin']), async (req, res) => {
  try {
    const execute = req.body?.execute === true;
    const candidates = await prisma.user.findMany({
      where: {
        OR: [
          { email: { startsWith: 'cogo-db-test-' } },
          { email: { startsWith: 'codex-' } },
          { email: { startsWith: 'stripe-smoke-' } },
          { email: { startsWith: 'tanya+pmtest-' } },
          { email: { startsWith: 'qa.' } },
          { email: { startsWith: 'qa-' } },
          { firstName: { equals: 'QA', mode: 'insensitive' } },
          { firstName: { contains: 'QA', mode: 'insensitive' } },
        ],
      },
      select: { id: true, email: true, firstName: true, lastName: true, displayName: true, role: true },
    });
    const users = candidates.filter(user => user.id !== req.user.id && isPurgeableStagingTestUser(user));
    const userIds = users.map(user => user.id);
    const userSummaries = users.map(user => ({ id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, role: user.role }));

    if (!userIds.length) {
      return ok(res, {
        execute,
        plan: {
          users: [],
          counts: {
            users: 0,
            student_profiles: 0,
            services: 0,
            jobs: 0,
            community_posts: 0,
            applications: 0,
            projects: 0,
            transactions: 0,
            reviews: 0,
            conversations: 0,
            messages: 0,
            notifications: 0,
            workshops: 0,
            workshop_enrollments: 0,
            sync_records: 0,
          },
        },
        deleted: null,
      });
    }

    const studentProfiles = await prisma.studentProfile.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
    const studentProfileIds = studentProfiles.map(row => row.id);
    const services = await prisma.service.findMany({ where: { profileId: { in: studentProfileIds } }, select: { id: true } });
    const serviceIds = services.map(row => row.id);
    const jobs = await prisma.job.findMany({ where: { createdBy: { in: userIds } }, select: { id: true } });
    const jobIds = jobs.map(row => row.id);
    const communityPosts = await prisma.communityPost.findMany({ where: { authorId: { in: userIds } }, select: { id: true } });
    const communityPostIds = communityPosts.map(row => row.id);
    const applications = await prisma.application.findMany({
      where: { OR: [{ studentId: { in: userIds } }, { jobId: { in: jobIds } }] },
      select: { id: true },
    });
    const applicationIds = applications.map(row => row.id);
    const projects = await prisma.project.findMany({
      where: {
        OR: [
          { employerId: { in: userIds } },
          { studentId: { in: userIds } },
          { jobId: { in: jobIds } },
          { applicationId: { in: applicationIds } },
          { serviceId: { in: serviceIds } },
        ],
      },
      select: { id: true },
    });
    const projectIds = projects.map(row => row.id);
    const workshops = await prisma.workshop.findMany({ where: { createdBy: { in: userIds } }, select: { id: true } });
    const workshopIds = workshops.map(row => row.id);
    const conversationParticipants = await prisma.conversationParticipant.findMany({ where: { userId: { in: userIds } }, select: { conversationId: true } });
    const messageConversations = await prisma.message.findMany({ where: { senderId: { in: userIds } }, select: { conversationId: true } });
    const projectConversations = await prisma.conversation.findMany({ where: { projectId: { in: projectIds } }, select: { id: true } });
    const conversationIds = [...new Set([
      ...conversationParticipants.map(row => row.conversationId),
      ...messageConversations.map(row => row.conversationId),
      ...projectConversations.map(row => row.id),
    ])];
    const entityIds = [...new Set([
      ...userIds,
      ...studentProfileIds,
      ...serviceIds,
      ...jobIds,
      ...communityPostIds,
      ...applicationIds,
      ...projectIds,
      ...workshopIds,
    ])];
    const entityTextNeedles = [...new Set([
      ...entityIds,
      ...users.map(user => normalizeEmail(user.email)).filter(Boolean),
    ])];
    const syncRows = await prisma.syncRecord.findMany({
      where: { deletedAt: null },
      select: { entity: true, recordId: true, payload: true },
    });
    const syncRecordKeys = syncRows
      .filter(row => entityTextNeedles.some(needle => {
        if (!needle) return false;
        if (String(row.recordId || '').includes(needle)) return true;
        return JSON.stringify(row.payload || {}).includes(needle);
      }))
      .map(row => ({ entity: row.entity, recordId: row.recordId }));

    const plan = {
      users: userSummaries,
      counts: {
        users: userIds.length,
        student_profiles: studentProfileIds.length,
        services: serviceIds.length,
        jobs: jobIds.length,
        community_posts: communityPostIds.length,
        applications: applicationIds.length,
        projects: projectIds.length,
        transactions: 0,
        reviews: 0,
        conversations: conversationIds.length,
        messages: 0,
        notifications: 0,
        workshops: workshopIds.length,
        workshop_enrollments: 0,
        sync_records: syncRecordKeys.length,
      },
    };
    if (!execute) return ok(res, { execute: false, plan, deleted: null });

    const deleted = await prisma.$transaction(async (tx) => {
      const result = {};
      for (const key of syncRecordKeys) {
        await tx.syncRecord.updateMany({
          where: { entity: key.entity, recordId: key.recordId },
          data: { deletedAt: new Date() },
        });
      }
      result.syncRecords = { count: syncRecordKeys.length };
      result.workshopEnrollments = await tx.workshopEnrollment.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { workshopId: { in: workshopIds } }] } });
      result.entityMedia = await tx.entityMedia.deleteMany({ where: { entityId: { in: entityIds } } });
      result.messages = await tx.message.deleteMany({ where: { OR: [{ senderId: { in: userIds } }, { conversationId: { in: conversationIds } }] } });
      result.conversationParticipants = await tx.conversationParticipant.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { conversationId: { in: conversationIds } }] } });
      result.conversations = await tx.conversation.deleteMany({ where: { id: { in: conversationIds } } });
      result.notifications = await tx.notification.deleteMany({ where: { userId: { in: userIds } } });
      result.refreshTokens = await tx.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
      result.passwordResetTokens = await tx.passwordResetToken.deleteMany({ where: { userId: { in: userIds } } });
      result.reviews = await tx.review.deleteMany({ where: { OR: [{ projectId: { in: projectIds } }, { reviewerId: { in: userIds } }, { studentId: { in: userIds } }, { serviceId: { in: serviceIds } }] } });
      result.transactions = await tx.transaction.deleteMany({ where: { OR: [{ projectId: { in: projectIds } }, { payerId: { in: userIds } }, { payeeId: { in: userIds } }] } });
      result.projects = await tx.project.deleteMany({ where: { id: { in: projectIds } } });
      result.applications = await tx.application.deleteMany({ where: { OR: [{ id: { in: applicationIds } }, { studentId: { in: userIds } }, { jobId: { in: jobIds } }] } });
      result.jobs = await tx.job.deleteMany({ where: { id: { in: jobIds } } });
      result.communityPosts = await tx.communityPost.deleteMany({ where: { id: { in: communityPostIds } } });
      result.workshops = await tx.workshop.deleteMany({ where: { id: { in: workshopIds } } });
      result.services = await tx.service.deleteMany({ where: { id: { in: serviceIds } } });
      result.studentProfiles = await tx.studentProfile.deleteMany({ where: { id: { in: studentProfileIds } } });
      result.userProfiles = await tx.userProfile.deleteMany({ where: { userId: { in: userIds } } });
      result.auditLogs = await tx.auditLog.deleteMany({ where: { userId: { in: userIds } } });
      result.users = await tx.user.deleteMany({ where: { id: { in: userIds } } });
      return result;
    }, { timeout: 120000 });

    await writeAuditLog({
      userId: req.user.id,
      action: 'admin.user.purge_staging_test_accounts',
      entityType: 'user',
      entityId: 'staging_test_accounts',
      payload: { users: plan.users, counts: plan.counts, deleted },
    });
    return ok(res, { execute: true, plan, deleted });
  } catch (error) {
    return fail(res, 500, 'Unable to purge staging test accounts', error.message);
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
    const emailHash = reactivationEmailHash(user.email);

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
      await preserveDeletedUserIdentity(tx, user);
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
          reactivationEmailHash: emailHash || null,
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
    const emailHash = reactivationEmailHash(user.email);

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
      await preserveDeletedUserIdentity(tx, user);
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
          reactivationEmailHash: emailHash || null,
          stripeDefaultPaymentMethodId: null,
          stripePaymentSetupStatus: 'not_started',
        },
      });
    });

    await sendAccountDeletedEmail(user).catch((error) => console.error('account_deleted_email_failed', error.message));
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
