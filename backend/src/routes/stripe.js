const express = require('express');
const Stripe = require('stripe');
const { prisma } = require('../lib/prisma');
const { ok, fail } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');
const { getDirectJobPackage, applyDirectJobPackagePricing } = require('../lib/directJobPackages');
const { calculateHourlyProjectFees, calculateJobPlacementFees } = require('../lib/platformFees');
const config = require('../config');
const { writeAuditLog } = require('../lib/audit');
const { createNotification, createNotifications } = require('../lib/notifications');
const { notificationType, serializeJob } = require('../lib/compat');
const { payoutSafetyRequirementsForUser, validateProjectPayoutSafety } = require('../lib/payoutSafety');
const { requirePlatformReady } = require('../lib/onboardingGate');

const stripe = config.stripeSecretKey ? new Stripe(config.stripeSecretKey, { apiVersion: '2024-06-20' }) : null;
const router = express.Router();

function toCents(amount) {
  return Math.max(1, Math.round(Number(amount || 0) * 100));
}

function fromCents(amount) {
  return Number(((Number(amount || 0) || 0) / 100).toFixed(2));
}

function paymentStatusForIntent(paymentIntent) {
  if (paymentIntent.status === 'requires_capture') return 'funded';
  if (paymentIntent.status === 'succeeded') return 'paid';
  if (paymentIntent.status === 'canceled') return 'failed';
  return 'pending';
}

function marketplaceAmounts(tx, overrides = {}) {
  const amountTotal = Number(overrides.amountTotal ?? overrides.amount_total ?? tx?.amountTotal ?? 0);
  const storedPlatformFee = Number(tx?.platformFee || 0);
  const storedStudentPayout = Number(tx?.studentPayout || 0);
  let studentPayout = Number(overrides.studentPayout ?? overrides.student_payout ?? storedStudentPayout);
  let platformFee = Number(overrides.platformFee ?? overrides.platform_fee_total ?? overrides.platformFeeTotal ?? storedPlatformFee);

  if (!Number.isFinite(studentPayout) || studentPayout <= 0) studentPayout = Math.max(0, amountTotal - platformFee);
  if (!Number.isFinite(platformFee) || platformFee < 0) platformFee = Math.max(0, amountTotal - studentPayout);
  if (studentPayout + platformFee > amountTotal) platformFee = Math.max(0, amountTotal - studentPayout);

  return {
    amountTotal,
    amountTotalCents: toCents(amountTotal),
    studentPayout,
    studentPayoutCents: toCents(studentPayout),
    platformFee,
    platformFeeCents: Math.max(0, Math.round(platformFee * 100)),
  };
}

function marketplacePaymentIntentData({ tx, project, student, overrides = {}, type = 'project_escrow' }) {
  const amounts = marketplaceAmounts(tx, overrides);
  return {
    amounts,
    data: {
      application_fee_amount: amounts.platformFeeCents,
      transfer_data: { destination: student.stripeAccountId },
      metadata: {
        type,
        project_id: project?.id || overrides.projectId || '',
        transaction_id: tx?.id || overrides.transactionId || '',
        payer_id: project?.employerId || overrides.payerId || '',
        payee_id: student?.id || project?.studentId || overrides.payeeId || '',
        amount_total: String(amounts.amountTotal),
        student_payout: String(amounts.studentPayout),
        platform_fee_total: String(amounts.platformFee),
        stripe_connect_flow: 'destination_charge_application_fee',
      },
    },
  };
}

function latestChargeObject(paymentIntent) {
  const charge = paymentIntent?.latest_charge;
  return charge && typeof charge === 'object' ? charge : null;
}

function isMarketplaceDestinationChargeIntent(paymentIntent, expectedDestination) {
  if (!paymentIntent) return false;
  const destination = typeof paymentIntent.transfer_data?.destination === 'string'
    ? paymentIntent.transfer_data.destination
    : paymentIntent.transfer_data?.destination?.id;
  return paymentIntent.metadata?.stripe_connect_flow === 'destination_charge_application_fee'
    && !!paymentIntent.application_fee_amount
    && !!destination
    && (!expectedDestination || destination === expectedDestination);
}

function manualProjectDashboardLink(projectId = '') {
  const id = String(projectId || '').trim();
  return id ? `/dashboard?section=transactions&project=${encodeURIComponent(id)}` : '/dashboard?section=transactions';
}

async function notifyManualProjectPaymentCaptured({ paymentIntent, finalAmounts }) {
  const metadata = paymentIntent?.metadata || {};
  const studentUserId = String(metadata.payee_id || metadata.student_user_id || '').trim();
  const payerUserId = String(metadata.payer_id || '').trim();
  const projectId = String(metadata.project_id || '').trim();
  const jobTitle = String(metadata.job_title || 'your project').trim() || 'your project';
  const amountTotal = finalAmounts?.amountTotal ?? fromCents(paymentIntent?.amount_received || paymentIntent?.amount || 0);
  const studentPayout = finalAmounts?.studentPayout ?? Number(metadata.student_payout || 0);
  const rows = [];
  if (studentUserId) {
    rows.push({
      userId: studentUserId,
      type: notificationType('payout'),
      title: 'Payment released',
      body: `Payment for ${jobTitle} has been released.${studentPayout ? ` Estimated student payout: $${Number(studentPayout).toFixed(2)}.` : ''}`,
      link: manualProjectDashboardLink(projectId),
    });
  }
  if (payerUserId) {
    rows.push({
      userId: payerUserId,
      type: notificationType('payment'),
      title: 'Project payment completed',
      body: `Your payment for ${jobTitle} is complete. Total paid: $${Number(amountTotal || 0).toFixed(2)}.`,
      link: manualProjectDashboardLink(projectId),
    });
  }
  if (rows.length) await createNotifications({ data: rows });
}

async function notifyManualProjectTransferSent({ paymentIntent, transferAmount }) {
  const metadata = paymentIntent?.metadata || {};
  const studentUserId = String(metadata.payee_id || metadata.student_user_id || '').trim();
  if (!studentUserId) return;
  const projectId = String(metadata.project_id || '').trim();
  const jobTitle = String(metadata.job_title || 'your project').trim() || 'your project';
  await createNotification({
    data: {
      userId: studentUserId,
      type: notificationType('payout'),
      title: 'Payout sent',
      body: `Your payout for ${jobTitle} has been sent to Stripe.${transferAmount ? ` Amount: $${Number(transferAmount).toFixed(2)}.` : ''}`,
      link: manualProjectDashboardLink(projectId),
    },
  });
}

async function retrievePaymentIntentForSync(paymentIntentId) {
  return stripe.paymentIntents.retrieve(paymentIntentId, {
    expand: ['latest_charge', 'latest_charge.balance_transaction', 'latest_charge.application_fee'],
  });
}

async function syncTransactionStripeReporting(txId, paymentIntentOrId, extra = {}) {
  if (!txId || !stripe) return null;
  const paymentIntent = typeof paymentIntentOrId === 'string'
    ? await retrievePaymentIntentForSync(paymentIntentOrId)
    : paymentIntentOrId;
  const charge = latestChargeObject(paymentIntent);
  const balanceTransaction = charge?.balance_transaction && typeof charge.balance_transaction === 'object' ? charge.balance_transaction : null;
  const applicationFee = charge?.application_fee && typeof charge.application_fee === 'object' ? charge.application_fee : null;
  const transferId = typeof charge?.transfer === 'string' ? charge.transfer : charge?.transfer?.id;
  const stripeProcessingFee = balanceTransaction ? fromCents(balanceTransaction.fee) : undefined;
  const platformFee = applicationFee ? fromCents(applicationFee.amount) : undefined;
  const data = {
    status: paymentStatusForIntent(paymentIntent),
    stripePaymentIntentId: paymentIntent.id,
    stripeChargeId: charge?.id || undefined,
    stripeTransferId: transferId || extra.stripeTransferId || undefined,
    stripeApplicationFeeId: applicationFee?.id || extra.stripeApplicationFeeId || undefined,
    stripeBalanceTransactionId: balanceTransaction?.id || undefined,
    stripeProcessingFee,
    platformNetRevenue: platformFee == null || stripeProcessingFee == null ? undefined : Number((platformFee - stripeProcessingFee).toFixed(2)),
    transferStatus: transferId || extra.stripeTransferId ? 'created' : extra.transferStatus,
    payoutStatus: extra.payoutStatus,
  };
  Object.keys(data).forEach((key) => data[key] === undefined && delete data[key]);
  const updated = await prisma.transaction.update({ where: { id: txId }, data });
  if (data.status === 'funded') await prisma.project.update({ where: { id: updated.projectId }, data: { status: 'funded' } });
  if (data.status === 'paid') await prisma.project.update({ where: { id: updated.projectId }, data: { status: 'completed', completedAt: new Date() } });
  return updated;
}


