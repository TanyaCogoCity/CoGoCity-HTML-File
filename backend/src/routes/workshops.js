const express = require('express');
const { prisma } = require('../lib/prisma');
const { ok, created, fail } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');
const { writeAuditLog } = require('../lib/audit');
const { notificationType } = require('../lib/compat');

const router = express.Router();

function serialize(workshop) {
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
    created_at: workshop.createdAt,
  };
}

router.get('/', async (_req, res) => {
  const rows = await prisma.workshop.findMany({ orderBy: { startDate: 'asc' }, take: 200 });
  return ok(res, rows.map(serialize));
});

router.post('/', requireAuth, async (req, res) => {
  if (!['student', 'employer', 'neighbor', 'admin'].includes(req.user.role)) return fail(res, 403, 'Forbidden');

  const payload = req.body || {};
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
  });

  await writeAuditLog({ userId: req.user.id, action: 'workshop.create', entityType: 'workshop', entityId: workshop.id, payload: req.body });

  return created(res, serialize(workshop));
});

router.post('/:id/enroll', requireAuth, async (req, res) => {
  const workshop = await prisma.workshop.findUnique({ where: { id: req.params.id } });
  if (!workshop) return fail(res, 404, 'Workshop not found');

  const enrollment = await prisma.workshopEnrollment.upsert({
    where: { workshopId_userId: { workshopId: workshop.id, userId: req.user.id } },
    create: { workshopId: workshop.id, userId: req.user.id, paymentStatus: 'paid' },
    update: { paymentStatus: 'paid' },
  });

  await prisma.notification.create({
    data: {
      userId: workshop.createdBy,
      type: notificationType('workshop'),
      title: 'New workshop registration',
      body: `${req.user.displayName} registered for ${workshop.title}`,
      link: `/dashboard?section=workshops&id=${workshop.id}`,
    },
  });

  await writeAuditLog({ userId: req.user.id, action: 'workshop.enroll', entityType: 'workshop_enrollment', entityId: enrollment.id, payload: req.body });

  return created(res, {
    id: enrollment.id,
    workshop_id: enrollment.workshopId,
    user_id: enrollment.userId,
    payment_status: enrollment.paymentStatus,
    created_at: enrollment.createdAt,
  });
});

module.exports = router;
