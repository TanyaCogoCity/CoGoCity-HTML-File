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
    include: { creator: { include: { userProfile: true } } },
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
        hourlyRate: payload.hourlyRate || payload.postingFee || 1,
        location: payload.location,
        status: payload.status,
        companyName: payload.companyName,
        jobType: payload.jobType,
        workMode: payload.workMode,
        compensationText: payload.compensationText,
        requirements: payload.requirements,
        schedule: payload.schedule,
        expiresAt: payload.expiresAt,
        postingPackage: payload.postingPackage,
        postingFee: payload.postingFee,
        listingMonths: payload.listingMonths,
        listingDurationDays: payload.listingDurationDays,
        paymentStatus: payload.paymentStatus,
      },
      include: { creator: { include: { userProfile: true } } },
    });

    await writeAuditLog({ userId: req.user.id, action: 'job.create', entityType: 'job', entityId: job.id, payload: req.body });

    return created(res, serializeJob(job));
  } catch (error) {
    return fail(res, 400, 'Invalid job payload', error.message);
  }
});

router.patch('/:id', requireAuth, async (req, res) => {
  const existing = await prisma.job.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!existing) return fail(res, 404, 'Job not found');
  if (existing.createdBy !== req.user.id && req.user.role !== 'admin') return fail(res, 403, 'Only the job owner can update this job');

  try {
    const payload = normalizeJobPayload(Object.assign({}, serializeJob(existing), req.body || {}));
    const job = await prisma.job.update({
      where: { id: existing.id },
      data: {
        title: payload.title,
        description: payload.description,
        category: payload.category,
        hourlyRate: payload.hourlyRate || payload.postingFee || existing.hourlyRate,
        location: payload.location,
        status: payload.status,
        companyName: payload.companyName,
        jobType: payload.jobType,
        workMode: payload.workMode,
        compensationText: payload.compensationText,
        requirements: payload.requirements,
        schedule: payload.schedule,
        expiresAt: payload.expiresAt,
        postingPackage: payload.postingPackage,
        postingFee: payload.postingFee,
        listingMonths: payload.listingMonths,
        listingDurationDays: payload.listingDurationDays,
        paymentStatus: payload.paymentStatus,
      },
      include: { creator: { include: { userProfile: true } } },
    });

    await writeAuditLog({ userId: req.user.id, action: 'job.update', entityType: 'job', entityId: job.id, payload: req.body });
    return ok(res, serializeJob(job));
  } catch (error) {
    return fail(res, 400, 'Invalid job payload', error.message);
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  const existing = await prisma.job.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!existing) return fail(res, 404, 'Job not found');
  if (existing.createdBy !== req.user.id && req.user.role !== 'admin') return fail(res, 403, 'Only the job owner can remove this job');

  const job = await prisma.job.update({
    where: { id: existing.id },
    data: { deletedAt: new Date(), status: 'closed' },
  });
  await writeAuditLog({ userId: req.user.id, action: 'job.delete', entityType: 'job', entityId: job.id, payload: req.body });
  return ok(res, { id: job.id, deleted: true });
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
