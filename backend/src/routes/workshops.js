const express = require('express');
const { prisma } = require('../lib/prisma');
const { ok, created, fail } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');
const { writeAuditLog } = require('../lib/audit');
const { createNotification, createNotifications } = require('../lib/notifications');
const { notificationType } = require('../lib/compat');
const { stripeConnectReady } = require('../lib/onboardingGate');
const { notifyAdminWorkshopListed } = require('../lib/adminEmails');

const router = express.Router();

function serialize(workshop) {
  const creator = workshop.creator || workshop.createdByUser || null;
  return {
    id: workshop.id,
    title: workshop.title,
    description: workshop.description,
    price: Number(workshop.price),
    capacity: workshop.capacity,
    format: workshop.format,
    location: workshop.location,
    online_url: workshop.onlineUrl,
    duration_minutes: workshop.durationMinutes,
    status: workshop.status,
    start_date: workshop.startDate,
    created_by: workshop.createdBy,
    host_payout_setup_ready: creator ? stripeConnectReady(creator) : false,
    created_at: workshop.createdAt,
  };
}

function normalizedStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function isPublishedStatus(value) {
  const status = normalizedStatus(value);
  return status === 'published' || status === 'active';
}

function paidPublishedWorkshop(payload = {}) {
  return Number(payload.price || 0) > 0 && isPublishedStatus(payload.status);
}

async function requirePaidWorkshopPayoutReady(req, res, payload = {}) {
  if (!paidPublishedWorkshop(payload) || req.user.role === 'admin') return true;
  const host = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (stripeConnectReady(host)) return true;
  fail(res, 402, 'Paid workshops and classes cannot be published until Stripe Connect payout setup is complete. Free workshops can be published without payout setup.', {
    payout_setup_required: true,
    payment_type: 'workshop',
    action: 'complete_stripe_connect',
  });
  return false;
}

router.get('/', async (_req, res) => {
  const rows = await prisma.workshop.findMany({
    orderBy: { startDate: 'asc' },
    take: 200,
    include: { creator: true },
  });
  return ok(res, rows.map(serialize));
});

router.post('/', requireAuth, async (req, res) => {
  if (!['student', 'employer', 'neighbor', 'admin'].includes(req.user.role)) return fail(res, 403, 'Forbidden');

  const payload = req.body || {};
  const payoutReady = await requirePaidWorkshopPayoutReady(req, res, payload);
  if (!payoutReady) return null;

  const workshop = await prisma.workshop.create({
    data: {
      title: String(payload.title || '').trim(),
      description: String(payload.description || '').trim(),
      price: Number(payload.price ?? 0),
      capacity: payload.capacity == null ? null : Number(payload.capacity),
      format: payload.format === 'in_person' ? 'in_person' : 'online',
      location: payload.location || null,
      onlineUrl: payload.online_url || payload.onlineUrl || null,
      durationMinutes: payload.duration_minutes ?? payload.durationMinutes ?? null,
      status: payload.status || 'draft',
      startDate: payload.start_date ? new Date(payload.start_date) : new Date(),
      createdBy: req.user.id,
    },
    include: { creator: true },
  });

  await writeAuditLog({ userId: req.user.id, action: 'workshop.create', entityType: 'workshop', entityId: workshop.id, payload: req.body });
  if (isPublishedStatus(workshop.status)) {
    await notifyAdminWorkshopListed({
      host: req.user,
      workshop,
      link: `/workshops?id=${workshop.id}`,
    });
  }

  return created(res, serialize(workshop));
});

router.patch('/:id', requireAuth, async (req, res) => {
  const workshop = await prisma.workshop.findUnique({ where: { id: req.params.id } });
  if (!workshop) return fail(res, 404, 'Workshop not found');
  if (req.user.role !== 'admin' && workshop.createdBy !== req.user.id) return fail(res, 403, 'Forbidden');

  const payload = req.body || {};
  const nextPayload = {
    price: payload.price ?? workshop.price,
    status: payload.status ?? workshop.status,
  };
  const payoutReady = await requirePaidWorkshopPayoutReady(req, res, nextPayload);
  if (!payoutReady) return null;

  const data = {};
  if (payload.title != null) data.title = String(payload.title || '').trim();
  if (payload.description !== undefined) data.description = String(payload.description || '').trim();
  if (payload.price != null) data.price = Number(payload.price || 0);
  if (payload.capacity !== undefined) data.capacity = payload.capacity == null || payload.capacity === '' ? null : Number(payload.capacity);
  if (payload.format != null) data.format = payload.format === 'in_person' ? 'in_person' : 'online';
  if (payload.location !== undefined) data.location = payload.location || null;
  if (payload.online_url !== undefined || payload.onlineUrl !== undefined) data.onlineUrl = payload.online_url || payload.onlineUrl || null;
  if (payload.duration_minutes !== undefined || payload.durationMinutes !== undefined) data.durationMinutes = payload.duration_minutes ?? payload.durationMinutes ?? null;
  if (payload.status != null) data.status = payload.status;
  if (payload.start_date != null) data.startDate = new Date(payload.start_date);

  const updated = await prisma.workshop.update({ where: { id: workshop.id }, data, include: { creator: true } });
  await writeAuditLog({ userId: req.user.id, action: 'workshop.update', entityType: 'workshop', entityId: workshop.id, payload: req.body });
  if (!isPublishedStatus(workshop.status) && isPublishedStatus(updated.status)) {
    await notifyAdminWorkshopListed({
      host: req.user,
      workshop: updated,
      link: `/workshops?id=${updated.id}`,
    });
  }
  return ok(res, serialize(updated));
});

router.post('/:id/enroll', requireAuth, async (req, res) => {
  const workshop = await prisma.workshop.findUnique({ where: { id: req.params.id } });
  if (!workshop) return fail(res, 404, 'Workshop not found');
  if (Number(workshop.price || 0) > 0) return fail(res, 402, 'Paid workshop enrollments must use Stripe checkout');
  const quantity = Math.max(1, Number(req.body?.quantity || 1) || 1);

  const enrollment = await prisma.workshopEnrollment.upsert({
    where: { workshopId_userId: { workshopId: workshop.id, userId: req.user.id } },
    create: { workshopId: workshop.id, userId: req.user.id, quantity, paymentStatus: 'paid' },
    update: { quantity: { increment: quantity }, paymentStatus: 'paid' },
  });

  await createNotification({
    data: {
      userId: workshop.createdBy,
      type: notificationType('workshop'),
      title: 'New workshop registration',
      body: `${req.user.displayName} registered ${quantity} ticket${quantity === 1 ? '' : 's'} for ${workshop.title}`,
      link: `/dashboard?section=workshops&id=${workshop.id}`,
    },
  });

  await writeAuditLog({ userId: req.user.id, action: 'workshop.enroll.free', entityType: 'workshop_enrollment', entityId: enrollment.id, payload: req.body });

  return created(res, {
    id: enrollment.id,
    workshop_id: enrollment.workshopId,
    user_id: enrollment.userId,
    quantity: enrollment.quantity,
    payment_status: enrollment.paymentStatus,
    created_at: enrollment.createdAt,
  });
});

module.exports = router;
