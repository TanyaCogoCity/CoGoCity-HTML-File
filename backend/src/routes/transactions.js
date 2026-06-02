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

function userDisplayName(user, fallback = '') {
  if (!user) return fallback;
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return user.displayName || fullName || fallback;
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function manualTransactionUserIds(tx = {}) {
  return {
    payerId: String(firstValue(tx.payer_id, tx.payerId, tx.employer_id, tx.employerId, tx.neighbor_id, tx.neighborId, '') || ''),
    payeeId: String(firstValue(tx.payee_id, tx.payeeId, tx.student_id, tx.studentId, tx.student_user_id, tx.studentUserId, '') || ''),
  };
}

function canReadManualTransaction(user, tx = {}) {
  if (user.role === 'admin') return true;
  const ids = manualTransactionUserIds(tx);
  if (user.role === 'student') return ids.payeeId === user.id;
  return ids.payerId === user.id;
}

function normalizeManualTransaction(row, userMap = new Map()) {
  const tx = row.payload || {};
  const ids = manualTransactionUserIds(tx);
  const amountTotal = money(firstValue(tx.total_amount, tx.amount_total, tx.amountTotal, 0));
  const workTotal = money(firstValue(tx.work_total, tx.workTotal, 0));
  const payoutAmount = money(firstValue(tx.payout_amount, tx.student_payout, tx.studentPayout, 0));
  const platformFeeTotal = money(firstValue(tx.platform_fee_total, tx.cogo_commission, tx.platformFeeTotal, 0));
  const employerPlatformFee = money(firstValue(tx.employer_platform_fee, tx.employerPlatformFee, Math.max(0, amountTotal - workTotal)));
  const studentPlatformFee = money(firstValue(tx.student_platform_fee, tx.studentPlatformFee, tx.platform_fee, Math.max(0, workTotal - payoutAmount)));
  return {
    ...tx,
    id: firstValue(tx.id, tx.transaction_id, row.recordId),
    transaction_id: firstValue(tx.transaction_id, tx.id, row.recordId),
    payment_type: firstValue(tx.payment_type, 'project_payment'),
    project_id: firstValue(tx.project_id, tx.projectId, ''),
    job_id: firstValue(tx.job_id, tx.jobId, tx.project_id, ''),
    employer_id: ids.payerId,
    payer_id: ids.payerId,
    student_id: ids.payeeId,
    payee_id: ids.payeeId,
    employerName: firstValue(tx.employerName, tx.employer_name, userDisplayName(userMap.get(ids.payerId), 'Employer / Neighbor')),
    studentName: firstValue(tx.studentName, tx.student_name, userDisplayName(userMap.get(ids.payeeId), 'Student')),
    job_title: firstValue(tx.job_title, tx.jobTitle, 'Project payment'),
    status: firstValue(tx.status, 'pending'),
    created_at: firstValue(tx.created_at, row.createdAt),
    date_charged: firstValue(tx.date_charged, tx.charged_at, tx.created_at, row.createdAt),
    date_completed: firstValue(tx.date_completed, tx.completed_at, ''),
    date_paid: firstValue(tx.date_paid, tx.paid_at, ''),
    hourly_rate: Number(firstValue(tx.hourly_rate, tx.hourlyRate, 0) || 0),
    hours_worked: Number(firstValue(tx.hours_worked, tx.hoursWorked, 0) || 0),
    work_total: workTotal,
    total_amount: amountTotal,
    amount_total: amountTotal,
    payout_amount: payoutAmount,
    student_payout: payoutAmount,
    student_platform_fee: studentPlatformFee,
    employer_platform_fee: employerPlatformFee,
    platform_fee_total: platformFeeTotal,
    cogo_commission: platformFeeTotal,
    platform_fee: studentPlatformFee,
    stripe_payment_intent_id: firstValue(tx.stripe_payment_intent_id, tx.stripePaymentIntentId, ''),
    stripe_charge_id: firstValue(tx.stripe_charge_id, tx.stripeChargeId, ''),
    stripe_transfer_id: firstValue(tx.stripe_transfer_id, tx.stripeTransferId, ''),
    stripe_application_fee_id: firstValue(tx.stripe_application_fee_id, tx.stripeApplicationFeeId, ''),
    stripe_balance_transaction_id: firstValue(tx.stripe_balance_transaction_id, tx.stripeBalanceTransactionId, ''),
    transfer_status: firstValue(tx.transfer_status, tx.transferStatus, ''),
    payout_status: firstValue(tx.payout_status, tx.payoutStatus, ''),
  };
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
      payer: { select: { id: true, displayName: true, firstName: true, lastName: true, role: true } },
      payee: { select: { id: true, displayName: true, firstName: true, lastName: true, role: true } },
      project: { select: { id: true, jobId: true, status: true, hourlyRate: true, actualHours: true, estimatedHours: true, job: { select: { id: true, title: true } } } },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  const feeSettings = await getPlatformFeeSettings(prisma);
  const projectTransactions = rows.map((tx) => {
    const hours = Number(tx.project?.actualHours || tx.project?.estimatedHours || 0);
    const rate = Number(tx.project?.hourlyRate || 0);
    const workTotal = Number((hours * rate).toFixed(2)) || Math.max(0, Number(tx.amountTotal || 0) - (Number(tx.platformFee || 0) / 2));
    const currentFees = calculateHourlyProjectFees(workTotal, feeSettings);
    const storedStudentPlatformFee = Number.isFinite(Number(tx.studentPayout)) ? money(workTotal - Number(tx.studentPayout)) : currentFees.studentPlatformFee;
    const storedEmployerPlatformFee = Number.isFinite(Number(tx.amountTotal)) ? money(Number(tx.amountTotal) - workTotal) : currentFees.employerPlatformFee;
    const base = {
      id: tx.id,
      transaction_id: tx.id,
      payment_type: 'project_payment',
      project_id: tx.projectId,
      job_id: tx.project?.jobId || tx.projectId,
      employer_id: tx.payerId,
      student_id: tx.payeeId,
      employerName: userDisplayName(tx.payer, 'Employer / Neighbor'),
      studentName: userDisplayName(tx.payee, 'Student'),
      job_title: tx.project?.job?.title || 'Project payment',
      status: tx.status,
      created_at: tx.createdAt,
      date_charged: tx.createdAt,
      date_completed: tx.updatedAt,
      date_paid: tx.status === 'paid' ? tx.updatedAt : null,
      stripe_payment_intent_id: tx.stripePaymentIntentId,
      stripe_charge_id: tx.stripeChargeId,
      stripe_transfer_id: tx.stripeTransferId,
      stripe_application_fee_id: tx.stripeApplicationFeeId,
      stripe_balance_transaction_id: tx.stripeBalanceTransactionId,
      transfer_status: tx.transferStatus,
      payout_status: tx.payoutStatus,
      project: tx.project,
      hourly_rate: rate,
      hours_worked: hours,
      work_total: workTotal,
      total_amount: Number(tx.amountTotal),
      amount_total: Number(tx.amountTotal),
      payout_amount: Number(tx.studentPayout),
      student_platform_fee: storedStudentPlatformFee,
      employer_platform_fee: storedEmployerPlatformFee,
      platform_fee_total: Number(tx.platformFee),
      cogo_commission: Number(tx.platformFee),
      stripe_processing_fee: tx.stripeProcessingFee == null ? null : Number(tx.stripeProcessingFee),
      platform_net_revenue: tx.platformNetRevenue == null ? null : Number(tx.platformNetRevenue),
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

  const paidJobStatuses = ['paid', 'captured', 'succeeded', 'complete', 'completed'];
  const jobWhere = {
    deletedAt: null,
    OR: paidJobStatuses.map((status) => ({ paymentStatus: status })),
  };
  if (req.user.role !== 'admin') jobWhere.createdBy = req.user.id;
  const jobs = ['admin', 'employer', 'neighbor'].includes(req.user.role)
    ? await prisma.job.findMany({
        where: jobWhere,
        include: { creator: { select: { id: true, displayName: true, firstName: true, lastName: true, role: true } } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      })
    : [];
  const jobListingTransactions = jobs.map((job) => ({
    id: `job:${job.id}`,
    transaction_id: `job:${job.id}`,
    payment_type: 'direct_job_listing',
    job_id: job.id,
    direct_job_id: job.id,
    employer_id: job.createdBy,
    employerName: userDisplayName(job.creator, 'Employer / Neighbor'),
    job_title: `Job Posting: ${job.title}`,
    status: job.paymentStatus || 'paid',
    created_at: job.createdAt,
    date_charged: job.paidAt || job.updatedAt || job.createdAt,
    date_paid: job.paidAt || job.updatedAt || job.createdAt,
    total_amount: Number(job.postingFee || 0),
    amount_total: Number(job.postingFee || 0),
    listing_fee: Number(job.postingFee || 0),
    platform_fee: 0,
    platform_fee_total: 0,
    payout_amount: 0,
    stripe_checkout_session_id: job.stripeCheckoutSessionId || '',
    stripe_payment_intent_id: job.stripePaymentIntentId || '',
    stripe_charge_id: job.stripeChargeId || '',
    stripe_payment_status: job.stripePaymentStatus || '',
  }));

  const enrollmentWhere = {
    paymentStatus: 'paid',
  };
  if (req.user.role === 'student') {
    enrollmentWhere.userId = req.user.id;
  } else if (req.user.role !== 'admin') {
    enrollmentWhere.workshop = { createdBy: req.user.id };
  }
  const workshopEnrollments = await prisma.workshopEnrollment.findMany({
    where: enrollmentWhere,
    include: {
      user: { select: { id: true, displayName: true, firstName: true, lastName: true, role: true } },
      workshop: { select: { id: true, title: true, price: true, startDate: true, createdBy: true, creator: { select: { id: true, displayName: true, firstName: true, lastName: true, role: true } } } },
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  const workshopTransactions = workshopEnrollments.map((enrollment) => {
    const price = Number(enrollment.workshop?.price || 0);
    const platformFee = money(price * 0.3);
    const hostPayout = money(price - platformFee);
    return {
      id: `workshop:${enrollment.id}`,
      transaction_id: `workshop:${enrollment.id}`,
      payment_type: 'workshop_registration',
      workshop_id: enrollment.workshopId,
      workshop_enrollment_id: enrollment.id,
      student_id: enrollment.userId,
      studentName: userDisplayName(enrollment.user, 'Student'),
      host_id: enrollment.workshop?.createdBy || '',
      employer_id: enrollment.workshop?.createdBy || '',
      hostName: userDisplayName(enrollment.workshop?.creator, 'Host'),
      employerName: userDisplayName(enrollment.workshop?.creator, 'Host'),
      job_title: `Workshop: ${enrollment.workshop?.title || 'Workshop'}`,
      status: enrollment.paymentStatus,
      created_at: enrollment.createdAt,
      date_charged: enrollment.paidAt || enrollment.createdAt,
      date_paid: enrollment.paidAt || enrollment.createdAt,
      total_amount: price,
      amount_total: price,
      work_total: price,
      platform_fee: platformFee,
      platform_fee_total: platformFee,
      cogo_commission: platformFee,
      payout_amount: hostPayout,
      student_payout: hostPayout,
      stripe_checkout_session_id: enrollment.stripeCheckoutSessionId || '',
      stripe_payment_intent_id: enrollment.stripePaymentIntentId || '',
      stripe_charge_id: enrollment.stripeChargeId || '',
      stripe_payment_status: enrollment.stripePaymentStatus || '',
    };
  });

  const manualSyncRows = await prisma.syncRecord.findMany({
    where: { entity: 'transactions', deletedAt: null },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  });
  const visibleManualRows = manualSyncRows.filter((row) => canReadManualTransaction(req.user, row.payload || {}));
  const userIds = [...new Set(visibleManualRows.flatMap((row) => {
    const ids = manualTransactionUserIds(row.payload || {});
    return [ids.payerId, ids.payeeId].filter(Boolean);
  }))];
  const manualUsers = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, displayName: true, firstName: true, lastName: true, role: true },
      })
    : [];
  const userMap = new Map(manualUsers.map((user) => [user.id, user]));
  const coreStripeIds = new Set(projectTransactions.map((tx) => tx.stripe_payment_intent_id).filter(Boolean));
  const coreProjectIds = new Set(projectTransactions.map((tx) => tx.project_id).filter(Boolean));
  const manualTransactions = visibleManualRows
    .map((row) => normalizeManualTransaction(row, userMap))
    .filter((tx) => {
      const stripeId = tx.stripe_payment_intent_id;
      const projectId = tx.project_id;
      if (stripeId && coreStripeIds.has(stripeId)) return false;
      if (projectId && coreProjectIds.has(projectId)) return false;
      return true;
    });

  const data = projectTransactions
    .concat(manualTransactions, jobListingTransactions, workshopTransactions)
    .sort((a, b) => new Date(b.date_paid || b.date_charged || b.created_at || 0) - new Date(a.date_paid || a.date_charged || a.created_at || 0))
    .slice(0, 500);

  return ok(res, data);
});

module.exports = router;
