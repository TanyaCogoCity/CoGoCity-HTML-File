const express = require('express');
const { prisma } = require('../lib/prisma');
const { ok, fail } = require('../lib/http');
const {
  PRODUCTION_ORIGIN,
  DEFAULT_SOCIAL_IMAGE,
  compactText,
  uniqueSlug,
  xmlEscape,
  metadataAllowsIndex,
  containsPrivateDetails,
  publicCity,
  urlFor,
} = require('../lib/seo');

const router = express.Router();

const STATIC_PAGES = [
  { path: '/', title: 'CoGo City | Student Jobs and Local Services', description: 'Hire students for local services, discover student jobs, and connect with trusted community opportunities through CoGo City.' },
  { path: '/students', title: 'Browse Students | CoGo City', description: 'Browse student services, skills, and local talent available for hire through CoGo City.' },
  { path: '/community', title: 'Community Gigs | CoGo City', description: 'Discover safe local community gigs and student opportunities through CoGo City.' },
  { path: '/jobs', title: 'Student Jobs | CoGo City', description: 'Explore direct hire student jobs, internships, and local opportunities from employers on CoGo City.' },
  { path: '/blog', title: 'Student Work and Career Blog | CoGo City', description: 'Read CoGo City articles about student jobs, entrepreneurship, safety, and real-world work experience.' },
  { path: '/about-us', title: 'About CoGo City | Student Jobs and Services', description: 'Learn about CoGo City and our mission to connect students, families, neighbors, and businesses.' },
  { path: '/faq-safety-legal', title: 'FAQ, Safety and Legal Guidelines | CoGo City', description: 'Review CoGo City safety guidelines, legal policies, payment rules, and student work FAQs.' },
  { path: '/privacy-policy', title: 'Privacy Policy | CoGo City', description: 'Read the CoGo City Privacy Policy and learn how personal information is collected, used, and protected.' },
  { path: '/terms-and-conditions', title: 'Terms and Conditions | CoGo City', description: 'Read the CoGo City Terms and Conditions for students, employers, neighbors, and community users.' },
  { path: '/disclaimer', title: 'Disclaimer | CoGo City', description: 'Read the CoGo City marketplace disclaimer, user responsibilities, and platform limitations.' },
];

function isStagingRequest(req) {
  const host = String(req.get('x-forwarded-host') || req.get('host') || '').toLowerCase();
  return host.includes('staging.') || host.includes('localhost') || host.includes('127.0.0.1');
}

function withDefaults(meta = {}) {
  const canonical = meta.canonical || urlFor(meta.path || '/');
  const organizationSchema = meta.path === '/' ? {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'CoGo City',
    url: PRODUCTION_ORIGIN,
    logo: `${PRODUCTION_ORIGIN}/assets/cogocity-logo-blue.jpg`,
    image: DEFAULT_SOCIAL_IMAGE,
  } : null;
  return {
    type: meta.type || 'website',
    title: meta.title || 'CoGo City',
    description: compactText(meta.description || 'CoGo City connects students, families, neighbors, and businesses for local jobs and services.', 160),
    path: meta.path || '/',
    canonical,
    ogUrl: canonical,
    image: meta.image || DEFAULT_SOCIAL_IMAGE,
    robots: meta.robots || 'index,follow',
    schema: meta.schema || organizationSchema,
    hash: meta.hash || '#/',
    updatedAt: meta.updatedAt || new Date().toISOString(),
  };
}

function studentSlug(profile) {
  const service = (profile.services || [])[0] || {};
  return uniqueSlug([profile.user?.displayName, service.title || profile.title, profile.user?.city || service.location], profile.userId || profile.id);
}

function employerSlug(user) {
  return uniqueSlug([user.userProfile?.businessName || user.displayName, 'hiring students'], user.id);
}

function jobSlug(job) {
  return uniqueSlug([job.title, publicCity(job.location), 'student job'], job.id);
}

function communitySlug(row) {
  const payload = row.payload || {};
  return uniqueSlug([payload.jobTitle || payload.content || 'community gig', publicCity(payload.location)], row.id);
}

function blogSlug(row) {
  const payload = row.payload || {};
  return String(payload.slug || '').trim() || uniqueSlug([payload.title || 'blog'], row.recordId);
}

function studentIndexable(profile) {
  const user = profile.user || {};
  const metadata = user.userProfile?.metadata || {};
  return user.status === 'active'
    && !user.deletedAt
    && profile.isActive
    && !profile.deletedAt
    && metadataAllowsIndex(metadata)
    && (profile.services || []).some(service => service.isActive && !service.deletedAt);
}

function employerIndexable(user) {
  return user.role === 'employer'
    && user.status === 'active'
    && !user.deletedAt
    && metadataAllowsIndex(user.userProfile?.metadata || {})
    && (user.jobsCreated || []).some(job => job.status === 'open' && !job.deletedAt);
}

