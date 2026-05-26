const express = require('express');
const { prisma } = require('../lib/prisma');
const { ok } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');
const { calculateHourlyProjectFees } = require('../lib/platformFees');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const where = req.user.role === 'admin'
    ? {}
    : req.user.role === 'student'
      ? { payeeId: req.user.id }
      : { payerId: req.user.id };

  const rows = await prisma.transaction.findMany({
    where,
    include: {
      project: { select: { id: true, jobId: true, status: true, hourlyRate: true, actualHours: true, estimatedHours: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  const data = rows.map((tx) => {
    const hours = Number(tx.project?.actualHours || tx.project?.estimatedHours || 0);
    const rate = Number(tx.project?.hourlyRate || 0);
    const workTotal = Number((hours * rate).toFixed(2)) || Math.max(0, Number(tx.amountTotal || 0) - (Number(tx.platformFee || 0) / 2));
    const fees = calculateHourlyProjectFees(workTotal);
    const base = {
      id: tx.id,
      project_id: tx.projectId,
      status: tx.status,
      created_at: tx.createdAt,
      stripe_payment_intent_id: tx.stripePaymentIntentId,
      project: tx.project,
      work_total: fees.workTotal,
      student_platform_fee: fees.studentPlatformFee,
      employer_platform_fee: fees.employerPlatformFee,
      platform_fee_total: Number(tx.platformFee),
    };

    if (req.user.role === 'student') {
      return {
        ...base,
        student_payout: Number(tx.studentPayout),
        platform_fee: fees.studentPlatformFee,
      };
    }

    if (req.user.role === 'employer' || req.user.role === 'neighbor') {
      return {
        ...base,
        amount_total: Number(tx.amountTotal),
        platform_fee: fees.employerPlatformFee,
      };
    }

    return {
      ...base,
      amount_total: Number(tx.amountTotal),
      platform_fee: Number(tx.platformFee),
      student_payout: Number(tx.studentPayout),
      payer_id: tx.payerId,
      payee_id: tx.payeeId,
    };
  });

  return ok(res, data);
});

module.exports = router;
