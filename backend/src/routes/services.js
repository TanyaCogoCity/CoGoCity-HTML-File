const express = require('express');
const { prisma } = require('../lib/prisma');
const { ok, created, fail } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');
const { normalizeServicePayload, serializeService } = require('../lib/compat');
const { writeAuditLog } = require('../lib/audit');

const router = express.Router();

router.get('/', async (req, res) => {
  const services = await prisma.service.findMany({
    where: { deletedAt: null, isActive: true },
    orderBy: { createdAt: 'desc' },
    include: { reviews: { include: { reviewer: { select: { id: true, displayName: true } } }, orderBy: { createdAt: 'desc' } } },
    take: 200,
  });
  return ok(res, services.map(serializeService));
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const payload = normalizeServicePayload(req.body || {});
    if (!payload.profileId || !payload.title || payload.hourlyRate <= 0) {
      return fail(res, 400, 'profile_id, title, and rate are required');
    }

    const profile = await prisma.studentProfile.findFirst({ where: { id: payload.profileId, deletedAt: null } });
    if (!profile) return fail(res, 404, 'Student profile not found');
    if (profile.userId !== req.user.id && req.user.role !== 'admin') return fail(res, 403, 'Cannot modify this profile');

    const service = await prisma.service.create({
      data: {
        profileId: payload.profileId,
        title: payload.title,
        description: payload.description,
        hourlyRate: payload.hourlyRate,
        availability: payload.availability,
        location: payload.location,
        isActive: Boolean(payload.isActive),
      },
    });

    await writeAuditLog({ userId: req.user.id, action: 'service.create', entityType: 'service', entityId: service.id, payload: req.body });

    return created(res, serializeService(service));
  } catch (error) {
    return fail(res, 400, 'Invalid service payload', error.message);
  }
});

router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const service = await prisma.service.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: { profile: true },
    });
    if (!service) return fail(res, 404, 'Service not found');
    if (service.profile.userId !== req.user.id && req.user.role !== 'admin') return fail(res, 403, 'Forbidden');

    const payload = normalizeServicePayload({ ...service, ...req.body });
    const updated = await prisma.service.update({
      where: { id: service.id },
      data: {
        title: payload.title,
        description: payload.description,
        hourlyRate: payload.hourlyRate,
        availability: payload.availability,
        location: payload.location,
        isActive: Boolean(payload.isActive),
      },
    });

    await writeAuditLog({ userId: req.user.id, action: 'service.update', entityType: 'service', entityId: service.id, payload: req.body });

    return ok(res, serializeService(updated));
  } catch (error) {
    return fail(res, 400, 'Invalid update payload', error.message);
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const service = await prisma.service.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: { profile: true },
    });
    if (!service) return fail(res, 404, 'Service not found');
    if (service.profile.userId !== req.user.id && req.user.role !== 'admin') return fail(res, 403, 'Forbidden');

    const updated = await prisma.service.update({
      where: { id: service.id },
      data: { deletedAt: new Date(), isActive: false },
    });

    await writeAuditLog({ userId: req.user.id, action: 'service.delete', entityType: 'service', entityId: service.id, payload: null });

    return ok(res, serializeService(updated));
  } catch (error) {
    return fail(res, 400, 'Unable to delete service', error.message);
  }
});

module.exports = router;
