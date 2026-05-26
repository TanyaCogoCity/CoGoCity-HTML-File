function stripePayeePayoutReady(user = {}) {
  return Boolean(user.stripeAccountId && user.stripePayoutsEnabled && user.stripeDetailsSubmitted);
}

function payoutSafetyRequirementsForUser(user = {}) {
  return {
    payee_id: user.id || null,
    stripe_account_id: user.stripeAccountId || null,
    connect_onboarding_status: user.stripeConnectOnboardingStatus || 'not_started',
    charges_enabled: Boolean(user.stripeChargesEnabled),
    payouts_enabled: Boolean(user.stripePayoutsEnabled),
    details_submitted: Boolean(user.stripeDetailsSubmitted),
    payout_ready: stripePayeePayoutReady(user),
    sensitive_info_custodian: 'stripe_connect',
    stores_sensitive_tax_identity_locally: false,
  };
}

async function recordPayoutValidation({ prisma, transactionId, status, details }) {
  if (!transactionId) return null;
  return prisma.transaction.update({
    where: { id: transactionId },
    data: {
      payoutValidationStatus: status,
      payoutValidationCheckedAt: new Date(),
      payoutValidationDetails: details || {},
    },
  });
}

async function validateProjectPayoutSafety({ prisma, project, transaction = null, allowAdminBypass = false, user = null }) {
  if (!project) return { ok: false, status: 404, message: 'Project not found' };
  if (allowAdminBypass && user?.role === 'admin') return { ok: true, bypassed: true };

  const student = project.student || (project.studentId ? await prisma.user.findUnique({ where: { id: project.studentId } }) : null);
  const requirements = payoutSafetyRequirementsForUser(student || { id: project.studentId });
  const tx = transaction || project.transaction || null;

  if (!requirements.payout_ready) {
    if (tx?.id) await recordPayoutValidation({ prisma, transactionId: tx.id, status: 'blocked', details: requirements });
    return {
      ok: false,
      status: 409,
      message: 'Student payout setup must be completed in Stripe before paid project funds can be collected or released.',
      requirements,
    };
  }

  if (tx?.id) await recordPayoutValidation({ prisma, transactionId: tx.id, status: 'ready', details: requirements });
  return { ok: true, requirements };
}

module.exports = {
  payoutSafetyRequirementsForUser,
  recordPayoutValidation,
  stripePayeePayoutReady,
  validateProjectPayoutSafety,
};
