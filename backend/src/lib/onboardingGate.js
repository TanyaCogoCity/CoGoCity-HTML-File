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

function onboardingRequirementsForUser(user = {}, profile = null) {
  const metadata = userProfileMetadata(profile || user.userProfile);
  const profileReviewRequired = truthyFlag(metadata.migration_onboarding_required) && !metadata.migration_onboarding_completed_at;
  const paymentMethodRequired = ['employer', 'neighbor'].includes(user.role)
    && !stripePayerReady(user)
    && metadata.payment_method_required !== false;

  return {
    profile_review_required: profileReviewRequired,
    profile_review_completed_at: metadata.migration_onboarding_completed_at || null,
    payment_method_required: paymentMethodRequired,
    payment_method_ready: stripePayerReady(user),
  };
}

async function requirePlatformReady({ prisma, user, requirePayment = true }) {
  if (!user || user.role === 'admin') return { ok: true };
  const profile = await prisma.userProfile.findUnique({ where: { userId: user.id } });
  const requirements = onboardingRequirementsForUser(user, profile);
  if (requirements.profile_review_required) {
    return { ok: false, status: 409, message: 'Please update and confirm your profile before using the platform.', requirements };
  }
  if (requirePayment && requirements.payment_method_required) {
    return { ok: false, status: 402, message: 'Please add a payment method before using hiring features.', requirements };
  }
  return { ok: true, requirements };
}

module.exports = {
  onboardingRequirementsForUser,
  requirePlatformReady,
  stripePayerReady,
  userProfileMetadata,
};
