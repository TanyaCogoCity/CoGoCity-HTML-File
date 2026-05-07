const express = require('express');
const { prisma } = require('../lib/prisma');
const { ok, created, fail } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');
const { normalizeProjectStartPayload, normalizeProjectStatus, serializeProject, notificationType } = require('../lib/compat');
const { canTransition } = require('../lib/statusPolicy');
const { writeAuditLog } = require('../lib/audit');
const { ensureConversationBetweenUsers, sendSystemMessage } = require('../lib/messaging');
const { getOrCreateSystemUser } = require('../lib/systemUser');

const router = express.Router();

router.post('/start', requireAuth, async (req, res) => {
  if (!['employer', 'neighbor', 'admin'].includes(req.user.role)) return fail(res, 403, 'Only employer/neighbor/admin can start project');

  try {
    const payload = normalizeProjectStartPayload(req.body || {});
    if (!payload.applicationId) return fail(res, 400, 'application_id is required');

    const app = await prisma.application.findUnique({
      where: { id: payload.applicationId },
      include: { job: true },
    });
    if (!app || app.deletedAt || app.job.deletedAt) return fail(res, 404, 'Application not found');
    if (req.user.role !== 'admin' && app.job.createdBy !== req.user.id) return fail(res, 403, 'Forbidden');

    let project = await prisma.project.findFirst({ where: { applicationId: app.id, deletedAt: null } });

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
      });
    }

    await prisma.application.update({ where: { id: app.id }, data: { status: 'accepted' } });
    await prisma.job.update({ where: { id: app.jobId }, data: { status: 'pending' } });

    const existingTx = await prisma.transaction.findUnique({ where: { projectId: project.id } });
    if (!existingTx) {
      const total = Number(project.totalAmount || 0);
      const platformFee = Number((total * 0.1).toFixed(2));
      const studentPayout = Number((total - platformFee).toFixed(2));
      await prisma.transaction.create({
        data: {
          projectId: project.id,
          payerId: project.employerId,
          payeeId: project.studentId,
          amountTotal: total,
          platformFee,
          studentPayout,
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

    await prisma.notification.createMany({
      data: [
        {
          userId: project.studentId,
          type: notificationType('project'),
          title: 'Project started',
          body: `${app.job.title} has started`,
          link: `/dashboard?section=jobs_bookings&project=${project.id}`,
        },
        {
          userId: project.employerId,
          type: notificationType('payment'),
          title: 'Project funding required',
          body: `Fund project payment for ${app.job.title}`,
          link: `/dashboard?section=transactions&project=${project.id}`,
        },
      ],
    });

    await writeAuditLog({ userId: req.user.id, action: 'project.start', entityType: 'project', entityId: project.id, payload: req.body });

    return created(res, {
      ...serializeProject(project),
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
  });

  const tx = await prisma.transaction.findUnique({ where: { projectId: project.id } });
  if (tx) {
    const platformFee = Number((totalAmount * 0.1).toFixed(2));
    const studentPayout = Number((totalAmount - platformFee).toFixed(2));
    await prisma.transaction.update({ where: { id: tx.id }, data: { amountTotal: totalAmount, platformFee, studentPayout } });
  }

  await prisma.notification.create({
    data: {
      userId: project.employerId,
      type: notificationType('project'),
      title: 'Project completed by student',
      body: 'Review and approve payout.',
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

  const nextStatus = normalizeProjectStatus(req.body?.status || 'completed', false);
  if (!canTransition(project.status, nextStatus)) return fail(res, 409, `Invalid status transition from ${project.status} to ${nextStatus}`);

  const updated = await prisma.project.update({
    where: { id: project.id },
    data: {
      status: nextStatus,
      completedAt: nextStatus === 'completed' ? new Date() : null,
    },
  });

  const tx = await prisma.transaction.findUnique({ where: { projectId: project.id } });
  if (tx) {
    await prisma.transaction.update({ where: { id: tx.id }, data: { status: nextStatus === 'completed' ? 'paid' : tx.status } });
  }

  await prisma.job.updateMany({ where: { id: project.jobId || '' }, data: { status: 'closed' } });

  await prisma.notification.createMany({
    data: [
      {
        userId: project.studentId,
        type: notificationType('payout'),
        title: 'Payment approved',
        body: 'Your payout has been approved by employer.',
        link: `/dashboard?section=transactions&project=${project.id}`,
      },
      {
        userId: project.employerId,
        type: notificationType('payment'),
        title: 'Project approved',
        body: 'Payment release initiated.',
        link: `/dashboard?section=transactions&project=${project.id}`,
      },
    ],
  });

  await writeAuditLog({ userId: req.user.id, action: 'project.approve', entityType: 'project', entityId: project.id, payload: req.body });

  return ok(res, serializeProject(updated));
});

module.exports = router;
