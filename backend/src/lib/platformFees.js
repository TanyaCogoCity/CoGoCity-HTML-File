const DEFAULT_STUDENT_PLATFORM_FEE_PERCENT = 12;
const DEFAULT_EMPLOYER_PLATFORM_FEE_PERCENT = 12;
const DEFAULT_JOB_PLACEMENT_EMPLOYER_PLATFORM_FEE_PERCENT = 0;
const PLATFORM_SUPPORT_FEE_VERSION = 'platform-support-admin-managed';

function money(value) {
  return Number((Number(value || 0) || 0).toFixed(2));
}

function percent(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizePlatformFeeSettings(settings = {}) {
  return {
    studentCommissionPct: percent(settings.studentCommissionPct, DEFAULT_STUDENT_PLATFORM_FEE_PERCENT),
    employerCommissionPct: percent(settings.employerCommissionPct, DEFAULT_EMPLOYER_PLATFORM_FEE_PERCENT),
    jobPlacementEmployerCommissionPct: percent(
      settings.jobPlacementEmployerCommissionPct ?? settings.employerCommissionPct,
      DEFAULT_JOB_PLACEMENT_EMPLOYER_PLATFORM_FEE_PERCENT
    ),
  };
}

async function getPlatformFeeSettings(prisma) {
  if (!prisma?.syncRecord?.findFirst) return normalizePlatformFeeSettings();
  const row = await prisma.syncRecord.findFirst({
    where: { entity: 'payment_settings', recordId: 'payment_settings', deletedAt: null },
    orderBy: { updatedAt: 'desc' },
  }).catch(() => null);
  return normalizePlatformFeeSettings(row?.payload || {});
}

function calculateHourlyProjectFees(workTotal = 0, settings = {}) {
  const feeSettings = normalizePlatformFeeSettings(settings);
  const base = money(workTotal);
  const studentPlatformFee = money(base * (feeSettings.studentCommissionPct / 100));
  const employerPlatformFee = money(base * (feeSettings.employerCommissionPct / 100));
  return {
    workTotal: base,
    studentPlatformFee,
    employerPlatformFee,
    platformFeeTotal: money(studentPlatformFee + employerPlatformFee),
    studentPayout: money(base - studentPlatformFee),
    employerTotal: money(base + employerPlatformFee),
    studentCommissionPct: feeSettings.studentCommissionPct,
    employerCommissionPct: feeSettings.employerCommissionPct,
  };
}

async function calculateHourlyProjectFeesFromSettings(prisma, workTotal = 0) {
  const settings = await getPlatformFeeSettings(prisma);
  return calculateHourlyProjectFees(workTotal, settings);
}

function calculateJobPlacementFees(listingFee = 0, settings = {}) {
  const base = money(listingFee);
  const employerPlatformFee = 0;
  return {
    listingFee: base,
    employerPlatformFee,
    employerTotal: base,
    employerCommissionPct: 0,
  };
}

async function calculateJobPlacementFeesFromSettings(prisma, listingFee = 0) {
  const settings = await getPlatformFeeSettings(prisma);
  return calculateJobPlacementFees(listingFee, settings);
}

module.exports = {
  DEFAULT_STUDENT_PLATFORM_FEE_PERCENT,
  DEFAULT_EMPLOYER_PLATFORM_FEE_PERCENT,
  DEFAULT_JOB_PLACEMENT_EMPLOYER_PLATFORM_FEE_PERCENT,
  PLATFORM_SUPPORT_FEE_VERSION,
  normalizePlatformFeeSettings,
  getPlatformFeeSettings,
  calculateHourlyProjectFees,
  calculateHourlyProjectFeesFromSettings,
  calculateJobPlacementFees,
  calculateJobPlacementFeesFromSettings,
};
