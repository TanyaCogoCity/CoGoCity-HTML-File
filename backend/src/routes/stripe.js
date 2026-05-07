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

router.post('/create-payment-intent', requireAuth, async (req, res) => {
  if (!stripe) return fail(res, 503, 'Stripe is not configured');
  if (!['employer', 'neighbor', 'admin'].includes(req.user.role)) return fail(res, 403, 'Only employer/neighbor/admin can initiate payment');

  const projectId = String(req.body?.project_id || req.body?.projectId || '').trim();
  if (!projectId) return fail(res, 400, 'project_id is required');

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project || project.deletedAt) return fail(res, 404, 'Project not found');
  if (req.user.role !== 'admin' && project.employerId !== req.user.id) return fail(res, 403, 'Forbidden');

  const tx = await prisma.transaction.findUnique({ where: { projectId } });
  if (!tx) return fail(res, 404, 'Transaction not found for this project');

  const amountCents = Math.max(1, Math.round(Number(tx.amountTotal) * 100));

  try {
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: amountCents,
        currency: 'usd',
        capture_method: 'manual',
        metadata: {
          project_id: project.id,
          transaction_id: tx.id,
          payer_id: project.employerId,
          payee_id: project.studentId,
        },
      },
      {
        idempotencyKey: `project:${project.id}:tx:${tx.id}:intent`,
      }
    );

    await prisma.transaction.update({
      where: { id: tx.id },
      data: {
        stripePaymentIntentId: paymentIntent.id,
        status: 'funded',
      },
    });

    await prisma.project.update({ where: { id: project.id }, data: { status: 'funded' } });

    await prisma.notification.create({
      data: {
        userId: project.studentId,
        type: notificationType('payment'),
        title: 'Funds secured',
        body: 'Project funds are secured on CoGo platform.',
        link: `/dashboard?section=transactions&project=${project.id}`,
      },
    });

    await writeAuditLog({ userId: req.user.id, action: 'payment.intent.create', entityType: 'transaction', entityId: tx.id, payload: { paymentIntentId: paymentIntent.id } });

    return ok(res, {
      payment_intent_id: paymentIntent.id,
      client_secret: paymentIntent.client_secret,
      status: 'funded',
      project_id: project.id,
    });
  } catch (error) {
    return fail(res, 400, 'Failed to create payment intent', error.message);
  }
});

router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(200).send('stripe_not_configured');
  const signature = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, config.stripeWebhookSecret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'payment_intent.succeeded' || event.type === 'payment_intent.amount_capturable_updated') {
      const pi = event.data.object;
      const tx = await prisma.transaction.findFirst({ where: { stripePaymentIntentId: pi.id } });
      if (tx) {
        await prisma.transaction.update({ where: { id: tx.id }, data: { status: 'funded' } });
      }
    }

    if (event.type === 'transfer.paid') {
      const transfer = event.data.object;
      const txId = transfer.metadata?.transaction_id;
      if (txId) {
        await prisma.transaction.update({ where: { id: txId }, data: { status: 'paid', stripeTransferId: transfer.id } });
      }
    }

    if (event.type === 'charge.refunded') {
      const charge = event.data.object;
      const piId = charge.payment_intent;
      const tx = await prisma.transaction.findFirst({ where: { stripePaymentIntentId: piId } });
      if (tx) {
        await prisma.transaction.update({ where: { id: tx.id }, data: { status: 'refunded' } });
      }
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    return res.status(500).json({ received: false, error: error.message });
  }
});

module.exports = router;
