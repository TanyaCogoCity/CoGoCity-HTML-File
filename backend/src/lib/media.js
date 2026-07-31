const LEGACY_WORDPRESS_MEDIA_HOST = String(process.env.LEGACY_WORDPRESS_MEDIA_HOST || 'cogocity.com')
  .replace(/^https?:\/\//i, '')
  .replace(/^www\./i, '')
  .replace(/\/+$/g, '')
  .toLowerCase();

function parseLegacyWordPressUploadUrl(source = '') {
  const raw = String(source || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw, `https://${LEGACY_WORDPRESS_MEDIA_HOST}`);
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    if (host !== LEGACY_WORDPRESS_MEDIA_HOST) return null;
    if (!/^\/wp-content\/uploads\//i.test(url.pathname)) return null;
    return url;
  } catch (error) {
    return null;
  }
}

function legacyWordPressProxyUrl(source = '') {
  const url = parseLegacyWordPressUploadUrl(source);
  if (!url) return String(source || '').trim();
  return `/api/sync/legacy-wordpress-media/${String(url.pathname || '').replace(/^\/+/, '')}${String(url.search || '')}`;
}

function normalizeMediaReference(source = '') {
  return legacyWordPressProxyUrl(source);
}

function normalizeMediaReferenceList(values = []) {
  return Array.isArray(values) ? values.map((value) => normalizeMediaReference(value)) : [];
}

function normalizeProfileMetadataMedia(metadata = {}) {
  const base = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
  return {
    ...base,
    photo: normalizeMediaReference(base.photo || ''),
    business_logo: normalizeMediaReference(base.business_logo || ''),
    profile_images: normalizeMediaReferenceList(base.profile_images || []),
  };
}

module.exports = {
  LEGACY_WORDPRESS_MEDIA_HOST,
  parseLegacyWordPressUploadUrl,
  legacyWordPressProxyUrl,
  normalizeMediaReference,
  normalizeProfileMetadataMedia,
};
