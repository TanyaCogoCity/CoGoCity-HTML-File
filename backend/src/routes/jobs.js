const express = require('express');
const { prisma } = require('../lib/prisma');
const { ok, created, fail } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');
const { normalizeJobPayload, serializeJob, normalizeApplyPayload, notificationType } = require('../lib/compat');
const { writeAuditLog } = require('../lib/audit');

const router = express.Router();

router.get('/', async (req, res) => {
  const jobs = await prisma.job.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return ok(res, jobs.map(serializeJob));
});

router.post('/', requireAuth, async (req, res) => {
  if (!['employer', 'neighbor', 'admin'].includes(req.user.role)) return fail(res, 403, 'Only employer/neighbor/admin can create jobs');

  try {
    const payload = normalizeJobPayload(req.body || {});
    if (!payload.title || payload.hourlyRate <= 0) return fail(res, 400, 'title and rate are required');

    const job = await prisma.job.create({
      data: {
        createdBy: req.user.id,
        title: payload.title,
        description: payload.description,
        category: payload.category,
        hourlyRate: payload.hourlyRate,
        location: payload.location,
        status: payload.status,
      },
    });

    await writeAuditLog({ userId: req.user.id, action: 'job.create', entityType: 'job', entityId: job.id, payload: req.body });

    return created(res, serializeJob(job));
  } catch (error) {
    return fail(res, 400, 'Invalid job payload', error.message);
  }
});

router.post('/:id/apply', requireAuth, async (req, res) => {
  if (req.user.role !== 'student') return fail(res, 403, 'Only students can apply');

  const job = await prisma.job.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!job) return fail(res, 404, 'Job not found');
  if (job.createdBy === req.user.id) return fail(res, 400, 'Cannot apply to your own job');

  const payload = normalizeApplyPayload(req.body || {});

  try {
    const app = await prisma.application.upsert({
      where: { jobId_studentId: { jobId: job.id, studentId: req.user.id } },
      create: {
        jobId: job.id,
        studentId: req.user.id,
        status: 'applied',
        message: payload.message,
      },
      update: {
        message: payload.message,
        status: 'applied',
      },
    });

    await prisma.notification.create({
      data: {
        userId: job.createdBy,
        type: notificationType('application'),
        title: 'New application received',
        body: `${req.user.displayName} applied to ${job.title}`,
        link: `/dashboard?section=applicants_projects&job=${job.id}`,
      },
    });

    await writeAuditLog({ userId: req.user.id, action: 'application.apply', entityType: 'application', entityId: app.id, payload: req.body });

    return created(res, {
      id: app.id,
      job_id: app.jobId,
      student_id: app.studentId,
      status: app.status,
      message: app.message,
      created_at: app.createdAt,
      thread_id: payload.threadId,
    });
  } catch (error) {
    return fail(res, 400, 'Application failed', error.message);
  }
});

module.exports = router;
