const DEFAULT_DIRECT_JOB_PACKAGES = [
  { id: 'pkg_basic', key: 'basic', label: 'Basic (30 days)', fee: 99, duration_days: 30, active: true },
  { id: 'pkg_featured', key: 'featured', label: 'Featured (30 days)', fee: 199, duration_days: 30, active: true },
];

function normalizePackage(item = {}) {
  const key = String(item.key || '').trim().toLowerCase();
  if (!key) return null;
  return {
    id: String(item.id || `pkg_${key}`),
    key,
    label: (String(item.label || '').trim() || (key === 'featured' ? 'Featured' : 'Basic')).replace(/\(\s*45\s+days\s*\)/i, '(30 days)'),
    fee: Math.max(0, Number(item.fee || 0) || 0),
    duration_days: Math.max(1, Number(item.duration_days || item.durationDays || 30) || 30),
    active: item.active !== false,
  };
}

async function getDirectJobPackages(prisma) {
  const rows = await prisma.syncRecord.findMany({
    where: { entity: 'direct_job_packages', deletedAt: null },
    orderBy: { updatedAt: 'desc' },
    take: 100,
  }).catch(() => []);

  const configured = rows
    .map((row) => normalizePackage(row.payload || {}))
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_DIRECT_JOB_PACKAGES.map((item) => ({ ...item }));
}

async function getDirectJobPackage(prisma, packageType = 'basic') {
  const packages = await getDirectJobPackages(prisma);
  const active = packages.filter((item) => item.active !== false);
  const candidates = active.length ? active : packages;
  const key = String(packageType || 'basic').trim().toLowerCase();
  return candidates.find((item) => item.key === key)
    || candidates.find((item) => item.key === 'basic')
    || DEFAULT_DIRECT_JOB_PACKAGES[0];
}

function applyDirectJobPackagePricing(payload = {}, pkg = DEFAULT_DIRECT_JOB_PACKAGES[0]) {
  const listingMonths = Math.max(1, Number(payload.listingMonths || 1) || 1);
  const packageFee = Math.max(0, Number(pkg.fee || 0) || 0);
  const durationOptions = [30, 60, 90, 120];
  const durationDays = durationOptions[Math.min(listingMonths, durationOptions.length) - 1] || 30;
  const total = Number((packageFee * listingMonths).toFixed(2));
  return Object.assign({}, payload, {
    postingPackage: String(pkg.key || payload.postingPackage || 'basic').toLowerCase(),
    postingFee: total,
    listingMonths,
    listingDurationDays: durationDays,
  });
}

module.exports = {
  DEFAULT_DIRECT_JOB_PACKAGES,
  getDirectJobPackages,
  getDirectJobPackage,
  applyDirectJobPackagePricing,
};
