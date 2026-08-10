const crypto = require('crypto');
const https = require('https');

const config = require('../config');
const { prisma } = require('./prisma');
const { legacyWordPressProxyUrl } = require('./media');

const LEGACY_IMPORT_SOURCE = 'legacy_wordpress_closed_job_import';
const LEGACY_FORCED_FOUR_JOB_IDS = new Set(['13971', '13234', '12992', '12930']);
const LEGACY_APPLICANT_DISTRIBUTION = [
  ...Array(16).fill(1),
  ...Array(12).fill(2),
  ...Array(8).fill(3),
];

function fetchJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: config.legacyWordPressMediaIp,
      servername: config.legacyWordPressMediaHost,
      path: pathname,
      method: 'GET',
      headers: {
        Host: config.legacyWordPressMediaHost,
        Accept: 'application/json',
      },
      timeout: 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const statusCode = Number(res.statusCode || 0);
        if (statusCode < 200 || statusCode >= 300) {
          return reject(new Error(`Legacy WordPress request failed (${statusCode})`));
        }
        try {
          return resolve(JSON.parse(body));
        } catch (error) {
          return reject(new Error(`Legacy WordPress JSON parse failed: ${error.message}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Legacy WordPress request timed out')));
    req.on('error', reject);
    req.end();
  });
}

function decodeHtml(value = '') {
  return String(value || '')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code || 0)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCharCode(parseInt(code || '0', 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, '\'')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripHtml(value = '') {
  return decodeHtml(String(value || ''))
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizeRate(meta = {}) {
  const min = String(meta._rate_min || '').trim();
  const max = String(meta._rate_max || '').trim();
  if (min && max && min !== max) return `${min}-${max}`;
  return min || max || '';
}

function normalizeHours(meta = {}) {
  return String(meta._hours || '').trim();
}

function normalizeImage(meta = {}) {
  const source = String(meta._job_cover_image || '').trim();
  return source ? [legacyWordPressProxyUrl(source)] : [];
}

function seededApplicantCountsByJobId(jobs = []) {
  const entries = jobs.map((job) => {
    const jobId = String(job?.id || '').trim();
    const title = decodeHtml(job?.title?.rendered || '');
    const sortKey = crypto.createHash('sha256').update(`${jobId}:${title}`).digest('hex');
    return { job, jobId, sortKey };
  }).filter((entry) => entry.jobId);
  const counts = new Map();
  entries
    .filter((entry) => LEGACY_FORCED_FOUR_JOB_IDS.has(entry.jobId))
    .forEach((entry) => counts.set(entry.jobId, 4));
  entries
    .filter((entry) => !counts.has(entry.jobId))
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.jobId.localeCompare(b.jobId))
    .forEach((entry, index) => {
      counts.set(entry.jobId, LEGACY_APPLICANT_DISTRIBUTION[index] || 1);
    });
  return counts;
}

function buildCommunityPost(job, matchedUser, applicantCountsByJobId) {
  const meta = job.meta || {};
  const title = decodeHtml(job.title?.rendered || '');
  const description = stripHtml(job.content?.rendered || '');
  const jobId = String(job.id || '').trim();
  const applicationEmail = String(meta._application || '').trim().toLowerCase();
  const imageRefs = normalizeImage(meta);
  const createdAt = job.date ? new Date(job.date).toISOString() : new Date().toISOString();
  const authorName = String(
    matchedUser?.displayName
    || matchedUser?.userProfile?.businessName
    || matchedUser?.email
    || 'Community Member'
  ).trim();

  return {
    id: `legacy-wp-job-${job.id}`,
    authorId: matchedUser?.id || '',
    authorName,
    authorEmoji: '💼',
    content: '',
    description,
    isJob: true,
    jobTitle: title || 'Legacy job listing',
    rate: normalizeRate(meta),
    hoursNeeded: normalizeHours(meta),
    location: String(meta._job_location || '').trim(),
    status: 'closed',
    application_count: Number(applicantCountsByJobId?.get(jobId) || 0),
    likes: [],
    comments: [],
    shares: 0,
    entity_images: imageRefs,
    images: imageRefs,
    video_url: '',
    video_type: '',
    video_id: '',
    createdAt,
    updatedAt: new Date().toISOString(),
    legacyImport: true,
    legacyImportSource: LEGACY_IMPORT_SOURCE,
    legacyWordPressJobId: String(job.id || ''),
    legacyWordPressAuthorId: String(job.author || ''),
    legacyWordPressCompanyManagerId: String(meta._company_manager_id || ''),
    legacyWordPressApplicationEmail: applicationEmail,
    legacyWordPressUrl: String(job.link || '').trim(),
  };
}

async function importLegacyClosedJobs() {
  const jobs = await fetchJson('/wp-json/wp/v2/job-listings?per_page=100');
  if (!Array.isArray(jobs) || !jobs.length) {
    return { total: 0, matched: 0, imported: 0, skipped: 0, unmatchedEmails: [] };
  }

  const emails = [...new Set(jobs
    .map((job) => String(job?.meta?._application || '').trim().toLowerCase())
    .filter(Boolean))];

  const users = emails.length
    ? await prisma.user.findMany({
        where: {
          deletedAt: null,
          status: 'active',
          email: { in: emails },
        },
        include: { userProfile: true },
      })
    : [];

  const userByEmail = new Map(users.map((user) => [String(user.email || '').trim().toLowerCase(), user]));
  const importableJobs = jobs.filter((job) => {
    const applicationEmail = String(job?.meta?._application || '').trim().toLowerCase();
    return !!userByEmail.get(applicationEmail) || config.importLegacyClosedJobsAllowUnmatched;
  });
  const applicantCountsByJobId = seededApplicantCountsByJobId(importableJobs);
  const unmatchedEmails = new Set();
  let matched = 0;
  let imported = 0;
  let skipped = 0;

  for (const job of jobs) {
    const applicationEmail = String(job?.meta?._application || '').trim().toLowerCase();
    const matchedUser = userByEmail.get(applicationEmail) || null;
    if (matchedUser) matched += 1;
    if (!matchedUser && !config.importLegacyClosedJobsAllowUnmatched) {
      skipped += 1;
      if (applicationEmail) unmatchedEmails.add(applicationEmail);
      continue;
    }

    const payload = buildCommunityPost(job, matchedUser, applicantCountsByJobId);
    await prisma.communityPost.upsert({
      where: { id: payload.id },
      create: {
        id: payload.id,
        authorId: payload.authorId || null,
        payload,
        createdAt: new Date(payload.createdAt),
      },
      update: {
        authorId: payload.authorId || null,
        payload,
        deletedAt: null,
      },
    });
    imported += 1;
  }

  return {
    total: jobs.length,
    matched,
    imported,
    skipped,
    unmatchedEmails: [...unmatchedEmails].sort(),
  };
}

let hasRun = false;

async function maybeImportLegacyClosedJobsOnStartup() {
  if (!config.importLegacyClosedJobsOnStartup || hasRun) return;
  hasRun = true;
  try {
    const summary = await importLegacyClosedJobs();
    console.log('[legacy_closed_jobs_import]', JSON.stringify(summary));
  } catch (error) {
    console.error('[legacy_closed_jobs_import_failed]', error.stack || error.message || String(error));
  }
}

module.exports = {
  importLegacyClosedJobs,
  maybeImportLegacyClosedJobsOnStartup,
};
