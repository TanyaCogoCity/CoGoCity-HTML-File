const PRODUCTION_ORIGIN = 'https://cogocity.com';
const DEFAULT_SOCIAL_IMAGE = `${PRODUCTION_ORIGIN}/assets/cogocity-social-share.png`;

function compactText(value = '', max = 160) {
  const text = String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  const clipped = text.slice(0, max - 1).replace(/\s+\S*$/, '').trim();
  return `${clipped || text.slice(0, max - 1).trim()}…`;
}

function slugify(value = '') {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function uniqueSlug(parts = [], id = '') {
  const base = slugify(parts.filter(Boolean).join(' ')) || 'cogocity';
  const suffix = String(id || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase();
  return suffix ? `${base}-${suffix}` : base;
}

function xmlEscape(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function metadataAllowsIndex(metadata = {}) {
  const meta = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
  const falseFlags = [
    'public_profile',
    'profile_public',
    'is_public',
    'seo_indexable',
    'search_indexable',
  ];
  if (falseFlags.some((key) => meta[key] === false || String(meta[key]).toLowerCase() === 'false')) return false;
  if (meta.private_profile === true || meta.profile_private === true || meta.hidden === true) return false;
  if (meta.migration_onboarding_required && !meta.migration_onboarding_completed_at) return false;
  return true;
}

function containsPrivateDetails(value = '') {
  const text = String(value || '');
  if (!text.trim()) return false;
  const patterns = [
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/,
    /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,4}\s+(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|circle|cir|way|place|pl|boulevard|blvd)\b/i,
    /\b(?:apartment|apt|unit|suite|ste)\s*[#\w-]+/i,
    /\b(?:call|text|email|phone me|contact me at)\b/i,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

function publicCity(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  const first = text.split(',')[0].trim();
  if (containsPrivateDetails(first)) return '';
  return first.slice(0, 80);
}

function urlFor(path = '') {
  return `${PRODUCTION_ORIGIN}${path.startsWith('/') ? path : `/${path}`}`;
}

module.exports = {
  PRODUCTION_ORIGIN,
  DEFAULT_SOCIAL_IMAGE,
  compactText,
  slugify,
  uniqueSlug,
  xmlEscape,
  metadataAllowsIndex,
  containsPrivateDetails,
  publicCity,
  urlFor,
};
