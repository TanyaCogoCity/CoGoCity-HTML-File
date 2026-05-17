const express = require('express');
const Stripe = require('stripe');
const { prisma } = require('../lib/prisma');
const { ok, fail } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');
const config = require('../config');
const { writeAuditLog } = require('../lib/audit');
const { createNotification, createNotifications } = require('../lib/notifications');
const { notificationType } = require('../lib/compat');

const stripe = config.stripeSecretKey ? new Stripe(config.stripeSecretKey, { apiVersion: '2024-06-20' }) : null;
const router = express.Router();

function toCents(amount) {
  return Math.max(1, Math.round(Number(amount || 0) * 100));
}

function paymentStatusForIntent(paymentIntent) {
  if (paymentIntent.status === 'requires_capture') return 'funded';
  if (paymentIntent.status === 'succeeded') return 'paid';
  if (paymentIntent.status === 'canceled') return 'failed';
  return 'pending';
}


function stripeOrigin(req) {
  return req.get('origin') || config.appUrl || 'https://staging.cogocity.com';
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
    },
  };
}

async function ensureStripeCustomer(user) {
  if (user.stripeCustomerId) return user.stripeCustomerId;
  const customer = await stripe.customers.create(
    {
      email: user.email,
      name: user.displayName || `${user.firstName || ''} ${user.lastName || ''}`.trim(),
      phone: user.phone || undefined,
      metadata: { user_id: user.id, role: user.role },
    },
    { idempotencyKey: `user:${user.id}:customer:v1` }
  );
  await prisma.user.update({ where: { id: user.id }, data: { stripeCustomerId: customer.id, stripePaymentSetupStatus: 'in_progress' } });
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
  const account = await stripe.accounts.retrieve(user.stripeAccountId);
  return updateUserFromConnectAccount(account);
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

async function markTransactionFromIntent(paymentIntent) {
  const tx = await prisma.transaction.findFirst({ where: { stripePaymentIntentId: paymentIntent.id } });
  if (!tx) return null;
  const status = paymentStatusForIntent(paymentIntent);
  const updated = await prisma.transaction.update({ where: { id: tx.id }, data: { status } });
  if (status === 'funded') await prisma.project.update({ where: { id: tx.projectId }, data: { status: 'funded' } });
  if (status === 'paid') await prisma.project.update({ where: { id: tx.projectId }, data: { status: 'completed', completedAt: new Date() } });
  return updated;
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

async function completeJobCheckoutSession(session) {
  const jobId = session.metadata?.job_id;
  if (!jobId) return null;
  const paymentStatus = paymentStatusForCheckoutSession(session);
  const data = { paymentStatus };
  if (paymentStatus === 'paid') data.status = 'open';
  const job = await prisma.job.update({ where: { id: jobId }, data, include: { creator: true } });

  if (paymentStatus === 'paid') {
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
        const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent);
        const txId = session.metadata?.transaction_id || paymentIntent.metadata?.transaction_id;
        if (txId) {
          await prisma.transaction.update({
            where: { id: txId },
            data: { stripePaymentIntentId: paymentIntent.id, status: paymentStatusForIntent(paymentIntent) },
          });
          if (paymentIntent.status === 'requires_capture') await prisma.project.update({ where: { id: session.metadata.project_id }, data: { status: 'funded' } });
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

    if (event.type === 'transfer.paid') {
      const transfer = event.data.object;
      const txId = transfer.metadata?.transaction_id;
      if (txId) await prisma.transaction.update({ where: { id: txId }, data: { status: 'paid', stripeTransferId: transfer.id } });
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
  if (!['employer', 'neighbor', 'admin'].includes(req.user.role)) return fail(res, 403, 'Only payer accounts can save payment methods');

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
  if (!['employer', 'neighbor', 'admin'].includes(req.user.role)) return fail(res, 403, 'Only payer accounts can save payment methods');

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
    let accountId = req.user.stripeAccountId;
    if (!accountId) {
      const account = await stripe.accounts.create(
        {
          type: 'express',
          country: String(req.body?.country || 'US').toUpperCase(),
          email: req.user.email,
          business_type: 'individual',
          capabilities: {
            transfers: { requested: true },
          },
          metadata: { user_id: req.user.id, role: req.user.role },
        },
        { idempotencyKey: `user:${req.user.id}:connect-account:v1` }
      );
      accountId = account.id;
      await prisma.user.update({ where: { id: req.user.id }, data: { stripeAccountId: accountId, stripeConnectOnboardingStatus: 'in_progress' } });
      await writeAuditLog({ userId: req.user.id, action: 'stripe.connect_account.create', entityType: 'user', entityId: req.user.id, payload: { accountId } });
    }

    const user = await syncConnectAccount({ ...req.user, stripeAccountId: accountId });
    return ok(res, onboardingStatusForUser(user));
  } catch (error) {
    return fail(res, 400, 'Failed to create Stripe Connect account', error.message);
  }
});

router.post('/onboarding/connect-account-link', requireAuth, async (req, res) => {
  if (!stripe) return fail(res, 503, 'Stripe is not configured');
  if (!['student', 'admin'].includes(req.user.role)) return fail(res, 403, 'Only payout accounts can onboard with Stripe Connect');

  try {
    let user = req.user;
    if (!user.stripeAccountId) {
      const account = await stripe.accounts.create(
        {
          type: 'express',
          country: String(req.body?.country || 'US').toUpperCase(),
          email: user.email,
          business_type: 'individual',
          capabilities: { transfers: { requested: true } },
          metadata: { user_id: user.id, role: user.role },
        },
        { idempotencyKey: `user:${user.id}:connect-account:v1` }
      );
      user = await prisma.user.update({ where: { id: user.id }, data: { stripeAccountId: account.id, stripeConnectOnboardingStatus: 'in_progress' } });
    }

    const origin = stripeOrigin(req);
    const refreshUrl = req.body?.refresh_url || req.body?.refreshUrl || `${origin}/?stripe_connect=refresh`;
    const returnUrl = req.body?.return_url || req.body?.returnUrl || `${origin}/?stripe_connect=return`;
    const link = await stripe.accountLinks.create({
      account: user.stripeAccountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding',
    });
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

  try {
    const existingIntent = tx.stripePaymentIntentId ? await stripe.paymentIntents.retrieve(tx.stripePaymentIntentId) : null;
    if (existingIntent && !['canceled', 'succeeded'].includes(existingIntent.status)) {
      return ok(res, {
        payment_intent_id: existingIntent.id,
        client_secret: existingIntent.client_secret,
        status: paymentStatusForIntent(existingIntent),
        stripe_status: existingIntent.status,
        project_id: project.id,
      });
    }

    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: toCents(tx.amountTotal),
        currency: 'usd',
        capture_method: 'manual',
        automatic_payment_methods: { enabled: true },
        customer: project.employer?.stripeCustomerId || undefined,
        payment_method: project.employer?.stripeDefaultPaymentMethodId || undefined,
        description: `CoGo City project funding${project.job?.title ? `: ${project.job.title}` : ''}`,
        metadata: {
          project_id: project.id,
          transaction_id: tx.id,
          payer_id: project.employerId,
          payee_id: project.studentId,
        },
      },
      { idempotencyKey: `project:${project.id}:tx:${tx.id}:intent:v2` }
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

  const workshopId = String(req.body?.workshop_id || req.body?.workshopId || '').trim();
  if (!workshopId) return fail(res, 400, 'workshop_id is required');

  const workshop = await prisma.workshop.findUnique({ where: { id: workshopId } });
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

  const amount = Number(job.postingFee || 0);
  if (amount <= 0) {
    const updated = await prisma.job.update({ where: { id: job.id }, data: { paymentStatus: 'paid', status: 'open' } });
    return ok(res, { job_id: updated.id, status: 'paid', free: true });
  }
  if (job.paymentStatus === 'paid') return ok(res, { job_id: job.id, status: 'paid', already_paid: true });

  const origin = stripeOrigin(req);
  try {
    const customerId = await ensureStripeCustomer(req.user);
    const session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        success_url: `${origin}/?stripe_job=${job.id}&stripe_status=success`,
        cancel_url: `${origin}/?stripe_job=${job.id}&stripe_status=cancel`,
        client_reference_id: job.id,
        customer: customerId,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: toCents(amount),
              product_data: { name: `CoGo City job listing: ${job.title}` },
            },
          },
        ],
        payment_intent_data: {
          metadata: { type: 'job_listing', job_id: job.id, user_id: req.user.id },
        },
        metadata: { type: 'job_listing', job_id: job.id, user_id: req.user.id },
      },
    );

    await prisma.job.update({ where: { id: job.id }, data: { paymentStatus: 'pending', status: 'pending' } });
    await writeAuditLog({ userId: req.user.id, action: 'job.checkout.create', entityType: 'job', entityId: job.id, payload: { checkoutSessionId: session.id } });
    return ok(res, serializeCheckoutSession(session, { job_id: job.id }));
  } catch (error) {
    return fail(res, 400, 'Failed to create job checkout session', error.message);
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
  const origin = stripeOrigin(req);

  try {
    const session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        success_url: `${origin}/?stripe_project=${project.id}&stripe_status=success`,
        cancel_url: `${origin}/?stripe_project=${project.id}&stripe_status=cancel`,
        client_reference_id: project.id,
        customer: project.employer?.stripeCustomerId || undefined,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: toCents(tx.amountTotal),
              product_data: { name: project.job?.title || 'CoGo City project funding' },
            },
          },
        ],
        payment_intent_data: {
          capture_method: 'manual',
          setup_future_usage: project.employer?.stripeCustomerId ? undefined : 'off_session',
          metadata: {
            project_id: project.id,
            transaction_id: tx.id,
            payer_id: project.employerId,
            payee_id: project.studentId,
          },
        },
        metadata: { project_id: project.id, transaction_id: tx.id },
      },
      { idempotencyKey: `project:${project.id}:tx:${tx.id}:checkout:v1` }
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

  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(tx.stripePaymentIntentId);
    if (paymentIntent.status === 'succeeded') return ok(res, { payment_intent_id: paymentIntent.id, status: 'paid', stripe_status: paymentIntent.status, project_id: project.id });
    if (paymentIntent.status !== 'requires_capture') return fail(res, 409, `Payment is not ready to capture (${paymentIntent.status})`);

    const captureAmount = req.body?.amount_total || req.body?.amountTotal ? toCents(req.body.amount_total ?? req.body.amountTotal) : undefined;
    const captured = await stripe.paymentIntents.capture(paymentIntent.id, captureAmount ? { amount_to_capture: captureAmount } : undefined);

    await prisma.transaction.update({ where: { id: tx.id }, data: { status: 'paid' } });
    await prisma.project.update({ where: { id: project.id }, data: { status: 'completed', completedAt: new Date() } });
    await createNotification({ data: { userId: project.studentId, type: notificationType('payout'), title: 'Payment released', body: 'Project payment has been released.', link: `/dashboard?section=transactions&project=${project.id}` } });
    await writeAuditLog({ userId: req.user.id, action: 'payment.intent.capture', entityType: 'transaction', entityId: tx.id, payload: { paymentIntentId: captured.id } });

    return ok(res, { payment_intent_id: captured.id, status: 'paid', stripe_status: captured.status, project_id: project.id });
  } catch (error) {
    return fail(res, 400, 'Failed to capture payment intent', error.message);
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
  if (!project.student?.stripeAccountId) return fail(res, 409, 'Student has not connected a Stripe payout account');
  if (!project.student?.stripePayoutsEnabled || !project.student?.stripeDetailsSubmitted) return fail(res, 409, 'Student Stripe payout account is not ready');

  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(tx.stripePaymentIntentId);
    if (paymentIntent.status !== 'succeeded') return fail(res, 409, `Payment is not captured (${paymentIntent.status})`);
    const latestCharge = typeof paymentIntent.latest_charge === 'string' ? paymentIntent.latest_charge : paymentIntent.latest_charge?.id;

    const transfer = await stripe.transfers.create(
      {
        amount: toCents(tx.studentPayout),
        currency: 'usd',
        destination: project.student.stripeAccountId,
        source_transaction: latestCharge || undefined,
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
    await writeAuditLog({ userId: req.user.id, action: 'payment.transfer.create', entityType: 'transaction', entityId: tx.id, payload: { transferId: transfer.id } });

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
