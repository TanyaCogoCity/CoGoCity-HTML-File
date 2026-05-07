const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { created, fail } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');
const { writeAuditLog } = require('../lib/audit');

const router = express.Router();

router.post('/projects/:id/review', requireAuth, async (req, res) => {
  try {
    const schema = z.object({
      rating: z.number().int().min(1).max(5),
      comment: z.string().max(2000).optional(),
      service_id: z.string().uuid().optional(),
      serviceId: z.string().uuid().optional(),
    });
    const payload = schema.parse(req.body || {});

    const project = await prisma.project.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!project) return fail(res, 404, 'Project not found');
    if (project.status !== 'completed') return fail(res, 409, 'Review is only allowed after project completion');
    if (![project.employerId, project.studentId].includes(req.user.id)) return fail(res, 403, 'Not allowed');

    const review = await prisma.review.create({
      data: {
        projectId: project.id,
        reviewerId: req.user.id,
        studentId: project.studentId,
        serviceId: payload.serviceId || payload.service_id || project.serviceId || null,
        rating: payload.rating,
        comment: payload.comment || '',
      },
    });

    await writeAuditLog({ userId: req.user.id, action: 'review.create', entityType: 'review', entityId: review.id, payload: req.body });

    return created(res, {
      id: review.id,
      project_id: review.projectId,
      reviewer_id: review.reviewerId,
      student_id: review.studentId,
      service_id: review.serviceId,
      rating: review.rating,
      comment: review.comment,
      created_at: review.createdAt,
    });
  } catch (error) {
    return fail(res, 400, 'Invalid review payload', error.message);
  }
});

module.exports = router;