function stripeOrigin(req) {
  return req.get('origin') || config.appUrl || 'https://staging.cogocity.com';
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

function stripeStudentPayoutDescription(user) {
  const name = user.displayName || `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Student';
  return `${name} receives payouts for student services completed through CoGoCity, such as tutoring, childcare, pet care, creative work, errands, and local help.`;
}

function stripeIndividualPrefillPayload(user) {
  // Keep CoGo City out of sensitive tax/identity custody. Stripe Connect's
  // hosted onboarding should collect and store DOB, address, SSN/TIN, bank
  // account, and any IRS tax-reporting details directly with Stripe. We only
  // prefill low-risk contact fields to reduce typing.
  return compactObject({
    first_name: user.firstName,
    last_name: user.lastName,
    email: user.email,
  });
}

function stripeStudentConnectAccountPayload(user, origin, country = 'US') {
  return {
    type: 'express',
    country: String(country || 'US').toUpperCase(),
    email: user.email,
    business_type: 'individual',
    business_profile: {
      mcc: '8999',
      url: config.appUrl || origin || 'https://staging.cogocity.com',
      product_description: stripeStudentPayoutDescription(user),
    },
    individual: stripeIndividualPrefillPayload(user),
    capabilities: { transfers: { requested: true } },
    metadata: { user_id: user.id, role: user.role, account_purpose: 'student_payouts', tax_identity_custodian: 'stripe_connect' },
  };
}

async function createStudentConnectAccount(user, origin, country = 'US', idempotencySuffix = 'v1') {
  return stripe.accounts.create(
    stripeStudentConnectAccountPayload(user, origin, country),
    { idempotencyKey: `user:${user.id}:connect-account:${idempotencySuffix}` }
  );
}

async function resetDisconnectedConnectAccount(userId) {
  return prisma.user.update({
    where: { id: userId },
    data: {
      stripeAccountId: null,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
      stripeDetailsSubmitted: false,
      stripeConnectOnboardingStatus: 'not_started',
    },
  });
}

function isDisconnectedConnectError(error) {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('no such account')
    || message.includes('does not have access')
    || message.includes('not connected')
    || message.includes('has been disconnected')
    || message.includes('application does not have required permissions');
}

async function prefillStudentConnectAccount(user, origin) {
  if (!user?.stripeAccountId) return;
  await stripe.accounts.update(user.stripeAccountId, {
    business_profile: {
      mcc: '8999',
      url: config.appUrl || origin || 'https://staging.cogocity.com',
      product_description: stripeStudentPayoutDescription(user),
    },
    metadata: { user_id: user.id, role: user.role, account_purpose: 'student_payouts', tax_identity_custodian: 'stripe_connect' },
  });
}

function isInaccessibleConnectAccountError(error, accountId) {
  const message = String(error?.message || '');
  const code = error?.code;
  const param = error?.param;
  const missingOrInvalid = code === 'resource_missing' || error?.type === 'StripeInvalidRequestError';
  const mentionsAccount = accountId && message.includes(accountId);
  return Boolean(
    missingOrInvalid &&
      (
        param === 'account' ||
        param === 'stripe_account' ||
        mentionsAccount ||
        /does not have access to account|account does not exist|application access may have been revoked/i.test(message)
      )
  );
}

async function clearStaleConnectAccount(user, error, source = 'stripe.connect_account.auto_heal') {
  if (!user?.id || !user?.stripeAccountId) return user;
  const staleAccountId = user.stripeAccountId;
  const data = {
    stripeAccountId: null,
    stripeConnectOnboardingStatus: 'not_started',
    stripeChargesEnabled: false,
    stripePayoutsEnabled: false,
    stripeDetailsSubmitted: false,
  };
  const updated = await prisma.user.update({ where: { id: user.id }, data });
  await writeAuditLog({
    userId: user.id,
    action: source,
    entityType: 'user',
    entityId: user.id,
    payload: {
      staleAccountId,
      reason: error?.message || 'Stripe Connect account is inaccessible to the configured platform key',
      stripeCode: error?.code || null,
      stripeParam: error?.param || null,
    },
  });
  return updated;
}

async function createStudentConnectAccountForUser(user, origin, country) {
  const account = await stripe.accounts.create(
    stripeStudentConnectAccountPayload(user, origin, country),
    { idempotencyKey: `user:${user.id}:connect-account:v2` }
  );
  await prisma.user.update({ where: { id: user.id }, data: { stripeAccountId: account.id, stripeConnectOnboardingStatus: 'in_progress' } });
  await writeAuditLog({ userId: user.id, action: 'stripe.connect_account.create', entityType: 'user', entityId: user.id, payload: { accountId: account.id } });
  return account;
}

function onboardingStatusForUser(user) {
  return {
    user_id: user.id,
    role: user.role,
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
  };
}

async function ensureStripeCustomer(user) {
  if (user.stripeCustomerId) {
    try {
      const existingCustomer = await stripe.customers.retrieve(user.stripeCustomerId);
      if (existingCustomer && !existingCustomer.deleted) return user.stripeCustomerId;
    } catch (error) {
      const isMissingCustomer = error?.code === 'resource_missing' || error?.type === 'StripeInvalidRequestError';
      if (!isMissingCustomer) throw error;
    }
  }

  const customer = await stripe.customers.create(
    {
      email: user.email,
      name: user.displayName || `${user.firstName || ''} ${user.lastName || ''}`.trim(),
      phone: user.phone || undefined,
      metadata: { user_id: user.id, role: user.role },
    },
    { idempotencyKey: `user:${user.id}:customer:v2` }
  );
  await prisma.user.update({ where: { id: user.id }, data: { stripeCustomerId: customer.id, stripeDefaultPaymentMethodId: null, stripePaymentSetupStatus: 'in_progress' } });
  return customer.id;
}

async function syncPaymentSetupIntent(setupIntent) {
  const userId = setupIntent.metadata?.user_id;
  if (!userId || setupIntent.status !== 'succeeded' || !setupIntent.payment_method) return null;
  const customerId = typeof setupIntent.customer === 'string' ? setupIntent.customer : setupIntent.customer?.id;
  if (customerId) await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: setupIntent.payment_method } });
  const data = {
    stripeCustomerId: customerId || undefined,
    stripeDefaultPaymentMethodId: String(setupIntent.payment_method),
    stripePaymentSetupStatus: 'complete',
  };
  await prisma.user.updateMany({ where: { id: userId }, data });
  return prisma.user.findUnique({ where: { id: userId } });
}

async function updateUserFromConnectAccount(account) {
  const userId = account.metadata?.user_id;
  const data = {
    stripeAccountId: account.id,
    stripeChargesEnabled: Boolean(account.charges_enabled),
    stripePayoutsEnabled: Boolean(account.payouts_enabled),
    stripeDetailsSubmitted: Boolean(account.details_submitted),
    stripeConnectOnboardingStatus: account.details_submitted && account.payouts_enabled ? 'complete' : 'in_progress',
  };
  if (userId) return prisma.user.update({ where: { id: userId }, data });
  await prisma.user.updateMany({ where: { stripeAccountId: account.id }, data });
  return prisma.user.findFirst({ where: { stripeAccountId: account.id } });
}

async function syncConnectAccount(user) {
  if (!user.stripeAccountId) return user;
  try {
    const account = await stripe.accounts.retrieve(user.stripeAccountId);
    return updateUserFromConnectAccount(account);
  } catch (error) {
    if (isInaccessibleConnectAccountError(error, user.stripeAccountId) || isDisconnectedConnectError(error)) {
      return clearStaleConnectAccount(user, error);
    }
    throw error;
  }
}

async function syncedPayeeForPayoutSafety(user) {
  if (!user?.stripeAccountId) return user;
  return syncConnectAccount(user);
}

async function validateProjectPayoutSafetyWithAutoHeal({ project, transaction }) {
  const syncedStudent = await syncedPayeeForPayoutSafety(project.student);
  const syncedProject = syncedStudent ? { ...project, student: syncedStudent } : project;
  return validateProjectPayoutSafety({ prisma, project: syncedProject, transaction });
}

async function payoutSafetyRequirementsWithAutoHeal(user) {
  const syncedUser = await syncedPayeeForPayoutSafety(user);
  return payoutSafetyRequirementsForUser(syncedUser || { id: user?.id });
}

async function loadProjectForPayment(projectId, user) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { transaction: true, student: true, employer: true, job: true },
  });
  if (!project || project.deletedAt) return { error: [404, 'Project not found'] };
  if (user.role !== 'admin' && project.employerId !== user.id) return { error: [403, 'Forbidden'] };
  if (!project.transaction) return { error: [404, 'Transaction not found for this project'] };
  return { project, tx: project.transaction };
}

function failPayoutSafety(res, validation) {
  return fail(res, validation.status || 409, validation.message || 'Student payout setup is not ready', validation.requirements || validation);
}

async function markTransactionFromIntent(paymentIntent) {
  const tx = await prisma.transaction.findFirst({ where: { stripePaymentIntentId: paymentIntent.id } });
  if (!tx) return null;
  return syncTransactionStripeReporting(tx.id, paymentIntent.id);
}


function paymentStatusForCheckoutSession(session) {
  if (session.payment_status === 'paid') return 'paid';
  if (session.payment_status === 'unpaid' && session.status === 'complete') return 'pending';
  if (session.status === 'expired') return 'failed';
  return 'pending';
}

function serializeCheckoutSession(session, extra = {}) {
  return Object.assign(
    {
      checkout_session_id: session.id,
      url: session.url,
      status: paymentStatusForCheckoutSession(session),
    },
    extra
  );
}

function isUuid(value = '') {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function workshopStatus(value = '') {
  const status = String(value || '').toLowerCase();
  if (status === 'active') return 'published';
  if (['draft', 'published', 'completed', 'canceled'].includes(status)) return status;
  return 'published';
}

function workshopDurationMinutes(value) {
  if (value == null || value === '') return null;
  const parsed = Number.parseInt(String(value).match(/\d+/)?.[0] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function workshopStartDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : new Date();
}

async function ensureCoreWorkshop(workshopId, req) {
  if (isUuid(workshopId)) {
    const workshop = await prisma.workshop.findUnique({ where: { id: workshopId } });
    if (workshop) return workshop;
  }

  const sync = await prisma.syncRecord.findUnique({ where: { entity_recordId: { entity: 'workshops', recordId: workshopId } } });
  if (!sync || sync.deletedAt) return null;
  const payload = sync.payload || {};
  const backendWorkshopId = payload.backend_workshop_id || payload.backendWorkshopId;
  if (isUuid(backendWorkshopId)) {
    const workshop = await prisma.workshop.findUnique({ where: { id: backendWorkshopId } });
    if (workshop) return workshop;
  }

  let createdBy = isUuid(payload.host_id) ? payload.host_id : req.user.id;
  const creator = await prisma.user.findUnique({ where: { id: createdBy }, select: { id: true } }).catch(() => null);
  if (!creator) createdBy = req.user.id;
  const workshop = await prisma.workshop.create({
    data: {
      title: String(payload.title || 'CoGo City workshop').trim() || 'CoGo City workshop',
      description: payload.description ? String(payload.description) : null,
      price: Number(payload.price || 0) || 0,
      capacity: payload.capacity == null || payload.capacity === '' ? null : Number(payload.capacity),
      format: payload.format === 'online' ? 'online' : 'in_person',
      location: payload.location || null,
      onlineUrl: payload.online_url || payload.onlineUrl || null,
      durationMinutes: workshopDurationMinutes(payload.duration_minutes ?? payload.durationMinutes ?? payload.duration),
      status: workshopStatus(payload.status),
      startDate: workshopStartDate(payload.start_date || payload.startDate || payload.date_time || payload.dateTime),
      createdBy,
    },
  });
  await prisma.syncRecord.update({
    where: { entity_recordId: { entity: 'workshops', recordId: workshopId } },
    data: { payload: { ...payload, backend_workshop_id: workshop.id } },
  });
  return workshop;
}

async function completeWorkshopCheckoutSession(session) {
  const enrollmentId = session.metadata?.workshop_enrollment_id;
  const workshopId = session.metadata?.workshop_id;
  const userId = session.metadata?.user_id;
  if (!enrollmentId && (!workshopId || !userId)) return null;

  const enrollment = enrollmentId
    ? await prisma.workshopEnrollment.findUnique({ where: { id: enrollmentId }, include: { workshop: true, user: true } })
    : await prisma.workshopEnrollment.findUnique({ where: { workshopId_userId: { workshopId, userId } }, include: { workshop: true, user: true } });
  if (!enrollment) return null;

  const paymentStatus = paymentStatusForCheckoutSession(session);
  const updated = await prisma.workshopEnrollment.update({
    where: { id: enrollment.id },
    data: { paymentStatus },
    include: { workshop: true, user: true },
  });

  if (paymentStatus === 'paid') {
    await createNotification({
      data: {
        userId: updated.workshop.createdBy,
        type: notificationType('workshop'),
        title: 'New workshop registration',
        body: `${updated.user?.displayName || 'Someone'} registered for ${updated.workshop.title}`,
        link: `/dashboard?section=workshops&id=${updated.workshop.id}`,
      },
    });
  }

  return updated;
}

async function getCheckoutPaymentIntent(session) {
  if (!session?.payment_intent) return null;
  if (typeof session.payment_intent === 'object') return session.payment_intent;
  return stripe.paymentIntents.retrieve(session.payment_intent, { expand: ['latest_charge'] });
}

function checkoutChargeId(paymentIntent) {
  const charge = paymentIntent?.latest_charge;
  if (!charge) return null;
  return typeof charge === 'string' ? charge : charge.id;
}

async function completeJobCheckoutSession(session) {
  const jobId = session.metadata?.job_id || session.client_reference_id;
  if (!jobId) return null;
  const paymentStatus = paymentStatusForCheckoutSession(session);
  const paymentIntent = await getCheckoutPaymentIntent(session);
  const existing = await prisma.job.findUnique({ where: { id: jobId } });
  if (!existing) return null;
  const data = {
    paymentStatus,
    stripeCheckoutSessionId: session.id || existing.stripeCheckoutSessionId,
    stripePaymentIntentId: paymentIntent?.id || (typeof session.payment_intent === 'string' ? session.payment_intent : existing.stripePaymentIntentId),
    stripeChargeId: checkoutChargeId(paymentIntent) || existing.stripeChargeId,
    stripePaymentStatus: paymentIntent?.status || session.payment_status || existing.stripePaymentStatus,
  };
  if (paymentStatus === 'paid') {
    data.status = 'open';
    data.paidAt = existing.paidAt || new Date();
  }
  const job = await prisma.job.update({ where: { id: jobId }, data, include: { creator: true } });

  if (paymentStatus === 'paid' && existing.paymentStatus !== 'paid') {
    await createNotification({
      data: {
        userId: job.createdBy,
        type: notificationType('payment'),
        title: 'Job listing payment received',
        body: `${job.title} is now active on CoGo City.`,
        link: `/dashboard?section=my_jobs&job=${job.id}`,
      },
    });
  }

  return job;
}

// Keep the webhook route before JSON parsing. app.js mounts this router before the global JSON parser
// so Stripe signatures are verified against the exact raw request body.
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(200).send('stripe_not_configured');
  if (!config.stripeWebhookSecret) return res.status(503).send('stripe_webhook_secret_not_configured');
  const signature = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, config.stripeWebhookSecret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'payment_intent.succeeded' || event.type === 'payment_intent.amount_capturable_updated' || event.type === 'payment_intent.canceled') {
      await markTransactionFromIntent(event.data.object);
    }

    if (event.type === 'setup_intent.succeeded') {
      await syncPaymentSetupIntent(event.data.object);
    }

    if (event.type === 'account.updated') {
      await updateUserFromConnectAccount(event.data.object);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const checkoutType = session.metadata?.type;

      if (checkoutType === 'workshop') {
        await completeWorkshopCheckoutSession(session);
      } else if (checkoutType === 'job_listing') {
        await completeJobCheckoutSession(session);
      } else if (session.payment_intent) {
        const paymentIntent = await retrievePaymentIntentForSync(session.payment_intent);
        const txId = session.metadata?.transaction_id || paymentIntent.metadata?.transaction_id;
        if (txId) {
          await syncTransactionStripeReporting(txId, paymentIntent);
        } else {
          await markTransactionFromIntent(paymentIntent);
        }
      }
    }

    if (event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object;
      if (session.metadata?.type === 'workshop') await completeWorkshopCheckoutSession(session);
      if (session.metadata?.type === 'job_listing') await completeJobCheckoutSession(session);
    }

    if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
      const session = event.data.object;
      if (session.metadata?.type === 'workshop') await completeWorkshopCheckoutSession(session);
      if (session.metadata?.type === 'job_listing') await completeJobCheckoutSession(session);
    }

    if (['transfer.created', 'transfer.updated', 'transfer.paid', 'transfer.failed', 'transfer.reversed'].includes(event.type)) {
      const transfer = event.data.object;
      const txId = transfer.metadata?.transaction_id;
      const transferStatus = event.type.replace('transfer.', '');
      if (txId) await prisma.transaction.update({ where: { id: txId }, data: { stripeTransferId: transfer.id, transferStatus } });
    }

    if (['application_fee.created', 'application_fee.refunded'].includes(event.type)) {
      const fee = event.data.object;
      const chargeId = typeof fee.charge === 'string' ? fee.charge : fee.charge?.id;
      const tx = chargeId ? await prisma.transaction.findFirst({ where: { stripeChargeId: chargeId } }) : null;
      if (tx) {
        const stripeProcessingFee = Number(tx.stripeProcessingFee || 0);
        const platformFee = fromCents(fee.amount_refunded && fee.refunded ? 0 : fee.amount);
        await prisma.transaction.update({
          where: { id: tx.id },
          data: {
            stripeApplicationFeeId: fee.id,
            platformFee,
            platformNetRevenue: Number((platformFee - stripeProcessingFee).toFixed(2)),
          },
        });
      }
    }

    if (['payout.paid', 'payout.failed', 'payout.canceled'].includes(event.type)) {
      await writeAuditLog({ userId: null, action: `stripe.${event.type}`, entityType: 'stripe_payout', entityId: event.data.object.id, payload: { status: event.data.object.status, amount: event.data.object.amount } });
    }

    if (event.type === 'charge.refunded') {
      const charge = event.data.object;
      const piId = charge.payment_intent;
      const tx = await prisma.transaction.findFirst({ where: { stripePaymentIntentId: piId } });
      if (tx) await prisma.transaction.update({ where: { id: tx.id }, data: { status: 'refunded' } });
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    return res.status(500).json({ received: false, error: error.message });
  }
});

router.use(express.json({ limit: '1mb' }));


router.get('/onboarding/status', requireAuth, async (req, res) => {
  if (!stripe) return fail(res, 503, 'Stripe is not configured');
  try {
    const user = req.user.stripeAccountId ? await syncConnectAccount(req.user) : req.user;
    return ok(res, onboardingStatusForUser(user));
  } catch (error) {
    return fail(res, 400, 'Failed to load Stripe onboarding status', error.message);
  }
});

router.post('/onboarding/setup-intent', requireAuth, async (req, res) => {
  if (!stripe) return fail(res, 503, 'Stripe is not configured');

  try {
    const customerId = await ensureStripeCustomer(req.user);
    const setupIntent = await stripe.setupIntents.create(
      {
        customer: customerId,
        usage: 'off_session',
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        metadata: { user_id: req.user.id, role: req.user.role },
      },
      { idempotencyKey: `user:${req.user.id}:setup-intent:${Date.now()}` }
    );
    await writeAuditLog({ userId: req.user.id, action: 'stripe.setup_intent.create', entityType: 'user', entityId: req.user.id, payload: { setupIntentId: setupIntent.id } });
    return ok(res, { setup_intent_id: setupIntent.id, client_secret: setupIntent.client_secret, stripe_customer_id: customerId, status: setupIntent.status });
  } catch (error) {
    return fail(res, 400, 'Failed to create Stripe setup intent', error.message);
  }
});

router.post('/onboarding/payment-method', requireAuth, async (req, res) => {
  if (!stripe) return fail(res, 503, 'Stripe is not configured');

  const setupIntentId = String(req.body?.setup_intent_id || req.body?.setupIntentId || '').trim();
  if (!setupIntentId) return fail(res, 400, 'setup_intent_id is required');

  try {
    const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
    if (setupIntent.metadata?.user_id !== req.user.id) return fail(res, 403, 'Setup intent does not belong to this user');
    if (setupIntent.status !== 'succeeded') return fail(res, 409, `Setup intent is not complete (${setupIntent.status})`);
    if (!setupIntent.payment_method) return fail(res, 409, 'Setup intent has no payment method');

    const user = await syncPaymentSetupIntent(setupIntent);
    await writeAuditLog({ userId: req.user.id, action: 'stripe.payment_method.save', entityType: 'user', entityId: req.user.id, payload: { setupIntentId } });
    return ok(res, onboardingStatusForUser(user));
  } catch (error) {
    return fail(res, 400, 'Failed to save Stripe payment method', error.message);
  }
});

router.post('/onboarding/connect-account', requireAuth, async (req, res) => {
  if (!stripe) return fail(res, 503, 'Stripe is not configured');
  if (!['student', 'admin'].includes(req.user.role)) return fail(res, 403, 'Only payout accounts can create Stripe Connect accounts');

  try {
    const origin = stripeOrigin(req);
    let user = req.user.stripeAccountId ? await syncConnectAccount(req.user) : req.user;
    if (!user.stripeAccountId) {
      const account = await createStudentConnectAccountForUser(user, origin, req.body?.country);
      user = await syncConnectAccount({ ...user, stripeAccountId: account.id });
    }

    return ok(res, onboardingStatusForUser(user));
  } catch (error) {
    return fail(res, 400, 'Failed to create Stripe Connect account', error.message);
  }
});

router.post('/onboarding/connect-account-link', requireAuth, async (req, res) => {
  if (!stripe) return fail(res, 503, 'Stripe is not configured');
  if (!['student', 'admin'].includes(req.user.role)) return fail(res, 403, 'Only payout accounts can onboard with Stripe Connect');

  try {
    let user = req.user.stripeAccountId ? await syncConnectAccount(req.user) : req.user;
    const origin = stripeOrigin(req);
    if (!user.stripeAccountId) {
      const account = await createStudentConnectAccountForUser(user, origin, req.body?.country);
      user = await prisma.user.findUnique({ where: { id: user.id } });
      user.stripeAccountId = account.id;
    } else if (user.role === 'student') {
      try {
        await prefillStudentConnectAccount(user, origin);
      } catch (error) {
        if (!isInaccessibleConnectAccountError(error, user.stripeAccountId) && !isDisconnectedConnectError(error)) throw error;
        user = await clearStaleConnectAccount(user, error, 'stripe.connect_account.auto_heal_prefill');
        const account = await createStudentConnectAccountForUser(user, origin, req.body?.country);
        user = await prisma.user.findUnique({ where: { id: user.id } });
        user.stripeAccountId = account.id;
      }
    }

    const refreshUrl = req.body?.refresh_url || req.body?.refreshUrl || `${origin}/?stripe_connect=refresh`;
    const returnUrl = req.body?.return_url || req.body?.returnUrl || `${origin}/?stripe_connect=return`;
    let link;
    try {
      link = await stripe.accountLinks.create({
        account: user.stripeAccountId,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: 'account_onboarding',
      });
    } catch (error) {
      if (!isInaccessibleConnectAccountError(error, user.stripeAccountId) && !isDisconnectedConnectError(error)) throw error;
      user = await clearStaleConnectAccount(user, error, 'stripe.connect_account.auto_heal_link');
      const account = await createStudentConnectAccountForUser(user, origin, req.body?.country);
      user = await prisma.user.findUnique({ where: { id: user.id } });
      user.stripeAccountId = account.id;
      link = await stripe.accountLinks.create({
        account: user.stripeAccountId,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: 'account_onboarding',
      });
    }
    await writeAuditLog({ userId: req.user.id, action: 'stripe.connect_account_link.create', entityType: 'user', entityId: req.user.id });
    return ok(res, { url: link.url, expires_at: link.expires_at, stripe_account_id: user.stripeAccountId });
  } catch (error) {
    return fail(res, 400, 'Failed to create Stripe Connect onboarding link', error.message);
  }
});

router.post('/create-payment-intent', requireAuth, async (req, res) => {
  if (!stripe) return fail(res, 503, 'Stripe is not configured');
  if (!['employer', 'neighbor', 'admin'].includes(req.user.role)) return fail(res, 403, 'Only employer/neighbor/admin can initiate payment');

  const projectId = String(req.body?.project_id || req.body?.projectId || '').trim();
  if (!projectId) return fail(res, 400, 'project_id is required');

  const loaded = await loadProjectForPayment(projectId, req.user);
  if (loaded.error) return fail(res, loaded.error[0], loaded.error[1]);
  const { project, tx } = loaded;
  const payoutValidation = await validateProjectPayoutSafetyWithAutoHeal({ project, transaction: tx });
  if (!payoutValidation.ok) return failPayoutSafety(res, payoutValidation);

  try {
    const existingIntent = tx.stripePaymentIntentId ? await stripe.paymentIntents.retrieve(tx.stripePaymentIntentId) : null;
    if (existingIntent && !['canceled', 'succeeded'].includes(existingIntent.status)) {
      if (isMarketplaceDestinationChargeIntent(existingIntent, project.student.stripeAccountId)) {
        return ok(res, {
          payment_intent_id: existingIntent.id,
          client_secret: existingIntent.client_secret,
          status: paymentStatusForIntent(existingIntent),
          stripe_status: existingIntent.status,
          project_id: project.id,
        });
      }
      if (['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing'].includes(existingIntent.status)) {
        await stripe.paymentIntents.cancel(existingIntent.id);
      } else {
        return fail(res, 409, 'Existing project payment was created before Stripe Connect marketplace splitting. Cancel/refund it before collecting funds again.');
      }
    }

    const marketplace = marketplacePaymentIntentData({ tx, project, student: project.student });
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: marketplace.amounts.amountTotalCents,
        currency: 'usd',
        capture_method: 'manual',
        automatic_payment_methods: { enabled: true },
        customer: project.employer?.stripeCustomerId || undefined,
        payment_method: project.employer?.stripeDefaultPaymentMethodId || undefined,
        description: `CoGo City project funding${project.job?.title ? `: ${project.job.title}` : ''}`,
        ...marketplace.data,
      },
      { idempotencyKey: `project:${project.id}:tx:${tx.id}:intent:v3:connect` }
    );

    await prisma.transaction.update({ where: { id: tx.id }, data: { stripePaymentIntentId: paymentIntent.id, status: paymentStatusForIntent(paymentIntent) } });
    await writeAuditLog({ userId: req.user.id, action: 'payment.intent.create', entityType: 'transaction', entityId: tx.id, payload: { paymentIntentId: paymentIntent.id } });

    return ok(res, {
      payment_intent_id: paymentIntent.id,
      client_secret: paymentIntent.client_secret,
      status: paymentStatusForIntent(paymentIntent),
      stripe_status: paymentIntent.status,
      project_id: project.id,
    });
  } catch (error) {
    return fail(res, 400, 'Failed to create payment intent', error.message);
  }
});


router.post('/create-workshop-checkout-session', requireAuth, async (req, res) => {
  if (!stripe) return fail(res, 503, 'Stripe is not configured');
  const gate = await requirePlatformReady({ prisma, user: req.user, requirePayment: true, requirePaymentForAllRoles: true });
  if (!gate.ok) return fail(res, gate.status, gate.message, gate.requirements);

  const workshopId = String(req.body?.workshop_id || req.body?.workshopId || '').trim();
  if (!workshopId) return fail(res, 400, 'workshop_id is required');

  const workshop = await ensureCoreWorkshop(workshopId, req);
  if (!workshop) return fail(res, 404, 'Workshop not found');

  const quantity = Math.max(1, Number(req.body?.quantity || 1) || 1);
  const amount = Number(workshop.price || 0);
  const existingEnrollment = await prisma.workshopEnrollment.findUnique({ where: { workshopId_userId: { workshopId: workshop.id, userId: req.user.id } } });
  if (existingEnrollment?.paymentStatus === 'paid') {
    return ok(res, { workshop_id: workshop.id, enrollment_id: existingEnrollment.id, status: 'paid', already_paid: true });
  }
  if (workshop.capacity != null) {
    const paidCount = await prisma.workshopEnrollment.count({ where: { workshopId: workshop.id, paymentStatus: 'paid' } });
    if (paidCount + quantity > Number(workshop.capacity)) return fail(res, 409, 'Workshop is full');
  }

  const enrollment = await prisma.workshopEnrollment.upsert({
    where: { workshopId_userId: { workshopId: workshop.id, userId: req.user.id } },
    create: { workshopId: workshop.id, userId: req.user.id, paymentStatus: amount > 0 ? 'pending' : 'paid' },
    update: { paymentStatus: amount > 0 ? 'pending' : 'paid' },
  });

  if (amount <= 0) {
    await writeAuditLog({ userId: req.user.id, action: 'workshop.enroll.free', entityType: 'workshop_enrollment', entityId: enrollment.id, payload: req.body });
    return ok(res, { workshop_id: workshop.id, enrollment_id: enrollment.id, status: 'paid', free: true });
  }

  const origin = stripeOrigin(req);
  try {
    const customerId = await ensureStripeCustomer(req.user);
    const session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        success_url: `${origin}/?stripe_workshop=${workshop.id}&stripe_status=success`,
        cancel_url: `${origin}/?stripe_workshop=${workshop.id}&stripe_status=cancel`,
        client_reference_id: enrollment.id,
        customer: customerId,
        payment_method_collection: 'if_required',
        line_items: [
          {
            quantity,
            price_data: {
              currency: 'usd',
              unit_amount: toCents(amount),
              product_data: { name: workshop.title || 'CoGo City workshop' },
            },
          },
        ],
        payment_intent_data: {
          metadata: {
            type: 'workshop',
            workshop_id: workshop.id,
            workshop_enrollment_id: enrollment.id,
            user_id: req.user.id,
            quantity: String(quantity),
          },
        },
        metadata: { type: 'workshop', workshop_id: workshop.id, workshop_enrollment_id: enrollment.id, user_id: req.user.id, quantity: String(quantity) },
      },
    );

    await writeAuditLog({ userId: req.user.id, action: 'workshop.checkout.create', entityType: 'workshop_enrollment', entityId: enrollment.id, payload: { checkoutSessionId: session.id } });
    return ok(res, serializeCheckoutSession(session, { workshop_id: workshop.id, enrollment_id: enrollment.id }));
  } catch (error) {
    return fail(res, 400, 'Failed to create workshop checkout session', error.message);
  }
});

router.post('/create-job-checkout-session', requireAuth, async (req, res) => {
  if (!stripe) return fail(res, 503, 'Stripe is not configured');
  if (!['employer', 'admin'].includes(req.user.role)) return fail(res, 403, 'Only employer/admin can pay for direct job listings. Neighbors should post jobs through Community Feed.');

  const jobId = String(req.body?.job_id || req.body?.jobId || '').trim();
  if (!jobId) return fail(res, 400, 'job_id is required');

  const job = await prisma.job.findFirst({ where: { id: jobId, deletedAt: null } });
  if (!job) return fail(res, 404, 'Job not found');
  if (req.user.role !== 'admin' && job.createdBy !== req.user.id) return fail(res, 403, 'Only the job owner can pay for this listing');

  if (job.paymentStatus === 'paid') return ok(res, { job_id: job.id, status: 'paid', already_paid: true });

  const pkg = await getDirectJobPackage(prisma, job.postingPackage || 'basic');
  const pricedPayload = applyDirectJobPackagePricing({
    postingPackage: job.postingPackage || 'basic',
    listingMonths: job.listingMonths || 1,
    listingDurationDays: job.listingDurationDays || 30,
  }, pkg);
  const placementFees = calculateJobPlacementFees(Number(pricedPayload.postingFee || 0));
  const amount = placementFees.employerTotal;
  const pricedJob = await prisma.job.update({
    where: { id: job.id },
    data: {
      postingPackage: pricedPayload.postingPackage,
      postingFee: pricedPayload.postingFee,
      listingMonths: pricedPayload.listingMonths,
      listingDurationDays: pricedPayload.listingDurationDays,
    },
  });
  if (amount <= 0) {
    const updated = await prisma.job.update({ where: { id: pricedJob.id }, data: { paymentStatus: 'paid', status: 'open' } });
    return ok(res, { job_id: updated.id, status: 'paid', free: true });
  }

  const origin = stripeOrigin(req);
  try {
    const customerId = await ensureStripeCustomer(req.user);
    const session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        success_url: `${origin}/?stripe_job=${pricedJob.id}&stripe_status=success&stripe_session={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/?stripe_job=${pricedJob.id}&stripe_status=cancel`,
        client_reference_id: pricedJob.id,
        customer: customerId,
        payment_method_collection: 'if_required',
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: toCents(placementFees.listingFee),
              product_data: { name: `CoGo City job listing: ${pricedJob.title}`, description: `Job placement listing package (${pricedPayload.postingPackage})` },
            },
          },
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: toCents(placementFees.employerPlatformFee),
              product_data: { name: 'CoGo City 12% platform support fee', description: 'Platform support fee added to employer job placement payments.' },
            },
          },
        ],
        payment_intent_data: {
          metadata: { type: 'job_listing', job_id: pricedJob.id, user_id: req.user.id, posting_package: pricedPayload.postingPackage, listing_fee: placementFees.listingFee, employer_platform_fee: placementFees.employerPlatformFee, total_amount: placementFees.employerTotal },
        },
        metadata: { type: 'job_listing', job_id: pricedJob.id, user_id: req.user.id, posting_package: pricedPayload.postingPackage, listing_fee: placementFees.listingFee, employer_platform_fee: placementFees.employerPlatformFee, total_amount: placementFees.employerTotal },
      },
    );

    await prisma.job.update({
      where: { id: pricedJob.id },
      data: {
        paymentStatus: 'pending',
        status: 'pending',
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId: null,
        stripeChargeId: null,
        stripePaymentStatus: session.payment_status || session.status || 'pending',
      },
    });
    await writeAuditLog({ userId: req.user.id, action: 'job.checkout.create', entityType: 'job', entityId: pricedJob.id, payload: { checkoutSessionId: session.id, amount } });
    return ok(res, serializeCheckoutSession(session, { job_id: pricedJob.id, amount, listing_fee: placementFees.listingFee, employer_platform_fee: placementFees.employerPlatformFee }));
  } catch (error) {
    return fail(res, 400, 'Failed to create job checkout session', error.message);
  }
});

router.post('/verify-job-checkout-session', requireAuth, async (req, res) => {
  if (!stripe) return fail(res, 503, 'Stripe is not configured');
  const jobId = String(req.body?.job_id || req.body?.jobId || '').trim();
  const requestedSessionId = String(req.body?.checkout_session_id || req.body?.checkoutSessionId || req.body?.session_id || req.body?.sessionId || '').trim();
  if (!jobId && !requestedSessionId) return fail(res, 400, 'job_id or checkout_session_id is required');

  const job = jobId
    ? await prisma.job.findFirst({ where: { id: jobId, deletedAt: null } })
    : await prisma.job.findFirst({ where: { stripeCheckoutSessionId: requestedSessionId, deletedAt: null } });
  if (!job) return fail(res, 404, 'Job not found');
  if (req.user.role !== 'admin' && job.createdBy !== req.user.id) return fail(res, 403, 'Only the job owner can verify this listing payment');

  const sessionId = requestedSessionId || job.stripeCheckoutSessionId;
  if (!sessionId) return fail(res, 409, 'No Stripe Checkout session is recorded for this job');

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['payment_intent', 'payment_intent.latest_charge'] });
    const sessionJobId = session.metadata?.job_id || session.client_reference_id;
    if (sessionJobId && sessionJobId !== job.id) return fail(res, 409, 'Checkout session does not match this job');
    const updated = await completeJobCheckoutSession(session);
    await writeAuditLog({ userId: req.user.id, action: 'job.checkout.verify', entityType: 'job', entityId: job.id, payload: { checkoutSessionId: session.id, status: session.status, paymentStatus: session.payment_status } });
    return ok(res, Object.assign(serializeJob(updated || job), serializeCheckoutSession(session, { job_id: job.id })));
  } catch (error) {
    return fail(res, 400, 'Failed to verify job checkout session', error.message);
  }
});

router.post('/create-checkout-session', requireAuth, async (req, res) => {
  if (!stripe) return fail(res, 503, 'Stripe is not configured');
  if (!['employer', 'neighbor', 'admin'].includes(req.user.role)) return fail(res, 403, 'Only employer/neighbor/admin can initiate payment');

  const projectId = String(req.body?.project_id || req.body?.projectId || '').trim();
  if (!projectId) return fail(res, 400, 'project_id is required');

  const loaded = await loadProjectForPayment(projectId, req.user);
  if (loaded.error) return fail(res, loaded.error[0], loaded.error[1]);
  const { project, tx } = loaded;
  const payoutValidation = await validateProjectPayoutSafetyWithAutoHeal({ project, transaction: tx });
  if (!payoutValidation.ok) return failPayoutSafety(res, payoutValidation);
  const origin = stripeOrigin(req);

  try {
    const marketplace = marketplacePaymentIntentData({ tx, project, student: project.student });
    const session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        success_url: `${origin}/?stripe_project=${project.id}&stripe_status=success`,
        cancel_url: `${origin}/?stripe_project=${project.id}&stripe_status=cancel`,
        client_reference_id: project.id,
        customer: project.employer?.stripeCustomerId || undefined,
        payment_method_collection: project.employer?.stripeCustomerId ? 'if_required' : undefined,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: marketplace.amounts.amountTotalCents,
              product_data: { name: project.job?.title || 'CoGo City project funding' },
            },
          },
        ],
        payment_intent_data: {
          capture_method: 'manual',
          setup_future_usage: project.employer?.stripeCustomerId ? undefined : 'off_session',
          ...marketplace.data,
        },
        metadata: { project_id: project.id, transaction_id: tx.id },
      },
      { idempotencyKey: `project:${project.id}:tx:${tx.id}:checkout:v2:connect` }
    );

    if (session.payment_intent) {
      await prisma.transaction.update({ where: { id: tx.id }, data: { stripePaymentIntentId: session.payment_intent, status: 'pending' } });
    }

    await writeAuditLog({ userId: req.user.id, action: 'payment.checkout.create', entityType: 'transaction', entityId: tx.id, payload: { checkoutSessionId: session.id } });
    return ok(res, { checkout_session_id: session.id, url: session.url, project_id: project.id, status: 'pending' });
  } catch (error) {
    return fail(res, 400, 'Failed to create checkout session', error.message);
  }
});

router.post('/capture-payment-intent', requireAuth, async (req, res) => {
  if (!stripe) return fail(res, 503, 'Stripe is not configured');
  if (!['employer', 'neighbor', 'admin'].includes(req.user.role)) return fail(res, 403, 'Only employer/neighbor/admin can release payment');

  const projectId = String(req.body?.project_id || req.body?.projectId || '').trim();
  if (!projectId) return fail(res, 400, 'project_id is required');

  const loaded = await loadProjectForPayment(projectId, req.user);
  if (loaded.error) return fail(res, loaded.error[0], loaded.error[1]);
  const { project, tx } = loaded;
  if (!tx.stripePaymentIntentId) return fail(res, 409, 'Project payment has not been funded with Stripe');
  const payoutValidation = await validateProjectPayoutSafetyWithAutoHeal({ project, transaction: tx });
  if (!payoutValidation.ok) return failPayoutSafety(res, payoutValidation);

  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(tx.stripePaymentIntentId);
    if (!isMarketplaceDestinationChargeIntent(paymentIntent, project.student.stripeAccountId)) {
      return fail(res, 409, 'PaymentIntent is missing Stripe Connect destination charge/app fee data. Do not capture; create a new marketplace-split payment instead.');
    }
    if (paymentIntent.status === 'succeeded') return ok(res, { payment_intent_id: paymentIntent.id, status: 'paid', stripe_status: paymentIntent.status, project_id: project.id });
    if (paymentIntent.status !== 'requires_capture') return fail(res, 409, `Payment is not ready to capture (${paymentIntent.status})`);

    const amountOverride = req.body?.amount_total ?? req.body?.amountTotal;
    const requestedFinalTotal = amountOverride != null && amountOverride !== '' ? Number(amountOverride) : Number(tx.amountTotal || 0);
    const finalWorkTotal = project.actualHours != null && project.hourlyRate != null
      ? Number((Number(project.actualHours || 0) * Number(project.hourlyRate || 0)).toFixed(2))
      : null;
    const recalculatedFees = finalWorkTotal != null ? calculateHourlyProjectFees(finalWorkTotal) : null;
    const finalAmounts = marketplaceAmounts(tx, {
      amountTotal: requestedFinalTotal,
      studentPayout: req.body?.student_payout ?? req.body?.studentPayout ?? recalculatedFees?.studentPayout,
      platformFee: req.body?.platform_fee_total ?? req.body?.platformFeeTotal ?? recalculatedFees?.platformFeeTotal,
    });
    let activePaymentIntent = paymentIntent;
    let capturableCents = Number(activePaymentIntent.amount_capturable || activePaymentIntent.amount || 0);
    let amountToCapture = Math.min(finalAmounts.amountTotalCents, capturableCents);
    let applicationFeeToCaptureCents = Math.min(finalAmounts.platformFeeCents, Number(activePaymentIntent.application_fee_amount || finalAmounts.platformFeeCents));
    let replacementIntent = null;

    if (finalAmounts.amountTotalCents > capturableCents) {
      const paymentMethodId = project.employer?.stripeDefaultPaymentMethodId || activePaymentIntent.payment_method;
      const customerId = project.employer?.stripeCustomerId || (typeof activePaymentIntent.customer === 'string' ? activePaymentIntent.customer : activePaymentIntent.customer?.id);
      if (!paymentMethodId) return fail(res, 409, 'Final invoice is higher than the amount held in escrow and no saved payment method is available for the final total');

      replacementIntent = await stripe.paymentIntents.create(
        {
          amount: finalAmounts.amountTotalCents,
          currency: activePaymentIntent.currency || 'usd',
          customer: customerId || undefined,
          payment_method: typeof paymentMethodId === 'string' ? paymentMethodId : paymentMethodId?.id,
          confirm: true,
          off_session: true,
          application_fee_amount: finalAmounts.platformFeeCents,
          transfer_data: { destination: project.student.stripeAccountId },
          description: `CoGo City final invoice${project.job?.title ? `: ${project.job.title}` : ''}`,
          metadata: {
            type: 'project_final_reauthorization',
            project_id: project.id,
            transaction_id: tx.id,
            original_payment_intent_id: activePaymentIntent.id,
            payer_id: project.employerId,
            payee_id: project.studentId,
            amount_total: String(finalAmounts.amountTotal),
            student_payout: String(finalAmounts.studentPayout),
            platform_fee_total: String(finalAmounts.platformFee),
            adjustment_type: 'final_invoice_reauthorization',
            stripe_connect_flow: 'destination_charge_application_fee',
          },
        },
        { idempotencyKey: `project:${project.id}:tx:${tx.id}:final-reauthorization:${finalAmounts.amountTotalCents}:v1:connect` }
      );
      if (replacementIntent.status !== 'succeeded') return fail(res, 402, `Final invoice charge did not complete (${replacementIntent.status})`);

      try {
        await stripe.paymentIntents.cancel(activePaymentIntent.id, { cancellation_reason: 'abandoned' });
      } catch (cancelError) {
        await writeAuditLog({ userId: req.user.id, action: 'payment.intent.cancel_replaced_failed', entityType: 'stripe_payment_intent', entityId: activePaymentIntent.id, payload: { replacementPaymentIntentId: replacementIntent.id, error: cancelError.message } });
      }

      activePaymentIntent = replacementIntent;
      capturableCents = finalAmounts.amountTotalCents;
      amountToCapture = finalAmounts.amountTotalCents;
      applicationFeeToCaptureCents = finalAmounts.platformFeeCents;
    }

    if (amountToCapture < finalAmounts.amountTotalCents && !replacementIntent) return fail(res, 409, 'Final invoice exceeds the authorized Stripe amount and could not be reauthorized');
    const captured = replacementIntent || await stripe.paymentIntents.capture(activePaymentIntent.id, { amount_to_capture: amountToCapture, application_fee_amount: applicationFeeToCaptureCents });
    const synced = await syncTransactionStripeReporting(tx.id, captured.id, replacementIntent ? { payoutStatus: 'reauthorized' } : {});

    await prisma.transaction.update({ where: { id: tx.id }, data: { amountTotal: finalAmounts.amountTotal, platformFee: finalAmounts.platformFee, studentPayout: finalAmounts.studentPayout, status: synced?.status || 'paid' } });
    await prisma.project.update({ where: { id: project.id }, data: { status: 'completed', completedAt: new Date(), totalAmount: finalWorkTotal ?? project.totalAmount } });
    await createNotification({ data: { userId: project.studentId, type: notificationType('payout'), title: 'Payment released', body: 'Project payment has been released.', link: `/dashboard?section=transactions&project=${project.id}` } });
    await writeAuditLog({ userId: req.user.id, action: 'payment.intent.capture', entityType: 'transaction', entityId: tx.id, payload: { paymentIntentId: captured.id, amountCaptured: fromCents(amountToCapture), finalAmount: finalAmounts.amountTotal, replacementPaymentIntentId: replacementIntent?.id || null } });

    return ok(res, { payment_intent_id: captured.id, replacement_payment_intent_id: replacementIntent?.id || null, replacement_status: replacementIntent ? 'paid' : 'none', status: 'paid', stripe_status: captured.status, project_id: project.id, amount_captured: fromCents(amountToCapture), final_amount_total: finalAmounts.amountTotal });
  } catch (error) {
    return fail(res, 400, 'Failed to capture payment intent', error.message);
  }
});


router.post('/manual-project-payment-intent', requireAuth, async (req, res) => {
  if (!stripe) return fail(res, 503, 'Stripe is not configured');
  if (!['employer', 'neighbor', 'admin'].includes(req.user.role)) return fail(res, 403, 'Only employer/neighbor/admin can fund project payments');

  const amountTotal = Number(req.body?.amount_total ?? req.body?.amountTotal ?? 0);
  const workTotal = Number(req.body?.work_total ?? req.body?.workTotal ?? 0);
  const studentPayout = Number(req.body?.student_payout ?? req.body?.studentPayout ?? 0);
  const platformFeeTotal = Number(req.body?.platform_fee_total ?? req.body?.platformFeeTotal ?? 0);
  const projectId = String(req.body?.project_id || req.body?.projectId || '').trim();
  const studentUserId = String(req.body?.student_user_id || req.body?.studentUserId || req.body?.payee_id || req.body?.payeeId || '').trim();
  const jobTitle = String(req.body?.job_title || req.body?.jobTitle || 'CoGo City project').trim();
  if (!Number.isFinite(amountTotal) || amountTotal <= 0) return fail(res, 400, 'amount_total must be greater than 0');
  if (!req.user.stripeCustomerId || !req.user.stripeDefaultPaymentMethodId) return fail(res, 409, 'Payer has not saved a Stripe test payment method');
  if (!studentUserId) return fail(res, 400, 'student_user_id is required');

  try {
    const student = await prisma.user.findUnique({ where: { id: studentUserId } });
    const requirements = await payoutSafetyRequirementsWithAutoHeal(student || { id: studentUserId });
    if (!requirements.payout_ready) return fail(res, 409, 'Student payout setup must be completed in Stripe before paid project funds can be collected or released.', requirements);

    const marketplace = marketplacePaymentIntentData({
      tx: { amountTotal, studentPayout, platformFee: platformFeeTotal },
      project: { id: projectId, employerId: req.user.id, studentId: studentUserId },
      student,
      overrides: { amountTotal, studentPayout, platformFee: platformFeeTotal },
      type: 'project_escrow_test',
    });
    marketplace.data.metadata.job_title = jobTitle.slice(0, 450);
    marketplace.data.metadata.work_total = String(workTotal || '');

    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: marketplace.amounts.amountTotalCents,
        currency: 'usd',
        customer: req.user.stripeCustomerId,
        payment_method: req.user.stripeDefaultPaymentMethodId,
        capture_method: 'manual',
        confirm: true,
        off_session: true,
        description: `CoGo City project escrow: ${jobTitle}`,
        ...marketplace.data,
      },
      { idempotencyKey: `manual-project:${req.user.id}:${projectId || jobTitle}:${amountTotal}:intent:v2:connect` }
    );

    await writeAuditLog({ userId: req.user.id, action: 'payment.manual_project.intent.create', entityType: 'stripe_payment_intent', entityId: paymentIntent.id, payload: { amountTotal, projectId, studentUserId } });
    return ok(res, {
      payment_intent_id: paymentIntent.id,
      client_secret: paymentIntent.client_secret,
      status: paymentStatusForIntent(paymentIntent),
      stripe_status: paymentIntent.status,
    });
  } catch (error) {
    return fail(res, 400, 'Failed to create Stripe project payment intent', error.message);
  }
});

router.post('/capture-manual-project-payment-intent', requireAuth, async (req, res) => {
  if (!stripe) return fail(res, 503, 'Stripe is not configured');
  if (!['employer', 'neighbor', 'admin'].includes(req.user.role)) return fail(res, 403, 'Only employer/neighbor/admin can release project payments');

  const paymentIntentId = String(req.body?.payment_intent_id || req.body?.paymentIntentId || '').trim();
  if (!paymentIntentId) return fail(res, 400, 'payment_intent_id is required');

  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (paymentIntent.metadata?.payer_id && paymentIntent.metadata.payer_id !== req.user.id && req.user.role !== 'admin') return fail(res, 403, 'Forbidden');
    const studentUserId = paymentIntent.metadata?.payee_id || paymentIntent.metadata?.student_user_id || '';
    if (studentUserId) {
      const student = await prisma.user.findUnique({ where: { id: studentUserId } });
      const requirements = await payoutSafetyRequirementsWithAutoHeal(student || { id: studentUserId });
      if (!requirements.payout_ready) return fail(res, 409, 'Student payout setup must be completed in Stripe before paid project funds can be collected or released.', requirements);
    }
    if (paymentIntent.status === 'succeeded') return ok(res, { payment_intent_id: paymentIntent.id, status: 'paid', stripe_status: paymentIntent.status });
    if (paymentIntent.status !== 'requires_capture') return fail(res, 409, `Payment is not ready to capture (${paymentIntent.status})`);
    const finalAmounts = marketplaceAmounts(paymentIntent.metadata || {}, {
      amountTotal: req.body?.amount_total ?? req.body?.amountTotal ?? paymentIntent.metadata?.amount_total,
      studentPayout: req.body?.student_payout ?? req.body?.studentPayout ?? paymentIntent.metadata?.student_payout,
      platformFee: req.body?.platform_fee_total ?? req.body?.platformFeeTotal ?? paymentIntent.metadata?.platform_fee_total,
    });
    let activePaymentIntent = paymentIntent;
    let capturableCents = Number(activePaymentIntent.amount_capturable || activePaymentIntent.amount || 0);
    let amountToCapture = Math.min(finalAmounts.amountTotalCents, capturableCents);
    let applicationFeeToCaptureCents = Math.min(finalAmounts.platformFeeCents, Number(activePaymentIntent.application_fee_amount || finalAmounts.platformFeeCents));
    let replacementIntent = null;

    if (finalAmounts.amountTotalCents > capturableCents) {
      const destination = typeof activePaymentIntent.transfer_data?.destination === 'string'
        ? activePaymentIntent.transfer_data.destination
        : activePaymentIntent.transfer_data?.destination?.id;
      const paymentMethodId = typeof activePaymentIntent.payment_method === 'string' ? activePaymentIntent.payment_method : activePaymentIntent.payment_method?.id;
      const customerId = typeof activePaymentIntent.customer === 'string' ? activePaymentIntent.customer : activePaymentIntent.customer?.id;
      if (!destination) return fail(res, 409, 'Final invoice is higher than escrow, but the original Stripe payment is missing student payout destination data');
      if (!paymentMethodId) return fail(res, 409, 'Final invoice is higher than escrow and no saved payment method is available for the final total');

      replacementIntent = await stripe.paymentIntents.create(
        {
          amount: finalAmounts.amountTotalCents,
          currency: activePaymentIntent.currency || 'usd',
          customer: customerId || undefined,
          payment_method: paymentMethodId,
          confirm: true,
          off_session: true,
          application_fee_amount: finalAmounts.platformFeeCents,
          transfer_data: { destination },
          description: `CoGo City final invoice${activePaymentIntent.metadata?.job_title ? `: ${activePaymentIntent.metadata.job_title}` : ''}`,
          metadata: {
            type: 'manual_project_final_reauthorization',
            project_id: activePaymentIntent.metadata?.project_id || '',
            original_payment_intent_id: activePaymentIntent.id,
            payer_id: activePaymentIntent.metadata?.payer_id || req.user.id,
            payee_id: studentUserId,
            amount_total: String(finalAmounts.amountTotal),
            student_payout: String(finalAmounts.studentPayout),
            platform_fee_total: String(finalAmounts.platformFee),
            adjustment_type: 'final_invoice_reauthorization',
            stripe_connect_flow: 'destination_charge_application_fee',
          },
        },
        { idempotencyKey: `manual-project:${activePaymentIntent.id}:final-reauthorization:${finalAmounts.amountTotalCents}:v1:connect` }
      );
      if (replacementIntent.status !== 'succeeded') return fail(res, 402, `Final invoice charge did not complete (${replacementIntent.status})`);

      try {
        await stripe.paymentIntents.cancel(activePaymentIntent.id, { cancellation_reason: 'abandoned' });
      } catch (cancelError) {
        await writeAuditLog({ userId: req.user.id, action: 'payment.manual_project.intent.cancel_replaced_failed', entityType: 'stripe_payment_intent', entityId: activePaymentIntent.id, payload: { replacementPaymentIntentId: replacementIntent.id, error: cancelError.message } });
      }

      activePaymentIntent = replacementIntent;
      capturableCents = finalAmounts.amountTotalCents;
      amountToCapture = finalAmounts.amountTotalCents;
      applicationFeeToCaptureCents = finalAmounts.platformFeeCents;
    }

    if (amountToCapture < finalAmounts.amountTotalCents && !replacementIntent) return fail(res, 409, 'Final invoice exceeds the authorized Stripe amount and could not be reauthorized');
    const captured = replacementIntent || await stripe.paymentIntents.capture(activePaymentIntent.id, {
      amount_to_capture: amountToCapture,
      application_fee_amount: applicationFeeToCaptureCents,
    });
    await notifyManualProjectPaymentCaptured({ paymentIntent: captured, finalAmounts });
    await writeAuditLog({ userId: req.user.id, action: 'payment.manual_project.intent.capture', entityType: 'stripe_payment_intent', entityId: captured.id, payload: { amount: captured.amount_received, amountCaptured: fromCents(amountToCapture), finalAmount: finalAmounts.amountTotal, platformFee: finalAmounts.platformFee, studentPayout: finalAmounts.studentPayout, replacementPaymentIntentId: replacementIntent?.id || null } });
    return ok(res, { payment_intent_id: captured.id, replacement_payment_intent_id: replacementIntent?.id || null, replacement_status: replacementIntent ? 'paid' : 'none', status: 'paid', stripe_status: captured.status, amount_captured: fromCents(amountToCapture), final_amount_total: finalAmounts.amountTotal });
  } catch (error) {
    return fail(res, 400, 'Failed to capture Stripe project payment', error.message);
  }
});

router.post('/manual-project-transfer', requireAuth, async (req, res) => {
  if (!stripe) return fail(res, 503, 'Stripe is not configured');
  if (!['employer', 'neighbor', 'admin'].includes(req.user.role)) return fail(res, 403, 'Only employer/neighbor/admin can release project payouts');

  const paymentIntentId = String(req.body?.payment_intent_id || req.body?.paymentIntentId || '').trim();
  const studentUserId = String(req.body?.student_user_id || req.body?.studentUserId || req.body?.payee_id || req.body?.payeeId || '').trim();
  const amount = Number(req.body?.amount ?? req.body?.student_payout ?? req.body?.studentPayout ?? 0);
  if (!paymentIntentId) return fail(res, 400, 'payment_intent_id is required');
  if (!studentUserId) return fail(res, 400, 'student_user_id is required');
  if (!Number.isFinite(amount) || amount <= 0) return fail(res, 400, 'amount must be greater than 0');

  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
    if (paymentIntent.metadata?.payer_id && paymentIntent.metadata.payer_id !== req.user.id && req.user.role !== 'admin') return fail(res, 403, 'Forbidden');
    if (paymentIntent.status !== 'succeeded') return fail(res, 409, `Payment must be captured before payout transfer (${paymentIntent.status})`);
    const existingTransfer = latestChargeObject(paymentIntent)?.transfer || paymentIntent.transfer_data?.destination;
    if (existingTransfer) return ok(res, { transfer_id: typeof existingTransfer === 'string' ? existingTransfer : existingTransfer.id, status: 'created', automatic_destination_charge: true });

    const student = await prisma.user.findUnique({ where: { id: studentUserId } });
    const requirements = await payoutSafetyRequirementsWithAutoHeal(student || { id: studentUserId });
    if (!requirements.payout_ready) return fail(res, 409, 'Student Stripe payout account is not ready', requirements);
    const latestCharge = typeof paymentIntent.latest_charge === 'string' ? paymentIntent.latest_charge : paymentIntent.latest_charge?.id;
    const transfer = await stripe.transfers.create(
      {
        amount: toCents(amount),
        currency: 'usd',
        destination: student.stripeAccountId,
        source_transaction: latestCharge || undefined,
        metadata: {
          type: 'project_student_payout_test',
          payment_intent_id: paymentIntent.id,
          payer_id: req.user.id,
          payee_id: student.id,
          project_id: paymentIntent.metadata?.project_id || '',
        },
      },
      { idempotencyKey: `manual-project:${paymentIntent.id}:student:${student.id}:transfer:v1` }
    );
    await notifyManualProjectTransferSent({ paymentIntent, transferAmount: amount });
    await writeAuditLog({ userId: req.user.id, action: 'payment.manual_project.transfer.create', entityType: 'stripe_transfer', entityId: transfer.id, payload: { paymentIntentId, studentUserId, amount } });
    return ok(res, { transfer_id: transfer.id, amount: transfer.amount, status: 'paid' });
  } catch (error) {
    return fail(res, 400, 'Failed to transfer Stripe project payout', error.message);
  }
});

router.post('/transfer-payout', requireAuth, async (req, res) => {
  if (!stripe) return fail(res, 503, 'Stripe is not configured');
  if (req.user.role !== 'admin') return fail(res, 403, 'Only admins can transfer payouts');

  const projectId = String(req.body?.project_id || req.body?.projectId || '').trim();
  if (!projectId) return fail(res, 400, 'project_id is required');

  const loaded = await loadProjectForPayment(projectId, req.user);
  if (loaded.error) return fail(res, loaded.error[0], loaded.error[1]);
  const { project, tx } = loaded;
  if (tx.stripeTransferId) return ok(res, { transfer_id: tx.stripeTransferId, status: 'paid', project_id: project.id, already_transferred: true });
  if (!tx.stripePaymentIntentId || tx.status !== 'paid') return fail(res, 409, 'Project payment must be captured before payout transfer');
  const payoutValidation = await validateProjectPayoutSafetyWithAutoHeal({ project, transaction: tx });
  if (!payoutValidation.ok) return failPayoutSafety(res, payoutValidation);

  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(tx.stripePaymentIntentId, { expand: ['latest_charge'] });
    if (paymentIntent.status !== 'succeeded') return fail(res, 409, `Payment is not captured (${paymentIntent.status})`);
    const destinationTransfer = latestChargeObject(paymentIntent)?.transfer;
    if (destinationTransfer) {
      await prisma.transaction.update({ where: { id: tx.id }, data: { stripeTransferId: typeof destinationTransfer === 'string' ? destinationTransfer : destinationTransfer.id, transferStatus: 'created' } });
      return ok(res, { transfer_id: typeof destinationTransfer === 'string' ? destinationTransfer : destinationTransfer.id, status: 'created', project_id: project.id, automatic_destination_charge: true });
    }
    const latestCharge = typeof paymentIntent.latest_charge === 'string' ? paymentIntent.latest_charge : paymentIntent.latest_charge?.id;
    const transferAmount = toCents(tx.studentPayout);
    const originalChargeReceived = Number(paymentIntent.amount_received || paymentIntent.amount || 0);
    const sourceTransaction = transferAmount <= originalChargeReceived ? latestCharge : undefined;

    const transfer = await stripe.transfers.create(
      {
        amount: transferAmount,
        currency: 'usd',
        destination: project.student.stripeAccountId,
        source_transaction: sourceTransaction,
        metadata: {
          project_id: project.id,
          transaction_id: tx.id,
          payer_id: project.employerId,
          payee_id: project.studentId,
        },
      },
      { idempotencyKey: `project:${project.id}:tx:${tx.id}:transfer:v1` }
    );

    await prisma.transaction.update({ where: { id: tx.id }, data: { stripeTransferId: transfer.id } });
    await createNotification({ data: { userId: project.studentId, type: notificationType('payout'), title: 'Payout sent', body: 'Your project payout has been sent to Stripe.', link: `/dashboard?section=transactions&project=${project.id}` } });
    await writeAuditLog({ userId: req.user.id, action: 'payment.transfer.create', entityType: 'transaction', entityId: tx.id, payload: { transferId: transfer.id, amount: fromCents(transferAmount), sourceTransaction: sourceTransaction || null } });

    return ok(res, { transfer_id: transfer.id, amount: transfer.amount, status: 'paid', project_id: project.id });
  } catch (error) {
    return fail(res, 400, 'Failed to transfer payout', error.message);
  }
});

router.post('/refund-payment-intent', requireAuth, async (req, res) => {
  if (!stripe) return fail(res, 503, 'Stripe is not configured');
  if (!['employer', 'neighbor', 'admin'].includes(req.user.role)) return fail(res, 403, 'Only employer/neighbor/admin can refund payment');

  const projectId = String(req.body?.project_id || req.body?.projectId || '').trim();
  if (!projectId) return fail(res, 400, 'project_id is required');

  const loaded = await loadProjectForPayment(projectId, req.user);
  if (loaded.error) return fail(res, loaded.error[0], loaded.error[1]);
  const { project, tx } = loaded;
  if (!tx.stripePaymentIntentId) return fail(res, 409, 'Project payment has not been funded with Stripe');

  try {
    const refund = await stripe.refunds.create({
      payment_intent: tx.stripePaymentIntentId,
      amount: req.body?.amount ? toCents(req.body.amount) : undefined,
      metadata: { project_id: project.id, transaction_id: tx.id },
    });
    await prisma.transaction.update({ where: { id: tx.id }, data: { status: 'refunded' } });
    await writeAuditLog({ userId: req.user.id, action: 'payment.intent.refund', entityType: 'transaction', entityId: tx.id, payload: { refundId: refund.id } });
    return ok(res, { refund_id: refund.id, status: refund.status, project_id: project.id });
  } catch (error) {
    return fail(res, 400, 'Failed to refund payment intent', error.message);
  }
});

module.exports = router;
