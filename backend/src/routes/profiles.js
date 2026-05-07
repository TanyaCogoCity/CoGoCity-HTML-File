const express = require('express');
const { prisma } = require('../lib/prisma');
const { ok, created, fail } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');
const { writeAuditLog } = require('../lib/audit');
const { serializeService } = require('../lib/compat');

const router = express.Router();

router.get('/student-profiles', async (req, res) => {
  const userId = String(req.query.user_id || req.query.userId || '').trim();
  const where = { deletedAt: null, isActive: true };
  if (userId) where.userId = userId;

  const rows = await prisma.studentProfile.findMany({
    where,
    include: {
      services: { where: { deletedAt: null, isActive: true }, orderBy: { createdAt: 'desc' } },
      user: { select: { id: true, displayName: true, city: true, role: true, userProfile: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  return ok(res, rows.map((p) => ({
    id: p.id,
    user_id: p.userId,
    userId: p.userId,
    title: p.title,
    bio: p.bio,
    experience: p.experience,
    is_active: p.isActive,
    created_at: p.createdAt,
    services: (p.services || []).map(serializeService),
    user: p.user,
    profile: p.user?.userProfile || null,
  })));
});

router.post('/student-profiles', requireAuth, async (req, res) => {
  if (!['student', 'admin'].includes(req.user.role)) return fail(res, 403, 'Only student/admin can create profiles');

  const payload = req.body || {};
  const profile = await prisma.studentProfile.create({
    data: {
      userId: req.user.id,
      title: String(payload.title || '').trim() || 'Student Service',
      bio: String(payload.bio || payload.about || ''),
      experience: String(payload.experience || payload.highlights || ''),
      isActive: payload.is_active ?? payload.isActive ?? true,
    },
  });

  await writeAuditLog({ userId: req.user.id, action: 'student_profile.create', entityType: 'student_profile', entityId: profile.id, payload: req.body });

  return created(res, {
    id: profile.id,
    user_id: profile.userId,
    title: profile.title,
    bio: profile.bio,
    experience: profile.experience,
    is_active: profile.isActive,
    created_at: profile.createdAt,
  });
});

router.patch('/student-profiles/:id', requireAuth, async (req, res) => {
  const profile = await prisma.studentProfile.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!profile) return fail(res, 404, 'Profile not found');
  if (req.user.role !== 'admin' && profile.userId !== req.user.id) return fail(res, 403, 'Forbidden');

  const payload = req.body || {};
  const updated = await prisma.studentProfile.update({
    where: { id: profile.id },
    data: {
      title: payload.title ?? profile.title,
      bio: payload.bio ?? payload.about ?? profile.bio,
      experience: payload.experience ?? payload.highlights ?? profile.experience,
      isActive: payload.is_active ?? payload.isActive ?? profile.isActive,
    },
  });

  await writeAuditLog({ userId: req.user.id, action: 'student_profile.update', entityType: 'student_profile', entityId: profile.id, payload: req.body });

  return ok(res, {
    id: updated.id,
    user_id: updated.userId,
    title: updated.title,
    bio: updated.bio,
    experience: updated.experience,
    is_active: updated.isActive,
    created_at: updated.createdAt,
  });
});

module.exports = router;
