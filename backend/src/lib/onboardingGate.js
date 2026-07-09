function userProfileMetadata(profile) {
  return profile && typeof profile.metadata === 'object' && profile.metadata && !Array.isArray(profile.metadata)
    ? profile.metadata
    : {};
}

function truthyFlag(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function stripePayerReady(user = {}) {
  return Boolean(user.stripeCustomerId && user.stripeDefaultPaymentMethodId && user.stripePaymentSetupStatus === 'complete');
}

function stripeConnectReady(user = {}) {
  return Boolean(user.stripeAccountId && user.stripePayoutsEnabled && user.stripeDetailsSubmitted);
}

function present(value) {
  return String(value || '').trim().length > 0;
}

function profileCompletenessRequirements(user = {}, profile = null) {
  const missing = [];
  const role = String(user.role || '').toLowerCase();
  if (!['student', 'employer', 'neighbor'].includes(role)) return { complete: true, missing };
  const metadata = userProfileMetadata(profile);

  if (!present(profile?.about)) missing.push('about');
  if (!present(metadata.photo) && !present(profile?.avatar)) missing.push('profile_image');
  if (!present(user.phone)) missing.push('phone');
  if (!present(profile?.address)) missing.push('address');

  if (role === 'employer') {
    if (!present(profile?.businessName)) missing.push('business_name');
    if (!present(profile?.businessAbout)) missing.push('business_about');
    if (!present(metadata.business_logo)) missing.push('business_logo');
    if (!present(profile?.businessAddress)) missing.push('business_address');
  }

  return {
    complete: missing.length === 0,
    missing,
  };
}

function onboardingRequirementsForUser(user = {}, profile = null, options = {}) {
  const metadata = userProfileMetadata(profile || user.userProfile);
  const profileReviewRequired = truthyFlag(metadata.migration_onboarding_required) && !metadata.migration_onboarding_completed_at;
  const profileCompleteness = profileCompletenessRequirements(user, profile || user.userProfile);
  const paymentRoleRequired = options.requirePaymentForAllRoles
    ? user.role !== 'admin'
    : ['employer', 'neighbor'].includes(user.role);
  const paymentMethodRequired = paymentRoleRequired
    && !stripePayerReady(user)
    && (options.requirePaymentForAllRoles || options.requirePaymentStrict || metadata.payment_method_required !== false);
  const payoutSetupRequired = user.role === 'student'
    && !stripeConnectReady(user)
    && metadata.payout_setup_required !== false;

  return {
    profile_review_required: profileReviewRequired,
    profile_review_completed_at: metadata.migration_onboarding_completed_at || null,
    profile_required_fields_missing: profileCompleteness.missing,
    profile_required_fields_complete: profileCompleteness.complete,
    payment_method_required: paymentMethodRequired,
    payment_method_ready: stripePayerReady(user),
    payout_setup_required: payoutSetupRequired,
    payout_setup_ready: stripeConnectReady(user),
  };
}

async function requirePlatformReady({ prisma, user, requirePayment = true, requirePaymentForAllRoles = false, requirePaymentStrict = false, requirePayout = false }) {
  if (!user || user.role === 'admin') return { ok: true };
  const profile = await prisma.userProfile.findUnique({ where: { userId: user.id } });
  const requirements = onboardingRequirementsForUser(user, profile, { requirePaymentForAllRoles, requirePaymentStrict });
  if (requirements.profile_review_required) {
    return { ok: false, status: 409, message: 'Please update and confirm your profile before using the platform.', requirements };
  }
  if (!requirements.profile_required_fields_complete) {
    return { ok: false, status: 409, message: 'Please complete all required profile and contact information before using this feature.', requirements };
  }
  if (requirePayment && requirements.payment_method_required) {
    return { ok: false, status: 402, message: 'Please add a payment method before using this feature.', requirements };
  }
  if (requirePayout && requirements.payout_setup_required) {
    return { ok: false, status: 402, message: 'Please complete Stripe Connect payout setup before using this feature.', requirements };
  }
  return { ok: true, requirements };
}

module.exports = {
  onboardingRequirementsForUser,
  requirePlatformReady,
  stripePayerReady,
  stripeConnectReady,
  userProfileMetadata,
  profileCompletenessRequirements,
};
