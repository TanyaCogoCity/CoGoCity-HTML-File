const express = require('express');
const { prisma } = require('../lib/prisma');
const { ok, created, fail } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');
const { normalizeJobPayload, serializeJob, normalizeApplicationStatus, serializeApplication, normalizeApplyPayload, notificationType } = require('../lib/compat');
const { writeAuditLog } = require('../lib/audit');
const { requirePlatformReady } = require('../lib/onboardingGate');
const { createNotification, createNotifications } = require('../lib/notifications');
const { getDirectJobPackage, applyDirectJobPackagePricing } = require('../lib/directJobPackages');
const { ensureConversationBetweenUsers, sendSystemMessage } = require('../lib/messaging');
const { getOrCreateSystemUser } = require('../lib/systemUser');
const { notifyAdminJobListingCreated } = require('../lib/adminEmails');

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
  if (!['employer', 'admin'].includes(req.user.role)) return fail(res, 403, 'Only employer/admin can create direct job listings. Neighbors should post jobs through Community Gigs.');
  const gate = await requirePlatformReady({ prisma, user: req.user, requirePayment: true });
  if (!gate.ok) return fail(res, gate.status, gate.message, gate.requirements);

  try {
    const requestedPayload = normalizeJobPayload(req.body || {});
    const pkg = await getDirectJobPackage(prisma, requestedPayload.postingPackage || 'basic');
    const payload = applyDirectJobPackagePricing(requestedPayload, pkg);
    if (payload.postingFee > 0 && req.user.role !== 'admin') payload.paymentStatus = 'pending';
    if (!payload.title || payload.hourlyRate <= 0) return fail(res, 400, 'title and rate are required');

    const job = await prisma.job.create({
      data: {
        createdBy: req.user.id,
        title: payload.title,
        description: payload.description,
        category: payload.category,
        hourlyRate: payload.hourlyRate || payload.postingFee || 1,
        location: payload.location,
        status: payload.paymentStatus === 'pending' ? 'pending' : payload.status,
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
    await notifyAdminJobListingCreated({
      employer: req.user,
      job,
      link: `/dashboard?section=my_jobs&job=${job.id}`,
    });

    return created(res, serializeJob(job));
  } catch (error) {
    return fail(res, 400, 'Invalid job payload', error.message);
  }
});

router.patch('/:id', requireAuth, async (req, res) => {
  const gate = await requirePlatformReady({ prisma, user: req.user, requirePayment: true });
  if (!gate.ok) return fail(res, gate.status, gate.message, gate.requirements);

  const existing = await prisma.job.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!existing) return fail(res, 404, 'Job not found');
  if (existing.createdBy !== req.user.id && req.user.role !== 'admin') return fail(res, 403, 'Only the job owner can update this job');

  try {
    const requestedPayload = normalizeJobPayload(Object.assign({}, serializeJob(existing), req.body || {}));
    const pkg = await getDirectJobPackage(prisma, requestedPayload.postingPackage || existing.postingPackage || 'basic');
    const payload = existing.paymentStatus === 'paid'
      ? Object.assign({}, requestedPayload, {
          postingPackage: existing.postingPackage || requestedPayload.postingPackage || 'basic',
          postingFee: Number(existing.postingFee || 0),
          listingMonths: existing.listingMonths || requestedPayload.listingMonths,
          listingDurationDays: existing.listingDurationDays || requestedPayload.listingDurationDays,
          paymentStatus: existing.paymentStatus,
        })
      : applyDirectJobPackagePricing(requestedPayload, pkg);
    if (payload.postingFee > 0 && req.user.role !== 'admin' && existing.paymentStatus !== 'paid') payload.paymentStatus = 'pending';
    const job = await prisma.job.update({
      where: { id: existing.id },
      data: {
        title: payload.title,
        description: payload.description,
        category: payload.category,
        hourlyRate: payload.hourlyRate || payload.postingFee || existing.hourlyRate,
        location: payload.location,
        status: payload.paymentStatus === 'pending' ? 'pending' : payload.status,
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

router.get('/applications/me', requireAuth, async (req, res) => {
  const where = { deletedAt: null };
  if (req.user.role === 'student') {
    where.studentId = req.user.id;
  } else if (['employer', 'neighbor'].includes(req.user.role)) {
    where.job = { createdBy: req.user.id, deletedAt: null };
  } else if (req.user.role !== 'admin') {
    return fail(res, 403, 'Not authorized');
  }

  const applications = await prisma.application.findMany({
    where,
    include: {
      student: { include: { userProfile: true, studentProfiles: { include: { services: true }, where: { deletedAt: null }, take: 1 } } },
      job: { include: { creator: { include: { userProfile: true } } } },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return ok(res, applications.map(serializeApplication));
});

router.get('/:id', async (req, res) => {
  const job = await prisma.job.findFirst({
    where: { id: req.params.id, deletedAt: null },
    include: { creator: { include: { userProfile: true } } },
  });
  if (!job) return fail(res, 404, 'Job not found');
  return ok(res, serializeJob(job));
});

router.patch('/applications/:applicationId', requireAuth, async (req, res) => {
  const existing = await prisma.application.findFirst({
    where: { id: req.params.applicationId, deletedAt: null },
    include: { job: true },
  });
  if (!existing) return fail(res, 404, 'Application not found');

  const isOwner = existing.job.createdBy === req.user.id;
  const isStudent = existing.studentId === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isStudent && !isAdmin) return fail(res, 403, 'Not authorized to update this application');
  if (isOwner || (isAdmin && ['employer', 'neighbor'].includes(req.user.role))) {
    const gate = await requirePlatformReady({ prisma, user: req.user, requirePayment: ['employer', 'neighbor'].includes(req.user.role) });
    if (!gate.ok) return fail(res, gate.status, gate.message, gate.requirements);
  }

  const body = req.body || {};
  const nextStatus = normalizeApplicationStatus(body.status || existing.status);
  if (isStudent && !isAdmin && !['withdrawn', 'applied'].includes(nextStatus)) return fail(res, 403, 'Students can only withdraw or resubmit their own applications');

  const app = await prisma.application.update({
    where: { id: existing.id },
    data: {
      status: nextStatus,
      message: body.message == null ? existing.message : String(body.message || ''),
      resumeFileName: body.resume_file_name == null && body.resumeFileName == null ? existing.resumeFileName : String(body.resume_file_name || body.resumeFileName || ''),
      resumeDataUrl: body.resume_data_url == null && body.resumeDataUrl == null ? existing.resumeDataUrl : String(body.resume_data_url || body.resumeDataUrl || ''),
    },
    include: {
      student: { include: { userProfile: true, studentProfiles: { include: { services: true }, where: { deletedAt: null }, take: 1 } } },
      job: { include: { creator: { include: { userProfile: true } } } },
    },
  });

  const notifyUserId = isOwner ? app.studentId : app.job.createdBy;
  const studentName = app.student?.displayName || app.student?.userProfile?.firstName || 'Student';
  const statusLabels = {
    applied: 'Application submitted',
    reviewing: `Your "${app.job.title}" application is under review.`,
    shortlisted: `Your "${app.job.title}" application was shortlisted.`,
    hired: `Your "${app.job.title}" application is now hired.`,
    rejected: `Your "${app.job.title}" application was not selected.`,
    withdrawn: `Student ${studentName} withdrew their application for "${app.job.title}".`,
  };
  const dashboardLink = isOwner
    ? `/dashboard?section=direct_hire&job=${app.jobId}`
    : `/dashboard?section=my_jobs&job=${app.jobId}`;
  await createNotification({
    data: {
      userId: notifyUserId,
      type: notificationType('application'),
      title: statusLabels[nextStatus] || 'Application updated',
      body: `${app.job.title} application is now ${nextStatus}. Open your dashboard for details.`,
      link: dashboardLink,
    },
  });
  if (isOwner && ['reviewing', 'shortlisted', 'hired', 'rejected'].includes(nextStatus)) {
    const systemUser = await getOrCreateSystemUser();
    const conversation = await ensureConversationBetweenUsers({
      userAId: systemUser.id,
      userBId: app.studentId,
      label: `Direct Hire Job: ${app.job.title}`,
    });
    await sendSystemMessage({
      conversationId: conversation.id,
      senderId: systemUser.id,
      text: `Direct Hire update for "${app.job.title}": your application is ${nextStatus.replaceAll('_', ' ')}.`,
    });
  }
  await writeAuditLog({ userId: req.user.id, action: 'application.update', entityType: 'application', entityId: app.id, payload: req.body });
  return ok(res, serializeApplication(app));
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
        resumeFileName: payload.resumeFileName,
        resumeDataUrl: payload.resumeDataUrl,
      },
      update: {
        message: payload.message,
        status: 'applied',
        resumeFileName: payload.resumeFileName,
        resumeDataUrl: payload.resumeDataUrl,
        deletedAt: null,
      },
      include: {
        student: { include: { userProfile: true, studentProfiles: { include: { services: true }, where: { deletedAt: null }, take: 1 } } },
        job: { include: { creator: { include: { userProfile: true } } } },
      },
    });

    const applicantName = req.user.displayName || 'A student';
    await createNotification({
      data: {
        userId: job.createdBy,
        type: notificationType('application'),
        title: `${applicantName} applied to "${job.title}" with a resume.`,
        body: `${applicantName} applied to ${job.title}. Open your dashboard to review the resume.`,
        link: `/dashboard?section=my_jobs&employerMyJobsTab=applications&job=${job.id}`,
      },
    });

    await writeAuditLog({ userId: req.user.id, action: 'application.apply', entityType: 'application', entityId: app.id, payload: req.body });

    return created(res, Object.assign(serializeApplication(app), { thread_id: payload.threadId }));
  } catch (error) {
    return fail(res, 400, 'Application failed', error.message);
  }
});

module.exports = router;