function jobIndexable(job) {
  return job.status === 'open'
    && !job.deletedAt
    && job.creator?.status === 'active'
    && !job.creator?.deletedAt;
}

function communityPostIndexable(row) {
  const payload = row.payload || {};
  const text = [payload.jobTitle, payload.content, payload.description, payload.location, payload.details].filter(Boolean).join(' ');
  const status = String(payload.status || 'active').toLowerCase();
  return payload.isJob
    && ['active', 'open', 'pending'].includes(status)
    && !containsPrivateDetails(text);
}

function blogIndexable(row) {
  const payload = row.payload || {};
  const status = String(payload.status || 'published').toLowerCase();
  const publishRequested = payload.publishRequested !== false;
  const date = payload.date ? new Date(payload.date).getTime() : Date.now();
  return publishRequested && status !== 'draft' && date <= Date.now();
}

async function getPublicStudents() {
  const rows = await prisma.studentProfile.findMany({
    where: { deletedAt: null, isActive: true },
    include: {
      user: { include: { userProfile: true } },
      services: { where: { deletedAt: null, isActive: true }, orderBy: { createdAt: 'desc' }, take: 3 },
    },
    orderBy: { updatedAt: 'desc' },
    take: 1000,
  });
  return rows.filter(studentIndexable);
}

async function getPublicEmployers() {
  const rows = await prisma.user.findMany({
    where: { role: 'employer', status: 'active', deletedAt: null },
    include: {
      userProfile: true,
      jobsCreated: { where: { deletedAt: null, status: 'open' }, orderBy: { createdAt: 'desc' }, take: 5 },
    },
    orderBy: { updatedAt: 'desc' },
    take: 1000,
  });
  return rows.filter(employerIndexable);
}

async function getPublicJobs() {
  const rows = await prisma.job.findMany({
    where: { deletedAt: null, status: 'open' },
    include: { creator: { include: { userProfile: true } } },
    orderBy: { createdAt: 'desc' },
    take: 1000,
  });
  return rows.filter(jobIndexable);
}

async function getPublicCommunityPosts() {
  const rows = await prisma.communityPost.findMany({
    where: { deletedAt: null },
    orderBy: { updatedAt: 'desc' },
    take: 1000,
  });
  return rows.filter(communityPostIndexable);
}

async function getPublicBlogPosts() {
  const rows = await prisma.syncRecord.findMany({
    where: { entity: 'blog_posts', deletedAt: null },
    orderBy: { updatedAt: 'desc' },
    take: 1000,
  });
  return rows.filter(blogIndexable);
}

function studentMeta(profile) {
  const user = profile.user || {};
  const service = (profile.services || [])[0] || {};
  const city = publicCity(user.city || service.location);
  const skill = service.title || profile.title || 'Student Services';
  const name = user.displayName || 'Student';
  const path = `/student/${studentSlug(profile)}`;
  return withDefaults({
    type: 'profile',
    title: compactText(`${name} | ${skill}${city ? ` in ${city}` : ''} | CoGo City`, 70),
    description: compactText(`Hire ${name} for ${skill} services${city ? ` in ${city}` : ''}. View experience, skills, reviews, and portfolio on CoGo City.`, 155),
    path,
    hash: `#/profile/${encodeURIComponent(user.id || profile.userId)}`,
    updatedAt: profile.updatedAt,
  });
}

function employerMeta(user) {
  const businessName = user.userProfile?.businessName || user.displayName || 'Employer';
  const path = `/employer/${employerSlug(user)}`;
  return withDefaults({
    type: 'profile',
    title: compactText(`${businessName} | Hiring Students | CoGo City`, 70),
    description: compactText(`Learn about ${businessName}, view open opportunities, and connect with talented students through CoGo City.`, 155),
    path,
    hash: `#/business/${encodeURIComponent(user.id)}`,
    updatedAt: user.updatedAt,
  });
}

function jobMeta(job) {
  const city = publicCity(job.location);
  const path = `/jobs/${jobSlug(job)}`;
  return withDefaults({
    type: 'article',
    title: compactText(`${job.title}${city ? ` in ${city}` : ''} | Student Job | CoGo City`, 70),
    description: compactText(`Apply for ${job.title}${city ? ` in ${city}` : ''}. Discover student jobs, internships, and local opportunities through CoGo City.`, 155),
    path,
    hash: `#/jobs/${encodeURIComponent(job.id)}`,
    updatedAt: job.updatedAt,
    schema: {
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: job.title,
      description: compactText(job.description || job.requirements || job.title, 5000),
      datePosted: job.createdAt,
      employmentType: String(job.jobType || 'OTHER').toUpperCase().replace(/-/g, '_'),
      hiringOrganization: {
        '@type': 'Organization',
        name: job.companyName || job.creator?.userProfile?.businessName || job.creator?.displayName || 'CoGo City Employer',
      },
      jobLocation: city ? {
        '@type': 'Place',
        address: { '@type': 'PostalAddress', addressLocality: city, addressCountry: 'US' },
      } : undefined,
      validThrough: job.expiresAt || undefined,
    },
  });
}

