const express = require('express');
const { prisma } = require('../lib/prisma');
const { ok } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');
const { calculateHourlyProjectFees, getPlatformFeeSettings } = require('../lib/platformFees');

function money(value) {
  return Number((Number(value || 0) || 0).toFixed(2));
}

function pct(amount, base, fallback) {
  const numerator = Number(amount || 0);
  const denominator = Number(base || 0);
  if (!denominator) return fallback;
  return Number(((numerator / denominator) * 100).toFixed(2));
}

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

  const feeSettings = await getPlatformFeeSettings(prisma);
  const data = rows.map((tx) => {
    const hours = Number(tx.project?.actualHours || tx.project?.estimatedHours || 0);
    const rate = Number(tx.project?.hourlyRate || 0);
    const workTotal = Number((hours * rate).toFixed(2)) || Math.max(0, Number(tx.amountTotal || 0) - (Number(tx.platformFee || 0) / 2));
    const currentFees = calculateHourlyProjectFees(workTotal, feeSettings);
    const storedStudentPlatformFee = Number.isFinite(Number(tx.studentPayout)) ? money(workTotal - Number(tx.studentPayout)) : currentFees.studentPlatformFee;
    const storedEmployerPlatformFee = Number.isFinite(Number(tx.amountTotal)) ? money(Number(tx.amountTotal) - workTotal) : currentFees.employerPlatformFee;
    const base = {
      id: tx.id,
      project_id: tx.projectId,
      status: tx.status,
      created_at: tx.createdAt,
      stripe_payment_intent_id: tx.stripePaymentIntentId,
      project: tx.project,
      work_total: workTotal,
      student_platform_fee: storedStudentPlatformFee,
      employer_platform_fee: storedEmployerPlatformFee,
      platform_fee_total: Number(tx.platformFee),
      student_commission_pct: pct(storedStudentPlatformFee, workTotal, currentFees.studentCommissionPct),
      employer_commission_pct: pct(storedEmployerPlatformFee, workTotal, currentFees.employerCommissionPct),
    };

    if (req.user.role === 'student') {
      return {
        ...base,
        student_payout: Number(tx.studentPayout),
        platform_fee: storedStudentPlatformFee,
      };
    }

    if (req.user.role === 'employer' || req.user.role === 'neighbor') {
      return {
        ...base,
        amount_total: Number(tx.amountTotal),
        platform_fee: storedEmployerPlatformFee,
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
