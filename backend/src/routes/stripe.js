const express = require('express');
const Stripe = require('stripe');
const { prisma } = require('../lib/prisma');
const { ok, fail } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');
const config = require('../config');
const { writeAuditLog } = require('../lib/audit');
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

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.payment_intent) {
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

router.post('/create-checkout-session', requireAuth, async (req, res) => {
  if (!stripe) return fail(res, 503, 'Stripe is not configured');
  if (!['employer', 'neighbor', 'admin'].includes(req.user.role)) return fail(res, 403, 'Only employer/neighbor/admin can initiate payment');

  const projectId = String(req.body?.project_id || req.body?.projectId || '').trim();
  if (!projectId) return fail(res, 400, 'project_id is required');

  const loaded = await loadProjectForPayment(projectId, req.user);
  if (loaded.error) return fail(res, loaded.error[0], loaded.error[1]);
  const { project, tx } = loaded;
  const origin = req.get('origin') || 'https://staging.cogocity.com';

  try {
    const session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        success_url: `${origin}/?stripe_project=${project.id}&stripe_status=success`,
        cancel_url: `${origin}/?stripe_project=${project.id}&stripe_status=cancel`,
        client_reference_id: project.id,
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
    await prisma.notification.create({ data: { userId: project.studentId, type: notificationType('payout'), title: 'Payment released', body: 'Project payment has been released.', link: `/dashboard?section=transactions&project=${project.id}` } });
    await writeAuditLog({ userId: req.user.id, action: 'payment.intent.capture', entityType: 'transaction', entityId: tx.id, payload: { paymentIntentId: captured.id } });

    return ok(res, { payment_intent_id: captured.id, status: 'paid', stripe_status: captured.status, project_id: project.id });
  } catch (error) {
    return fail(res, 400, 'Failed to capture payment intent', error.message);
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
