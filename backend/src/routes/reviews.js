const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { created, fail } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');
const { writeAuditLog } = require('../lib/audit');
const { notificationType, serializeReview } = require('../lib/compat');
const { createNotification } = require('../lib/notifications');

const router = express.Router();

function isUuid(value = '') {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

router.post('/projects/:id/review', requireAuth, async (req, res) => {
  try {
    const schema = z.object({
      rating: z.number().int().min(1).max(5),
      comment: z.string().max(2000).optional(),
      service_id: z.string().uuid().optional(),
      serviceId: z.string().uuid().optional(),
    });
    const payload = schema.parse(req.body || {});

    if (!isUuid(req.params.id)) return fail(res, 404, 'Project not found');

    const project = await prisma.project.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: { job: true },
    });
    if (!project) return fail(res, 404, 'Project not found');
    if (project.status !== 'completed') return fail(res, 409, 'Review is only allowed after project completion');
    if (![project.employerId, project.studentId].includes(req.user.id)) return fail(res, 403, 'Not allowed');

    const review = await prisma.review.upsert({
      where: { projectId_reviewerId: { projectId: project.id, reviewerId: req.user.id } },
      create: {
        projectId: project.id,
        reviewerId: req.user.id,
        studentId: project.studentId,
        serviceId: payload.serviceId || payload.service_id || project.serviceId || null,
        rating: payload.rating,
        comment: payload.comment || '',
      },
      update: {
        serviceId: payload.serviceId || payload.service_id || project.serviceId || null,
        rating: payload.rating,
        comment: payload.comment || '',
      },
      include: { reviewer: { select: { id: true, displayName: true } } },
    });

    const recipientId = req.user.id === project.studentId ? project.employerId : project.studentId;
    if (recipientId) {
      await createNotification({
        data: {
          userId: recipientId,
          type: notificationType('project'),
          title: `${req.user.displayName || 'A CoGoCity user'} left you a ${payload.rating}/5 review.`,
          body: `${req.user.displayName || 'A CoGoCity user'} left a review for ${project.job?.title || 'your project'}. Open your dashboard to view it.`,
          link: `/dashboard?section=${recipientId === project.studentId ? 'jobs_bookings' : 'applicants_projects'}&project=${project.id}`,
        },
      });
    }

    await writeAuditLog({ userId: req.user.id, action: 'review.create', entityType: 'review', entityId: review.id, payload: req.body });

    return created(res, serializeReview(review));
  } catch (error) {
    return fail(res, 400, 'Invalid review payload', error.message);
  }
});

router.post('/applications/:id/review', requireAuth, async (req, res) => {
  try {
    const schema = z.object({
      rating: z.number().int().min(1).max(5),
      comment: z.string().max(2000).optional(),
      service_id: z.string().uuid().optional(),
      serviceId: z.string().uuid().optional(),
    });
    const payload = schema.parse(req.body || {});

    if (!isUuid(req.params.id)) return fail(res, 404, 'Application not found');

    const app = await prisma.application.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: {
        job: true,
        student: {
          include: {
            studentProfiles: {
              where: { deletedAt: null, isActive: true },
              include: { services: { where: { deletedAt: null, isActive: true }, orderBy: { createdAt: 'desc' } } },
              take: 1,
            },
          },
        },
      },
    });
    if (!app || app.job.deletedAt) return fail(res, 404, 'Application not found');
    if (app.status !== 'hired') return fail(res, 409, 'Review is only allowed after the candidate is hired');
    if (req.user.role !== 'admin' && app.job.createdBy !== req.user.id) return fail(res, 403, 'Not allowed');

    const preferredServiceId = payload.serviceId || payload.service_id || app.student.studentProfiles?.[0]?.services?.[0]?.id || null;
    let project = await prisma.project.findFirst({
      where: { applicationId: app.id, deletedAt: null },
    });
    if (!project) {
      project = await prisma.project.create({
        data: {
          jobId: app.jobId,
          applicationId: app.id,
          employerId: app.job.createdBy,
          studentId: app.studentId,
          serviceId: preferredServiceId,
          status: 'completed',
          hourlyRate: Number(app.job.hourlyRate || 0),
          estimatedHours: null,
          actualHours: null,
          totalAmount: null,
          completedAt: new Date(),
        },
      });
    } else if (project.status !== 'completed' || (!project.serviceId && preferredServiceId)) {
      project = await prisma.project.update({
        where: { id: project.id },
        data: {
          status: 'completed',
          completedAt: project.completedAt || new Date(),
          serviceId: project.serviceId || preferredServiceId,
        },
      });
    }

    const review = await prisma.review.upsert({
      where: { projectId_reviewerId: { projectId: project.id, reviewerId: req.user.id } },
      create: {
        projectId: project.id,
        reviewerId: req.user.id,
        studentId: app.studentId,
        serviceId: project.serviceId || preferredServiceId,
        rating: payload.rating,
        comment: payload.comment || '',
      },
      update: {
        serviceId: project.serviceId || preferredServiceId,
        rating: payload.rating,
        comment: payload.comment || '',
      },
      include: { reviewer: { select: { id: true, displayName: true } } },
    });

    await createNotification({
      data: {
        userId: app.studentId,
        type: notificationType('project'),
        title: `${req.user.displayName || 'A CoGoCity user'} left you a ${payload.rating}/5 review.`,
        body: `${req.user.displayName || 'A CoGoCity user'} left a review for ${app.job.title || 'your work'}. Open your profile to view it.`,
        link: `/dashboard?section=profile`,
      },
    });

    await writeAuditLog({ userId: req.user.id, action: 'review.create.application', entityType: 'review', entityId: review.id, payload: req.body });

    return created(res, Object.assign(serializeReview(review), {
      project_id: project.id,
      projectId: project.id,
      application_id: app.id,
      applicationId: app.id,
    }));
  } catch (error) {
    return fail(res, 400, 'Invalid review payload', error.message);
  }
});

module.exports = router;
