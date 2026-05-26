const express = require('express');
const { prisma } = require('../lib/prisma');
const { ok, created, fail } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');
const { normalizeProjectStartPayload, normalizeProjectStatus, serializeProject, notificationType } = require('../lib/compat');
const { canTransition } = require('../lib/statusPolicy');
const { writeAuditLog } = require('../lib/audit');
const { createNotification, createNotifications } = require('../lib/notifications');
const { ensureConversationBetweenUsers, sendSystemMessage } = require('../lib/messaging');
const { getOrCreateSystemUser } = require('../lib/systemUser');
const { requirePlatformReady } = require('../lib/onboardingGate');
const { calculateHourlyProjectFeesFromSettings } = require('../lib/platformFees');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const where = { deletedAt: null };
  if (req.user.role === 'student') {
    where.studentId = req.user.id;
  } else if (['employer', 'neighbor'].includes(req.user.role)) {
    where.employerId = req.user.id;
  } else if (req.user.role !== 'admin') {
    return fail(res, 403, 'Not authorized');
  }

  const projects = await prisma.project.findMany({
    where,
    include: {
      job: { include: { creator: { include: { userProfile: true } } } },
      transaction: true,
      reviews: { include: { reviewer: { select: { id: true, displayName: true } } }, orderBy: { createdAt: 'desc' } },
      application: {
        include: {
          student: { include: { userProfile: true, studentProfiles: { include: { services: true }, where: { deletedAt: null }, take: 1 } } },
          job: { include: { creator: { include: { userProfile: true } } } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  return ok(res, projects.map(serializeProject));
});

router.post('/start', requireAuth, async (req, res) => {
  if (!['employer', 'neighbor', 'admin'].includes(req.user.role)) return fail(res, 403, 'Only employer/neighbor/admin can start project');
  const gate = await requirePlatformReady({ prisma, user: req.user, requirePayment: true });
  if (!gate.ok) return fail(res, gate.status, gate.message, gate.requirements);

  try {
    const payload = normalizeProjectStartPayload(req.body || {});
    if (!payload.applicationId) return fail(res, 400, 'application_id is required');

    const app = await prisma.application.findUnique({
      where: { id: payload.applicationId },
      include: { job: true },
    });
    if (!app || app.deletedAt || app.job.deletedAt) return fail(res, 404, 'Application not found');
    if (req.user.role !== 'admin' && app.job.createdBy !== req.user.id) return fail(res, 403, 'Forbidden');

    let project = await prisma.project.findFirst({
      where: { applicationId: app.id, deletedAt: null },
      include: { job: { include: { creator: { include: { userProfile: true } } } }, transaction: true,
      reviews: { include: { reviewer: { select: { id: true, displayName: true } } }, orderBy: { createdAt: 'desc' } }, application: { include: { student: true, job: true } } },
    });

    const hourlyRate = payload.hourlyRate || Number(app.job.hourlyRate);
    const estimatedHours = payload.estimatedHours || null;

    if (!project) {
      project = await prisma.project.create({
        data: {
          jobId: app.jobId,
          applicationId: app.id,
          employerId: app.job.createdBy,
          studentId: app.studentId,
          status: normalizeProjectStatus(payload.status || 'in_progress', false),
          hourlyRate,
          estimatedHours,
          totalAmount: estimatedHours ? Number((hourlyRate * estimatedHours).toFixed(2)) : null,
        },
        include: { job: { include: { creator: { include: { userProfile: true } } } }, transaction: true,
      reviews: { include: { reviewer: { select: { id: true, displayName: true } } }, orderBy: { createdAt: 'desc' } }, application: { include: { student: true, job: true } } },
      });
    }

    await prisma.application.update({ where: { id: app.id }, data: { status: 'hired' } });
    await prisma.job.update({ where: { id: app.jobId }, data: { status: 'pending' } });

    const existingTx = await prisma.transaction.findUnique({ where: { projectId: project.id } });
    if (!existingTx) {
      const fees = await calculateHourlyProjectFeesFromSettings(prisma, Number(project.totalAmount || 0));
      await prisma.transaction.create({
        data: {
          projectId: project.id,
          payerId: project.employerId,
          payeeId: project.studentId,
          amountTotal: fees.employerTotal,
          platformFee: fees.platformFeeTotal,
          studentPayout: fees.studentPayout,
          status: 'pending',
        },
      });
    }

    const conversation = await ensureConversationBetweenUsers({
      userAId: project.employerId,
      userBId: project.studentId,
      projectId: project.id,
      label: `Project: ${app.job.title}`,
    });

    const systemUser = await getOrCreateSystemUser();
    await sendSystemMessage({
      conversationId: conversation.id,
      senderId: systemUser.id,
      text: `Project started for "${app.job.title}". Payment is pending funding.`,
    });

    await createNotifications({
      data: [
        {
          userId: project.studentId,
          type: notificationType('project'),
          title: 'Offer accepted / project started',
          body: `${app.job.title} has started. Open your dashboard to view the project and messages.`,
          link: `/dashboard?section=jobs_bookings&project=${project.id}`,
        },
        {
          userId: project.employerId,
          type: notificationType('payment'),
          title: 'Project funding required',
          body: `Fund project payment for ${app.job.title}. Open your dashboard to complete payment setup.`,
          link: `/dashboard?section=transactions&project=${project.id}`,
        },
      ],
    });

    await writeAuditLog({ userId: req.user.id, action: 'project.start', entityType: 'project', entityId: project.id, payload: req.body });

    const hydratedProject = await prisma.project.findUnique({
      where: { id: project.id },
      include: { job: { include: { creator: { include: { userProfile: true } } } }, transaction: true,
      reviews: { include: { reviewer: { select: { id: true, displayName: true } } }, orderBy: { createdAt: 'desc' } }, application: { include: { student: true, job: true } } },
    });

    return created(res, {
      ...serializeProject(hydratedProject || project),
      thread_id: conversation.id,
    });
  } catch (error) {
    return fail(res, 400, 'Project start failed', error.message);
  }
});

router.patch('/:id/complete', requireAuth, async (req, res) => {
  const project = await prisma.project.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!project) return fail(res, 404, 'Project not found');
  if (req.user.role !== 'admin' && project.studentId !== req.user.id) return fail(res, 403, 'Only assigned student can complete project');

  const nextStatus = 'awaiting_approval';
  if (!canTransition(project.status, nextStatus)) return fail(res, 409, `Invalid status transition from ${project.status} to ${nextStatus}`);

  const actualHours = Number(req.body?.actual_hours ?? req.body?.actualHours ?? project.actualHours ?? 0);
  const totalAmount = Number((actualHours * Number(project.hourlyRate)).toFixed(2));

  const updated = await prisma.project.update({
    where: { id: project.id },
    data: {
      status: nextStatus,
      actualHours,
      totalAmount,
    },
    include: { job: { include: { creator: { include: { userProfile: true } } } }, transaction: true,
      reviews: { include: { reviewer: { select: { id: true, displayName: true } } }, orderBy: { createdAt: 'desc' } }, application: { include: { student: true, job: true } } },
  });

  const tx = await prisma.transaction.findUnique({ where: { projectId: project.id } });
  if (tx) {
    const fees = await calculateHourlyProjectFeesFromSettings(prisma, totalAmount);
    await prisma.transaction.update({
      where: { id: tx.id },
      data: {
        amountTotal: fees.employerTotal,
        platformFee: fees.platformFeeTotal,
        studentPayout: fees.studentPayout,
      },
    });
  }

  await createNotification({
    data: {
      userId: project.employerId,
      type: notificationType('project'),
      title: 'Project completed by student',
      body: 'The student marked the job complete. Open your dashboard to review the work and approve payment.',
      link: `/dashboard?section=applicants_projects&project=${project.id}`,
    },
  });

  await writeAuditLog({ userId: req.user.id, action: 'project.complete', entityType: 'project', entityId: project.id, payload: req.body });

  return ok(res, serializeProject(updated));
});

router.patch('/:id/approve', requireAuth, async (req, res) => {
  const project = await prisma.project.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!project) return fail(res, 404, 'Project not found');
  if (req.user.role !== 'admin' && project.employerId !== req.user.id) return fail(res, 403, 'Only employer can approve');
  const gate = await requirePlatformReady({ prisma, user: req.user, requirePayment: true });
  if (!gate.ok) return fail(res, gate.status, gate.message, gate.requirements);

  const nextStatus = normalizeProjectStatus(req.body?.status || 'completed', false);
  if (!canTransition(project.status, nextStatus)) return fail(res, 409, `Invalid status transition from ${project.status} to ${nextStatus}`);

  const updated = await prisma.project.update({
    where: { id: project.id },
    data: {
      status: nextStatus,
      completedAt: nextStatus === 'completed' ? new Date() : null,
    },
    include: { job: { include: { creator: { include: { userProfile: true } } } }, transaction: true,
      reviews: { include: { reviewer: { select: { id: true, displayName: true } } }, orderBy: { createdAt: 'desc' } }, application: { include: { student: true, job: true } } },
  });

  const tx = await prisma.transaction.findUnique({ where: { projectId: project.id } });
  if (tx && nextStatus === 'completed') {
    await prisma.transaction.update({ where: { id: tx.id }, data: { status: 'paid' } });
  }

  if (nextStatus === 'completed') {
    await prisma.job.updateMany({ where: { id: project.jobId || '' }, data: { status: 'closed' } });
    await createNotifications({
      data: [
        {
          userId: project.studentId,
          type: notificationType('payout'),
          title: 'Payment approved',
          body: 'Your payout has been approved by the employer. Open your dashboard to view the transaction.',
          link: `/dashboard?section=transactions&project=${project.id}`,
        },
        {
          userId: project.employerId,
          type: notificationType('payment'),
          title: 'Project approved',
          body: 'Payment release was initiated. Please leave a review for the student from your dashboard.',
          link: `/dashboard?section=transactions&project=${project.id}`,
        },
        {
          userId: project.employerId,
          type: notificationType('project'),
          title: 'Leave a review',
          body: 'The job is done. Please leave a review so future CoGoCity users can learn from your experience.',
          link: `/dashboard?section=applicants_projects&project=${project.id}`,
        },
        {
          userId: project.studentId,
          type: notificationType('project'),
          title: 'Leave a review',
          body: 'The job is done. Please leave a review for your CoGoCity experience.',
          link: `/dashboard?section=jobs_bookings&project=${project.id}`,
        },
      ],
    });
  } else if (nextStatus === 'in_progress') {
    await createNotification({
      data: {
        userId: project.studentId,
        type: notificationType('project'),
        title: 'Project changes requested',
        body: req.body?.note || 'Employer requested changes before approval. Open your dashboard to review the request.',
        link: `/dashboard?section=jobs_bookings&project=${project.id}`,
      },
    });
  }

  await writeAuditLog({ userId: req.user.id, action: 'project.approve', entityType: 'project', entityId: project.id, payload: req.body });

  return ok(res, serializeProject(updated));
});

module.exports = router;
