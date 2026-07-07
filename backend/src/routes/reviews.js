const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { created, ok, fail } = require('../lib/http');
const { requireAuth, requireRoles } = require('../middleware/auth');
const { writeAuditLog } = require('../lib/audit');
const { notificationType, serializeReview } = require('../lib/compat');
const { createNotification } = require('../lib/notifications');

const router = express.Router();

function isUuid(value = '') {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function normalizeText(value = '') {
  return String(value || '').trim().toLowerCase();
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
          dedupeKey: `project_review:${project.id}:${req.user.id}:${recipientId}`,
        },
      });
    }

    await writeAuditLog({ userId: req.user.id, action: 'review.create', entityType: 'review', entityId: review.id, payload: req.body });

    return created(res, serializeReview(review));
  } catch (error) {
    return fail(res, 400, 'Invalid review payload', error.message);
  }
});

router.post('/admin/reviews/remove-by-reviewers', requireAuth, requireRoles(['admin']), async (req, res) => {
  try {
    const schema = z.object({
      student_email: z.string().email().optional(),
      studentEmail: z.string().email().optional(),
      reviewer_emails: z.array(z.string().email()).optional(),
      reviewerEmails: z.array(z.string().email()).optional(),
      reviewer_names: z.array(z.string().min(1)).optional(),
      reviewerNames: z.array(z.string().min(1)).optional(),
      execute: z.boolean().optional(),
    });
    const payload = schema.parse(req.body || {});
    const studentEmail = normalizeText(payload.studentEmail || payload.student_email);
    const reviewerEmails = (payload.reviewerEmails || payload.reviewer_emails || []).map(normalizeText).filter(Boolean);
    const reviewerNames = (payload.reviewerNames || payload.reviewer_names || []).map(normalizeText).filter(Boolean);
    const execute = payload.execute === true;

    if (!studentEmail) return fail(res, 400, 'student_email is required');
    if (!reviewerEmails.length && !reviewerNames.length) return fail(res, 400, 'At least one reviewer email or name is required');

    const student = await prisma.user.findFirst({
      where: { email: { equals: studentEmail, mode: 'insensitive' }, deletedAt: null },
      select: { id: true, email: true, displayName: true },
    });
    if (!student) return fail(res, 404, 'Student not found');

    const reviewerWhere = [];
    if (reviewerEmails.length) {
      reviewerWhere.push(...reviewerEmails.map(email => ({ email: { equals: email, mode: 'insensitive' } })));
    }
    if (reviewerNames.length) {
      reviewerWhere.push(...reviewerNames.map(name => ({ displayName: { contains: name, mode: 'insensitive' } })));
    }
    const reviewers = await prisma.user.findMany({
      where: { OR: reviewerWhere, deletedAt: null },
      select: { id: true, email: true, displayName: true },
    });
    const reviewerIds = reviewers.map(user => user.id);
    const reviewerDisplayNames = [...new Set([
      ...reviewers.map(user => user.displayName).filter(Boolean),
      ...(payload.reviewerNames || payload.reviewer_names || []),
    ])];

    const reviewRows = reviewerIds.length
      ? await prisma.review.findMany({
          where: { studentId: student.id, reviewerId: { in: reviewerIds } },
          select: { id: true, projectId: true, reviewerId: true, comment: true, rating: true, reviewer: { select: { displayName: true, email: true } } },
        })
      : [];

    const notificationWhere = reviewerDisplayNames.flatMap(name => ([
      { AND: [{ userId: student.id }, { title: { contains: name, mode: 'insensitive' } }, { title: { contains: 'left', mode: 'insensitive' } }, { title: { contains: 'review', mode: 'insensitive' } }] },
      { AND: [{ userId: student.id }, { body: { contains: name, mode: 'insensitive' } }, { body: { contains: 'left', mode: 'insensitive' } }, { body: { contains: 'review', mode: 'insensitive' } }] },
    ]));
    const notifications = notificationWhere.length
      ? await prisma.notification.findMany({
          where: { OR: notificationWhere },
          select: { id: true, title: true, body: true },
        })
      : [];

    const projectRows = await prisma.syncRecord.findMany({
      where: { entity: 'projects', deletedAt: null },
      select: { recordId: true, payload: true },
    });
    const reviewerNeedles = reviewerDisplayNames.map(normalizeText).filter(Boolean);
    const syncUpdates = [];
    for (const row of projectRows) {
      const rowPayload = row.payload || {};
      const studentIds = [
        rowPayload.studentUserId,
        rowPayload.student_user_id,
        rowPayload.studentId,
        rowPayload.student_id,
      ].map(String);
      if (!studentIds.includes(student.id)) continue;
      const reviews = Array.isArray(rowPayload.reviews) ? rowPayload.reviews : [];
      if (!reviews.length) continue;
      const keptReviews = reviews.filter(review => {
        const reviewerName = normalizeText(review.reviewerName || review.reviewer_name || '');
        const reviewerId = String(review.reviewerId || review.reviewer_id || '');
        return !reviewerIds.includes(reviewerId) && !reviewerNeedles.some(needle => reviewerName.includes(needle));
      });
      if (keptReviews.length === reviews.length) continue;
      syncUpdates.push({
        recordId: row.recordId,
        removed: reviews.length - keptReviews.length,
        payload: {
          ...rowPayload,
          reviews: keptReviews,
          reviewSubmitted: keptReviews.length > 0 ? rowPayload.reviewSubmitted : false,
          review_submitted: keptReviews.length > 0 ? rowPayload.review_submitted : false,
          updatedAt: new Date().toISOString(),
        },
      });
    }

    const plan = {
      student,
      reviewers,
      review_ids: reviewRows.map(row => row.id),
      notification_ids: notifications.map(row => row.id),
      sync_project_updates: syncUpdates.map(row => ({ record_id: row.recordId, reviews_removed: row.removed })),
      counts: {
        reviews: reviewRows.length,
        notifications: notifications.length,
        sync_projects: syncUpdates.length,
      },
    };
    if (!execute) return ok(res, { execute: false, plan, deleted: null });

    const deleted = await prisma.$transaction(async (tx) => {
      const result = {};
      result.reviews = reviewerIds.length
        ? await tx.review.deleteMany({ where: { studentId: student.id, reviewerId: { in: reviewerIds } } })
        : { count: 0 };
      result.notifications = notifications.length
        ? await tx.notification.deleteMany({ where: { id: { in: notifications.map(row => row.id) } } })
        : { count: 0 };
      result.syncProjects = { count: 0 };
      for (const update of syncUpdates) {
        await tx.syncRecord.update({
          where: { entity_recordId: { entity: 'projects', recordId: update.recordId } },
          data: { payload: update.payload },
        });
        result.syncProjects.count += 1;
      }
      return result;
    });

    await writeAuditLog({
      userId: req.user.id,
      action: 'admin.reviews.remove_by_reviewers',
      entityType: 'review',
      entityId: student.id,
      payload: { execute, student_email: student.email, reviewer_emails: reviewerEmails, reviewer_names: reviewerDisplayNames, plan, deleted },
    });

    return ok(res, { execute: true, plan, deleted });
  } catch (error) {
    const message = error?.name === 'ZodError' ? 'Invalid review cleanup payload' : 'Unable to remove reviews';
    return fail(res, 400, message, error.message);
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
        dedupeKey: `direct_hire_review:${app.id}:${req.user.id}:${app.studentId}`,
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