function communityMeta(row) {
  const payload = row.payload || {};
  const city = publicCity(payload.location);
  const title = payload.jobTitle || payload.content || 'Community Gig';
  const path = `/community/${communitySlug(row)}`;
  return withDefaults({
    type: 'article',
    title: compactText(`${title}${city ? ` in ${city}` : ''} | Community Gig | CoGo City`, 70),
    description: compactText(`${title}${city ? ` in ${city}` : ''}. Discover safe local community gigs and student opportunities through CoGo City.`, 155),
    path,
    hash: `#/community/post/${encodeURIComponent(row.id)}`,
    updatedAt: row.updatedAt,
  });
}

function blogMeta(row) {
  const payload = row.payload || {};
  const path = `/blog/${blogSlug(row)}`;
  return withDefaults({
    type: 'article',
    title: compactText(`${payload.title || 'CoGo City Blog'} | CoGo City`, 70),
    description: compactText(payload.excerpt || payload.description || payload.content || 'Read CoGo City articles about student jobs and community opportunities.', 155),
    path,
    hash: `#/blog/${encodeURIComponent(blogSlug(row))}`,
    image: payload.featured_image || payload.featuredImage || payload.image || DEFAULT_SOCIAL_IMAGE,
    updatedAt: row.updatedAt,
  });
}

async function findMetaByPath(path = '/') {
  const cleanPath = String(path || '/').split('?')[0].replace(/\/+$/, '') || '/';
  const staticPage = STATIC_PAGES.find(page => page.path === cleanPath);
  if (staticPage) return withDefaults({ ...staticPage, hash: cleanPath === '/' || cleanPath === '/students' ? '#/' : `#${cleanPath}` });

  const [, section, slug] = cleanPath.match(/^\/([^/]+)\/(.+)$/) || [];
  if (!section || !slug) return null;
  if (section === 'student') {
    const rows = await getPublicStudents();
    const match = rows.find(row => studentSlug(row) === slug);
    return match ? studentMeta(match) : null;
  }
  if (section === 'employer') {
    const rows = await getPublicEmployers();
    const match = rows.find(row => employerSlug(row) === slug);
    return match ? employerMeta(match) : null;
  }
  if (section === 'jobs') {
    const rows = await getPublicJobs();
    const match = rows.find(row => jobSlug(row) === slug);
    return match ? jobMeta(match) : null;
  }
  if (section === 'community') {
    const rows = await getPublicCommunityPosts();
    const match = rows.find(row => communitySlug(row) === slug);
    return match ? communityMeta(match) : null;
  }
  if (section === 'blog') {
    const rows = await getPublicBlogPosts();
    const match = rows.find(row => blogSlug(row) === slug);
    return match ? blogMeta(match) : null;
  }
  return null;
}

router.get('/robots.txt', (req, res) => {
  const staging = isStagingRequest(req);
  res.type('text/plain').send(staging
    ? 'User-agent: *\nDisallow: /\n'
    : `User-agent: *\nAllow: /\n\nSitemap: ${PRODUCTION_ORIGIN}/sitemap.xml\n`);
});

router.get('/sitemap.xml', async (_req, res) => {
  try {
    const [students, employers, jobs, communityPosts, blogPosts] = await Promise.all([
      getPublicStudents(),
      getPublicEmployers(),
      getPublicJobs(),
      getPublicCommunityPosts(),
      getPublicBlogPosts(),
    ]);
    const metas = [
      ...STATIC_PAGES.map(page => withDefaults({ ...page })),
      ...students.map(studentMeta),
      ...employers.map(employerMeta),
      ...jobs.map(jobMeta),
      ...communityPosts.map(communityMeta),
      ...blogPosts.map(blogMeta),
    ];
    const urls = metas.map(meta => `  <url><loc>${xmlEscape(meta.canonical)}</loc><lastmod>${xmlEscape(new Date(meta.updatedAt || Date.now()).toISOString())}</lastmod></url>`).join('\n');
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  } catch (error) {
    return fail(res, 500, 'Could not generate sitemap', error.message);
  }
});

router.get('/seo/meta', async (req, res) => {
  try {
    const meta = await findMetaByPath(String(req.query.path || '/'));
    if (!meta) return fail(res, 404, 'SEO page not found');
    return ok(res, meta);
  } catch (error) {
    return fail(res, 500, 'Could not load SEO metadata', error.message);
  }
});

router.get('/seo/resolve', async (req, res) => {
  try {
    const meta = await findMetaByPath(String(req.query.path || '/'));
    if (!meta) return fail(res, 404, 'SEO page not found');
    return ok(res, { path: meta.path, canonical: meta.canonical, hash: meta.hash });
  } catch (error) {
    return fail(res, 500, 'Could not resolve SEO URL', error.message);
  }
});

module.exports = router;
