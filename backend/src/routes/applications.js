const express = require('express');
const { prisma } = require('../lib/prisma');
const { ok, fail } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');
const { notificationType } = require('../lib/compat');
const { writeAuditLog } = require('../lib/audit');

const router = express.Router();

async function canManage(reqUser, applicationId) {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    include: { job: true },
  });
  if (!app || app.deletedAt || app.job.deletedAt) return { error: 'Application not found', app: null };
  if (reqUser.role !== 'admin' && app.job.createdBy !== reqUser.id) return { error: 'Forbidden', app: null };
  return { app };
}

router.patch('/:id/accept', requireAuth, async (req, res) => {
  const { app, error } = await canManage(req.user, req.params.id);
  if (error) return fail(res, error === 'Forbidden' ? 403 : 404, error);

  const updated = await prisma.application.update({ where: { id: app.id }, data: { status: 'accepted' } });

  await prisma.notification.create({
    data: {
      userId: updated.studentId,
      type: notificationType('application'),
      title: 'Application accepted',
      body: `You were accepted for ${app.job.title}`,
      link: '/dashboard?section=jobs_bookings',
    },
  });

  await writeAuditLog({ userId: req.user.id, action: 'application.accept', entityType: 'application', entityId: app.id });

  return ok(res, { id: updated.id, status: updated.status, job_id: updated.jobId, student_id: updated.studentId });
});

router.patch('/:id/reject', requireAuth, async (req, res) => {
  const { app, error } = await canManage(req.user, req.params.id);
  if (error) return fail(res, error === 'Forbidden' ? 403 : 404, error);

  const note = String(req.body?.message || '').trim();
  const updated = await prisma.application.update({ where: { id: app.id }, data: { status: 'rejected', message: note || app.message } });

  await prisma.notification.create({
    data: {
      userId: updated.studentId,
      type: notificationType('application'),
      title: 'Application update',
      body: note || `Your application for ${app.job.title} was not selected`,
      link: '/dashboard?section=jobs_bookings',
    },
  });

  await writeAuditLog({ userId: req.user.id, action: 'application.reject', entityType: 'application', entityId: app.id, payload: { message: note } });

  return ok(res, { id: updated.id, status: updated.status, message: updated.message });
});

module.exports = router;
