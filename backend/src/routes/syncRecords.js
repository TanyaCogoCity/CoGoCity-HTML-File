const express = require('express');
const crypto = require('crypto');
const https = require('https');
const Stripe = require('stripe');

const { prisma } = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { ok, fail } = require('../lib/http');
const { writeAuditLog } = require('../lib/audit');
const config = require('../config');
const { stripeConnectReady } = require('../lib/onboardingGate');
const { notifyAdminWorkshopListed } = require('../lib/adminEmails');
const { createNotification } = require('../lib/notifications');
const { notificationType } = require('../lib/compat');

const router = express.Router();
const stripe = config.stripeSecretKey ? new Stripe(config.stripeSecretKey, { apiVersion: '2024-06-20' }) : null;
const SPACES_VARIANTS = ['thumb', 'medium', 'full'];
const LEGACY_WORDPRESS_MEDIA_IP = process.env.LEGACY_WORDPRESS_MEDIA_IP || '206.189.191.246';
const LEGACY_WORDPRESS_MEDIA_HOST = process.env.LEGACY_WORDPRESS_MEDIA_HOST || 'cogocity.com';

const DEFAULT_FORM_CONFIGS = {
  'community-job-posting': {
    job_title_placeholder: 'Marketing Support, Dog Walker, Office Help',
    job_description_placeholder: '',
    rate_placeholder: '$20/hr',
    hours_placeholder: '2',
    location_placeholder: 'San Francisco, Remote',
    image_label: 'Post Image (Optional)',
    image_helper: 'Recommended image: 1200 x 675 px (16:9). Square or vertical images are OK; CoGo City will crop them neatly in the feed.',
    video_link_label: 'Post a YouTube/Vimeo Link (Optional)',
    video_link_helper: '',
    video_upload_label: 'Upload Video (Optional)',
    video_upload_helper: 'MP4 or WebM, Max. file size: 15 MB',
  },
  'employer-neighbor-onboarding': {
    profile_video_link_label: 'Add Profile Video Link (Optional)',
    profile_video_link_helper: 'Paste a YouTube/Vimeo link',
    profile_video_upload_label: 'Upload Profile Video (Optional)',
    profile_video_upload_helper: 'Upload a short video: 16:9 at 720p or 1080p, under 60 seconds, and under 15 MB.',
  },
};

const ALLOWED_ENTITIES = new Set([
  'users',
  'students',
  'applications',
  'projects',
  'messages',
  'notifications',
  'transactions',
  'workshops',
  'workshop_registrations',
  'direct_jobs',
  'direct_job_applications',
  'direct_job_packages',
  'payment_logs',
  'payment_settings',
  'site_settings',
  'blog_posts',
  'testimonials',
  'images',
  'bookings',
  'finance',
  'admin_action_log',
  'email_queue',
]);

const PUBLIC_READ_ENTITIES = new Set([
  'blog_posts',
  'workshops',
  'site_settings',
  'direct_job_packages',
  'testimonials',
  'images',
]);

const ENTITY_ALIASES = {
  'student-profiles': 'students',
  'workshop-registrations': 'workshop_registrations',
  'direct-jobs': 'direct_jobs',
  'direct-job-applications': 'direct_job_applications',
  'direct-job-packages': 'direct_job_packages',
  'payment-logs': 'payment_logs',
  'payment-settings': 'payment_settings',
  'site-settings': 'site_settings',
};

function validateEntity(entity = '') {
  const key = String(entity || '').trim();
  const normalized = ENTITY_ALIASES[key] || key;
  return ALLOWED_ENTITIES.has(normalized) ? normalized : '';
}

const SINGLETON_ENTITIES = new Set(['payment_settings', 'site_settings', 'finance']);
const ADMIN_WRITE_ENTITIES = new Set(['blog_posts', 'direct_job_packages', 'payment_settings', 'site_settings', 'finance', 'admin_action_log', 'email_queue']);
const DEDICATED_ROUTE_ENTITIES = new Set([
  'users',
  'students',
  'direct_jobs',
  'direct_job_applications',
  'messages',
  'notifications',
]);

function normalizeRecord(record = {}, entity = '') {
  const fallbackId = SINGLETON_ENTITIES.has(entity) ? entity : '';
  const id = String(record.id || record.record_id || record.user_id || record.key || fallbackId || '').trim();
  if (!id) return null;
  const payload = { ...record, id };
  payload.updatedAt = payload.updatedAt || payload.updated_at || new Date().toISOString();
  return { id, payload };
}

async function requireImageWriteAccess(req, res, normalized = []) {
  if (req.user.role === 'admin') return true;
  const userId = String(req.user.id || '').trim();
  if (!userId) {
    fail(res, 401, 'Authentication required');
    return false;
  }
  const ids = normalized.map((record) => record.id).filter(Boolean);
  const existingRows = ids.length
    ? await prisma.syncRecord.findMany({
        where: { entity: 'images', recordId: { in: ids }, deletedAt: null },
        select: { recordId: true, payload: true },
      })
    : [];
  const existingById = new Map(existingRows.map((row) => [row.recordId, row.payload || {}]));
  for (const record of normalized) {
    const payload = record.payload || {};
    const ownerId = String(payload.owner_id || payload.ownerId || '').trim();
    const existing = existingById.get(record.id) || null;
    const existingOwnerId = String((existing && (existing.owner_id || existing.ownerId)) || '').trim();
    if (existing && existingOwnerId && existingOwnerId !== userId) {
      fail(res, 403, 'You can only update images you uploaded');
      return false;
    }
    if (existing && !existingOwnerId && String(existing.source || '').toLowerCase() === 'advertising') {
      fail(res, 403, 'Admin access required');
      return false;
    }
    if (ownerId && ownerId !== userId) {
      fail(res, 403, 'Image owner does not match the signed-in user');
      return false;
    }
    record.payload.owner_id = ownerId || existingOwnerId || userId;
    record.payload.ownerId = record.payload.owner_id;
  }
  return true;
}

function isOfferStatus(value = '') {
  return ['offer_sent', 'offer_pending'].includes(String(value || '').trim().toLowerCase());
}

function isStudentApplicationStatus(value = '') {
  return ['pending', 'applied'].includes(String(value || '').trim().toLowerCase());
}

function syncedApplicationStudentId(payload = {}) {
  return String(payload.studentUserId || payload.student_user_id || payload.studentId || payload.student_id || '').trim();
}

function syncedApplicationEmployerId(payload = {}) {
  return String(payload.employerId || payload.employer_id || '').trim();
}

function syncedProjectStudentId(payload = {}) {
  return String(payload.studentUserId || payload.student_user_id || payload.studentId || payload.student_id || '').trim();
}

function syncedProjectEmployerId(payload = {}) {
  return String(payload.employerId || payload.employer_id || payload.userId || payload.user_id || '').trim();
}

function isStartedProjectStatus(value = '') {
  return ['in_progress', 'project_started', 'funded'].includes(String(value || '').trim().toLowerCase());
}

function syncedProjectApplicationId(payload = {}) {
  return String(payload.applicationId || payload.application_id || '').trim();
}

function projectStatusRank(value = '') {
  const status = String(value || '').trim().toLowerCase();
  if (['completed', 'paid', 'released'].includes(status)) return 5;
  if (['awaiting_employer_approval', 'awaiting_approval'].includes(status)) return 4;
  if (['in_progress', 'project_started', 'funded'].includes(status)) return 3;
  if (['accepted'].includes(status)) return 2;
  if (['pending'].includes(status)) return 1;
  return 0;
}

function projectPaymentStatusRank(value = '') {
  const status = String(value || '').trim().toLowerCase();
  if (['completed', 'paid', 'released', 'succeeded', 'captured'].includes(status)) return 4;
  if (['held', 'funded', 'requires_capture', 'authorized'].includes(status)) return 3;
  if (['pending', 'pending_completion'].includes(status)) return 2;
  if (['failed', 'canceled', 'cancelled'].includes(status)) return 1;
  return 0;
}

function mergeDuplicateProjectPayload(existingPayload = {}, incomingPayload = {}, canonicalId = '') {
  const merged = { ...existingPayload, ...incomingPayload };
  merged.id = canonicalId || existingPayload.id || incomingPayload.id;
  merged.project_id = merged.id;
  merged.projectId = merged.id;

  const existingStatusRank = projectStatusRank(existingPayload.status);
  const incomingStatusRank = projectStatusRank(incomingPayload.status);
  if (existingStatusRank > incomingStatusRank) merged.status = existingPayload.status;

  const existingPaymentRank = projectPaymentStatusRank(existingPayload.payment_status || existingPayload.paymentStatus);
  const incomingPaymentRank = projectPaymentStatusRank(incomingPayload.payment_status || incomingPayload.paymentStatus);
  if (existingPaymentRank > incomingPaymentRank) {
    merged.payment_status = existingPayload.payment_status || existingPayload.paymentStatus || merged.payment_status;
    merged.paymentStatus = merged.payment_status;
  }

  const existingIntent = existingPayload.stripe_payment_intent_id || existingPayload.stripePaymentIntentId || '';
  const incomingIntent = incomingPayload.stripe_payment_intent_id || incomingPayload.stripePaymentIntentId || '';
  if (existingIntent && incomingIntent && existingIntent !== incomingIntent) {
    merged.stripe_payment_intent_id = existingIntent;
    merged.stripePaymentIntentId = existingIntent;
  }

  const existingCreatedAt = existingPayload.createdAt || existingPayload.created_at || '';
  const incomingCreatedAt = incomingPayload.createdAt || incomingPayload.created_at || '';
  if (existingCreatedAt && incomingCreatedAt) {
    const existingTime = Date.parse(existingCreatedAt);
    const incomingTime = Date.parse(incomingCreatedAt);
    if (Number.isFinite(existingTime) && Number.isFinite(incomingTime) && existingTime <= incomingTime) {
      merged.createdAt = existingCreatedAt;
      merged.created_at = existingCreatedAt;
    }
  }

  return merged;
}

async function dedupeSyncedProjectsByApplication(normalized = []) {
  if (!Array.isArray(normalized) || !normalized.length) return normalized;
  const appIds = [...new Set(normalized.map((record) => syncedProjectApplicationId(record.payload)).filter(Boolean))];
  if (!appIds.length) return normalized;

  const existingRows = await prisma.syncRecord.findMany({
    where: { entity: 'projects', deletedAt: null },
    select: { recordId: true, payload: true },
  });
  const existingByApplication = new Map();
  for (const row of existingRows) {
    const payload = row.payload || {};
    const appId = syncedProjectApplicationId(payload);
    if (!appId || !appIds.includes(appId)) continue;
    const current = existingByApplication.get(appId);
    if (!current || projectStatusRank(payload.status) > projectStatusRank(current.payload?.status)) {
      existingByApplication.set(appId, row);
    }
  }

  const prepared = [];
  const incomingByApplication = new Map();
  for (const record of normalized) {
    const appId = syncedProjectApplicationId(record.payload);
    if (!appId) {
      prepared.push(record);
      continue;
    }

    const existing = existingByApplication.get(appId);
    const priorIncoming = incomingByApplication.get(appId);
    const canonicalId = existing?.recordId || priorIncoming?.id || record.id;
    const basePayload = existing?.payload || priorIncoming?.payload || {};
    const payload = mergeDuplicateProjectPayload(basePayload, record.payload, canonicalId);
    const canonical = { id: canonicalId, payload };
    incomingByApplication.set(appId, canonical);
    if (!prepared.some((item) => item.id === canonicalId)) prepared.push(canonical);
    else {
      const index = prepared.findIndex((item) => item.id === canonicalId);
      prepared[index] = canonical;
    }
  }
  return prepared;
}

async function createSyncedApplicationOfferNotifications(normalized = [], req) {
  if (!Array.isArray(normalized) || !normalized.length) return 0;
  let created = 0;
  for (const record of normalized) {
    const payload = record.payload || {};
    const studentId = syncedApplicationStudentId(payload);
    const employerId = syncedApplicationEmployerId(payload);
    if (!studentId || !isOfferStatus(payload.status)) continue;
    if (req.user.role !== 'admin' && employerId && employerId !== req.user.id) continue;
    if (req.user.role !== 'admin' && !employerId) continue;

    const receiptId = `${studentId}:${record.id}:offer_sent`;
    const existing = await prisma.syncRecord.findUnique({
      where: { entity_recordId: { entity: 'notification_email_receipts', recordId: receiptId } },
    });
    if (existing && !existing.deletedAt) continue;

    const employerName = String(payload.employerName || payload.employer_name || req.user.displayName || 'A CoGo City user').trim();
    const jobTitle = String(payload.jobTitle || payload.job_title || payload.studentServiceTitle || payload.student_service_title || 'a job').trim();
    const notification = await createNotification({
      data: {
        userId: studentId,
        type: notificationType('application'),
        title: `You have an offer for "${jobTitle}"`,
        body: `${employerName} sent you an offer for "${jobTitle}". Open your dashboard to review it.`,
        link: `/dashboard?section=jobs_bookings&studentJobsTab=jobs&application=${encodeURIComponent(record.id)}`,
      },
    });

    await prisma.syncRecord.upsert({
      where: { entity_recordId: { entity: 'notification_email_receipts', recordId: receiptId } },
      create: {
        entity: 'notification_email_receipts',
        recordId: receiptId,
        payload: {
          user_id: studentId,
          frontend_notification_id: record.id,
          backend_notification_id: notification.id,
          title: notification.title,
          emailed: !notification.email?.skipped,
          email: notification.email || null,
        },
      },
      update: {
        deletedAt: null,
        payload: {
          user_id: studentId,
          frontend_notification_id: record.id,
          backend_notification_id: notification.id,
          title: notification.title,
          emailed: !notification.email?.skipped,
          email: notification.email || null,
        },
      },
    });
    created += 1;
  }
  return created;
}

async function createSyncedProjectStartedNotifications(normalized = [], req) {
  if (!Array.isArray(normalized) || !normalized.length) return 0;
  let created = 0;
  for (const record of normalized) {
    const payload = record.payload || {};
    const studentId = syncedProjectStudentId(payload);
    const employerId = syncedProjectEmployerId(payload);
    if (!studentId || !employerId || !isStartedProjectStatus(payload.status)) continue;
    if (req.user.role !== 'admin' && employerId !== req.user.id) continue;

    const receiptId = `${studentId}:${record.id}:project_started`;
    const existing = await prisma.syncRecord.findUnique({
      where: { entity_recordId: { entity: 'notification_email_receipts', recordId: receiptId } },
    });
    if (existing && !existing.deletedAt) continue;

    const jobTitle = String(payload.jobTitle || payload.job_title || 'your project').trim();
    const workTotal = Number(payload.estimatedTotal || payload.agreedPrice || payload.finalSubtotal || payload.workTotal || 0) || 0;
    const studentPayout = Number(payload.estimatedStudentPayout || payload.studentPayout || payload.finalStudentPayout || 0) || 0;
    const feePct = Number(payload.studentCommissionPct || 0) || 0;
    const payoutText = studentPayout
      ? ` Your estimated payout${feePct ? ` after the ${feePct}% platform support fee` : ''} is $${studentPayout.toFixed(2)}.`
      : '';
    const notification = await createNotification({
      data: {
        userId: studentId,
        type: notificationType('project'),
        title: `Project started for "${jobTitle}"`,
        body: `Project started for "${jobTitle}".${workTotal ? ` Work total: $${workTotal.toFixed(2)}.` : ''}${payoutText}`,
        link: `/dashboard?section=jobs_bookings&studentJobsTab=projects&project=${encodeURIComponent(record.id)}`,
      },
    });

    await prisma.syncRecord.upsert({
      where: { entity_recordId: { entity: 'notification_email_receipts', recordId: receiptId } },
      create: {
        entity: 'notification_email_receipts',
        recordId: receiptId,
        payload: {
          user_id: studentId,
          frontend_notification_id: record.id,
          backend_notification_id: notification.id,
          title: notification.title,
          emailed: !notification.email?.skipped,
          email: notification.email || null,
        },
      },
      update: {
        deletedAt: null,
        payload: {
          user_id: studentId,
          frontend_notification_id: record.id,
          backend_notification_id: notification.id,
          title: notification.title,
          emailed: !notification.email?.skipped,
          email: notification.email || null,
        },
      },
    });
    created += 1;
  }
  return created;
}

async function createSyncedCommunityApplicationNotifications(normalized = [], req) {
  if (!Array.isArray(normalized) || !normalized.length) return 0;
  let created = 0;
  for (const record of normalized) {
    const payload = record.payload || {};
    const studentId = syncedApplicationStudentId(payload);
    const employerId = syncedApplicationEmployerId(payload);
    const source = String(payload.source || '').trim().toLowerCase();
    if (!studentId || !employerId || !isStudentApplicationStatus(payload.status)) continue;
    if (source && source !== 'community_feed') continue;
    if (req.user.role !== 'admin' && studentId !== req.user.id) continue;

    const receiptId = `${employerId}:${record.id}:student_application`;
    const existing = await prisma.syncRecord.findUnique({
      where: { entity_recordId: { entity: 'notification_email_receipts', recordId: receiptId } },
    });
    if (existing && !existing.deletedAt) continue;

    const studentName = String(payload.studentName || payload.student_name || req.user.displayName || 'A student').trim();
    const jobTitle = String(payload.jobTitle || payload.job_title || 'your job').trim();
    const notification = await createNotification({
      data: {
        userId: employerId,
        type: notificationType('application'),
        title: `${studentName} applied to "${jobTitle}"`,
        body: `${studentName} applied to "${jobTitle}". Open your dashboard to review the request.`,
        link: `/dashboard?section=applicants_projects&employerTab=applicants&application=${encodeURIComponent(record.id)}`,
      },
    });

    await prisma.syncRecord.upsert({
      where: { entity_recordId: { entity: 'notification_email_receipts', recordId: receiptId } },
      create: {
        entity: 'notification_email_receipts',
        recordId: receiptId,
        payload: {
          user_id: employerId,
          frontend_notification_id: record.id,
          backend_notification_id: notification.id,
          title: notification.title,
          emailed: !notification.email?.skipped,
          email: notification.email || null,
        },
      },
      update: {
        deletedAt: null,
        payload: {
          user_id: employerId,
          frontend_notification_id: record.id,
          backend_notification_id: notification.id,
          title: notification.title,
          emailed: !notification.email?.skipped,
          email: notification.email || null,
        },
      },
    });
    created += 1;
  }
  return created;
}

function serialize(row) {
  return {
    ...(row.payload || {}),
    id: row.recordId,
    record_id: row.recordId,
    sync_entity: row.entity,
    sync_updated_at: row.updatedAt.toISOString(),
  };
}

function serializeImageSummary(row) {
  const record = serialize(row);
  if (String(record.source || '').toLowerCase() === 'advertising') return record;
  const url = String(record.url || '');
  const thumb = String(record.thumbnail_url || record.thumb_url || '');
  const hasEmbeddedImage = /^data:image\//i.test(url) || /^data:image\//i.test(thumb);
  const isLargeEmbeddedImage = hasEmbeddedImage && Math.max(url.length, thumb.length) > 20000;
  if (isLargeEmbeddedImage) {
    const publicImageUrl = `/api/sync/images/${encodeURIComponent(row.recordId)}/file`;
    record.url = publicImageUrl;
    record.thumbnail_url = publicImageUrl;
    record.backend_asset_url = publicImageUrl;
    record.embedded_image_omitted = false;
    record.embedded_image_size = Math.max(url.length, thumb.length);
  }
  return record;
}

function spacesEnabled() {
  return !!(config.spacesKey && config.spacesSecret && config.spacesBucket && config.spacesRegion && config.spacesEndpoint);
}

function normalizeSpacesEndpoint() {
  const explicit = String(config.spacesEndpoint || '').replace(/\/+$/, '');
  if (explicit) return explicit;
  return `https://${config.spacesRegion}.digitaloceanspaces.com`;
}

function normalizeSpacesUploadBase() {
  const endpoint = new URL(normalizeSpacesEndpoint());
  if (!endpoint.hostname.startsWith(`${config.spacesBucket}.`)) {
    endpoint.hostname = `${config.spacesBucket}.${endpoint.hostname}`;
  }
  return endpoint.toString().replace(/\/+$/, '');
}

function normalizeSpacesPublicBase() {
  return String(config.spacesCdnUrl || `https://${config.spacesBucket}.${config.spacesRegion}.digitaloceanspaces.com`).replace(/\/+$/, '');
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest(encoding);
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function getSpacesSigningKey(dateStamp) {
  const kDate = hmac(`AWS4${config.spacesSecret}`, dateStamp);
  const kRegion = hmac(kDate, config.spacesRegion);
  const kService = hmac(kRegion, 's3');
  return hmac(kService, 'aws4_request');
}

function encodeSpacesKey(key = '') {
  return String(key || '')
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function dataUrlToUpload(dataUrl = '') {
  const match = String(dataUrl || '').match(/^data:([a-z0-9.+/-]+);base64,([\s\S]+)$/i);
  if (!match) return null;
  const contentType = match[1].toLowerCase();
  if (!/^image\/(webp|jpeg|jpg|png|gif)$/i.test(contentType)) return null;
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 8 * 1024 * 1024) return null;
  return { contentType: contentType === 'image/jpg' ? 'image/jpeg' : contentType, buffer };
}

async function putSpacesObject(objectKey = '', body, contentType = 'image/webp') {
  if (!spacesEnabled()) throw new Error('DigitalOcean Spaces is not configured');
  const endpoint = normalizeSpacesUploadBase();
  const host = new URL(endpoint).host;
  const encodedKey = encodeSpacesKey(objectKey);
  const path = `/${encodedKey}`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);
  const cacheControl = 'public, max-age=31536000, immutable';
  const canonicalHeaders = [
    `cache-control:${cacheControl}`,
    `content-type:${contentType}`,
    `host:${host}`,
    `x-amz-acl:public-read`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
    '',
  ].join('\n');
  const signedHeaders = 'cache-control;content-type;host;x-amz-acl;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    'PUT',
    path,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const credentialScope = `${dateStamp}/${config.spacesRegion}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const signature = hmac(getSpacesSigningKey(dateStamp), stringToSign, 'hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${config.spacesKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetch(`${endpoint}${path}`, {
    method: 'PUT',
    headers: {
      Authorization: authorization,
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
      'x-amz-acl': 'public-read',
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    },
    body,
  });
  if (!response.ok) {
    const message = await response.text().catch(() => '');
    throw new Error(`Spaces upload failed (${response.status}) ${message}`.trim());
  }
  return `${normalizeSpacesPublicBase()}/${encodedKey}`;
}

function uploadedImagePath(recordId = '', variant = 'full', contentType = 'image/webp') {
  const cleanId = String(recordId || '').replace(/[^a-zA-Z0-9_-]/g, '') || crypto.randomUUID();
  const cleanVariant = SPACES_VARIANTS.includes(variant) ? variant : 'full';
  const extension = contentType === 'image/png'
    ? 'png'
    : contentType === 'image/gif'
      ? 'gif'
      : contentType === 'image/jpeg'
        ? 'jpg'
        : 'webp';
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `uploads/images/${year}/${month}/${cleanId}-${cleanVariant}.${extension}`;
}

function imageUploadRecordPayload(req, recordId = '', metadata = {}, urls = {}, files = {}) {
  const ownerId = req.user.role === 'admin'
    ? String(metadata.owner_id || metadata.ownerId || req.user.id || '').trim()
    : String(req.user.id || '').trim();
  return {
    id: recordId,
    record_id: recordId,
    url: urls.full || urls.medium || urls.thumb || '',
    thumbnail_url: urls.thumb || urls.medium || urls.full || '',
    thumb_url: urls.thumb || '',
    medium_url: urls.medium || '',
    full_url: urls.full || '',
    spaces_bucket: config.spacesBucket,
    spaces_region: config.spacesRegion,
    spaces_keys: files,
    storage_provider: 'digitalocean_spaces',
    embedded_image_omitted: false,
    source: String(metadata.source || 'upload'),
    entity_type: String(metadata.entity_type || metadata.entityType || ''),
    entity_id: String(metadata.entity_id || metadata.entityId || ''),
    owner_id: ownerId,
    ownerId,
    alt: String(metadata.alt || ''),
    fingerprint: String(metadata.fingerprint || ''),
    original_name: String(metadata.original_name || metadata.originalName || ''),
    original_type: String(metadata.original_type || metadata.originalType || ''),
    original_size: Number(metadata.original_size || metadata.originalSize || 0) || 0,
    uploaded_at: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function hasSpacesImageUrl(payload = {}) {
  const provider = String(payload.storage_provider || payload.storageProvider || '').toLowerCase();
  const url = String(payload.full_url || payload.fullUrl || payload.url || '').trim();
  return provider === 'digitalocean_spaces' && /^https?:\/\//i.test(url);
}

function imageVariantDataUrl(payload = {}, variant = 'full') {
  const variants = payload.variants && typeof payload.variants === 'object' ? payload.variants : {};
  const variantPayload = variants[variant] && typeof variants[variant] === 'object' ? variants[variant] : {};
  return String(
    variantPayload.data_url
      || variantPayload.dataUrl
      || payload[`${variant}_data_url`]
      || payload[`${variant}DataUrl`]
      || ''
  ).trim();
}

async function uploadImagePayloadToSpaces(req, payload = {}, fallbackRecordId = '') {
  if (!spacesEnabled() || hasSpacesImageUrl(payload)) return payload;
  const recordId = String(payload.id || payload.record_id || fallbackRecordId || `img_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`).trim();
  if (!recordId) return payload;

  const sourceUrl = String(payload.url || payload.full_url || payload.fullUrl || payload.thumbnail_url || payload.thumb_url || '').trim();
  const fallbackUpload = dataUrlToUpload(sourceUrl);
  const urls = {};
  const files = {};

  for (const variant of SPACES_VARIANTS) {
    const explicitDataUrl = imageVariantDataUrl(payload, variant);
    const upload = dataUrlToUpload(explicitDataUrl) || fallbackUpload;
    if (!upload) continue;
    const key = uploadedImagePath(recordId, variant, upload.contentType);
    urls[variant] = await putSpacesObject(key, upload.buffer, upload.contentType);
    files[variant] = key;
  }

  if (!urls.full && !urls.medium && !urls.thumb) return payload;
  return imageUploadRecordPayload(req, recordId, payload, urls, files);
}

async function uploadImageRecordToSpaces(req, record) {
  if (!record || !record.payload) return record;
  record.payload = await uploadImagePayloadToSpaces(req, record.payload, record.id);
  return record;
}

function parseEmbeddedImage(dataUrl = '') {
  const match = String(dataUrl || '').match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i);
  if (!match) return null;
  return {
    mime: match[1].toLowerCase(),
    buffer: Buffer.from(match[2], 'base64'),
  };
}

function stripeSearchValue(value = '') {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function workshopQuantityFromPaymentIntent(paymentIntent, ticketPrice = 0) {
  const metadataQuantity = Math.max(0, Number(paymentIntent?.metadata?.quantity || 0) || 0);
  const paidAmount = Number(paymentIntent?.amount_received || paymentIntent?.amount || 0) / 100;
  const price = Number(ticketPrice || 0);
  const amountQuantity = price > 0 ? Math.max(0, Math.round(paidAmount / price)) : 0;
  return Math.max(1, metadataQuantity, amountQuantity);
}

async function stripeWorkshopPaidCount(workshopId = '', ticketPrice = 0) {
  if (!stripe || !workshopId) return 0;
  try {
    const result = await stripe.paymentIntents.search({
      query: [
        "metadata['type']:'workshop'",
        `metadata['workshop_id']:'${stripeSearchValue(workshopId)}'`,
        "status:'succeeded'",
      ].join(' AND '),
      limit: 100,
    });
    return (result.data || []).reduce((sum, paymentIntent) => sum + workshopQuantityFromPaymentIntent(paymentIntent, ticketPrice), 0);
  } catch (error) {
    console.warn('Could not load Stripe workshop seat count', error.message);
    return 0;
  }
}

async function serializeWorkshopRows(rows = []) {
  const backendWorkshopIds = rows
    .map((row) => row.payload?.backend_workshop_id || row.payload?.backendWorkshopId || (isUuid(row.recordId) ? row.recordId : ''))
    .filter(Boolean);
  const hostIds = [...new Set(rows
    .map((row) => workshopOwnerId(row.payload || {}))
    .filter(Boolean))];
  const hosts = hostIds.length
    ? await prisma.user.findMany({ where: { id: { in: hostIds } } })
    : [];
  const hostReadiness = hosts.reduce((map, host) => {
    map.set(host.id, stripeConnectReady(host));
    return map;
  }, new Map());
  const enrollments = backendWorkshopIds.length
    ? await prisma.workshopEnrollment.findMany({
        where: { workshopId: { in: backendWorkshopIds }, paymentStatus: 'paid' },
        select: { workshopId: true, quantity: true },
      })
    : [];
  const counts = enrollments.reduce((map, enrollment) => {
    map.set(enrollment.workshopId, (map.get(enrollment.workshopId) || 0) + Math.max(1, Number(enrollment.quantity || 1) || 1));
    return map;
  }, new Map());
  const stripeCounts = new Map();
  await Promise.all(rows.map(async (row) => {
    const payload = row.payload || {};
    const backendWorkshopId = payload.backend_workshop_id || payload.backendWorkshopId || (isUuid(row.recordId) ? row.recordId : '');
    if (!backendWorkshopId) return;
    const stripeCount = await stripeWorkshopPaidCount(backendWorkshopId, Number(payload.price || 0));
    if (stripeCount) stripeCounts.set(backendWorkshopId, stripeCount);
  }));
  return rows.map((row) => {
    const payload = row.payload || {};
    const backendWorkshopId = payload.backend_workshop_id || payload.backendWorkshopId || (isUuid(row.recordId) ? row.recordId : '');
    const registeredCount = Math.max(counts.get(backendWorkshopId) || 0, stripeCounts.get(backendWorkshopId) || 0);
    const capacity = payload.capacity == null || payload.capacity === '' ? null : Number(payload.capacity);
    const hostId = workshopOwnerId(payload);
    return {
      ...serialize(row),
      registered_count: registeredCount,
      registeredCount,
      spots_left: capacity && capacity > 0 ? Math.max(0, capacity - registeredCount) : null,
      host_payout_setup_ready: hostId ? Boolean(hostReadiness.get(hostId)) : false,
    };
  });
}

function isUuid(value = '') {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function workshopStatus(value = '') {
  const status = String(value || '').toLowerCase();
  if (status === 'active') return 'published';
  if (['draft', 'published', 'completed', 'canceled'].includes(status)) return status;
  return 'draft';
}

function isPublishedWorkshopStatus(value = '') {
  const status = String(value || '').trim().toLowerCase();
  return status === 'active' || status === 'published';
}

function workshopOwnerId(payload = {}) {
  return String(payload.host_id || payload.hostId || payload.created_by || payload.createdBy || payload.user_id || payload.userId || '').trim();
}

function isPaidPublishedWorkshopRecord(record = {}, currentUserId = '') {
  const payload = record.payload || {};
  const ownerId = workshopOwnerId(payload);
  if (ownerId && ownerId !== currentUserId) return false;
  return Number(payload.price || 0) > 0 && isPublishedWorkshopStatus(payload.status);
}

async function requireSyncedWorkshopPayoutReady(req, res, normalized = []) {
  if (req.user.role === 'admin') return true;
  const hasPaidPublishedWorkshop = normalized.some((record) => isPaidPublishedWorkshopRecord(record, req.user.id));
  if (!hasPaidPublishedWorkshop) return true;
  const host = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (stripeConnectReady(host)) return true;
  fail(res, 402, 'Paid workshops and classes cannot be published until Stripe Connect payout setup is complete. Free workshops can be published without payout setup.', {
    payout_setup_required: true,
    payment_type: 'workshop',
    action: 'complete_stripe_connect',
  });
  return false;
}

function workshopDurationMinutes(value) {
  if (value == null || value === '') return null;
  const parsed = Number.parseInt(String(value).match(/\d+/)?.[0] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function workshopStartDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : new Date();
}

function workshopDataFromPayload(payload = {}, createdBy) {
  return {
    title: String(payload.title || 'Untitled Workshop').trim() || 'Untitled Workshop',
    description: payload.description ? String(payload.description) : null,
    price: Number(payload.price || 0) || 0,
    capacity: payload.capacity == null || payload.capacity === '' ? null : Number(payload.capacity),
    format: payload.format === 'online' ? 'online' : 'in_person',
    location: payload.location || null,
    onlineUrl: payload.online_url || payload.onlineUrl || null,
    durationMinutes: workshopDurationMinutes(payload.duration_minutes ?? payload.durationMinutes ?? payload.duration),
    status: workshopStatus(payload.status),
    startDate: workshopStartDate(payload.start_date || payload.startDate || payload.date_time || payload.dateTime),
    createdBy,
  };
}

async function mirrorWorkshopRecordsToCoreTable(normalized = [], req) {
  const mirrored = [];
  for (const record of normalized) {
    const payload = record.payload || {};
    let createdBy = workshopOwnerId(payload);
    if (!isUuid(createdBy)) continue;
    const creator = await prisma.user.findUnique({ where: { id: createdBy } }).catch(() => null);
    if (!creator) continue;

    let workshop = null;
    const backendWorkshopId = payload.backend_workshop_id || payload.backendWorkshopId;
    if (isUuid(backendWorkshopId)) {
      workshop = await prisma.workshop.findUnique({ where: { id: backendWorkshopId } });
    }
    if (!workshop && isUuid(record.id)) {
      workshop = await prisma.workshop.findUnique({ where: { id: record.id } });
    }

    const data = workshopDataFromPayload(payload, workshop?.createdBy || createdBy);
    const wasPublished = workshop ? isPublishedWorkshopStatus(workshop.status) : false;
    if (workshop) {
      workshop = await prisma.workshop.update({ where: { id: workshop.id }, data });
    } else {
      workshop = await prisma.workshop.create({ data });
    }
    if (!wasPublished && isPublishedWorkshopStatus(workshop.status)) {
      await notifyAdminWorkshopListed({
        host: creator,
        workshop,
        link: `/workshops?id=${workshop.id}`,
      });
    }

    const updatedPayload = { ...payload, backend_workshop_id: workshop.id };
    await prisma.syncRecord.update({
      where: { entity_recordId: { entity: 'workshops', recordId: record.id } },
      data: { payload: updatedPayload },
    });
    mirrored.push({ recordId: record.id, backendWorkshopId: workshop.id });
  }
  return mirrored;
}

function countableApplicationStatus(value = '') {
  return !['withdrawn', 'removed', 'deleted'].includes(String(value || '').toLowerCase());
}

async function refreshCommunityPostApplicationCounts(postIds = []) {
  const ids = [...new Set(postIds.map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return 0;
  const rows = await prisma.syncRecord.findMany({
    where: { entity: 'applications', deletedAt: null },
    select: { payload: true },
  });
  const counts = rows.reduce((map, row) => {
    const payload = row.payload || {};
    const postId = String(payload.postId || payload.post_id || '').trim();
    if (!ids.includes(postId) || !countableApplicationStatus(payload.status || 'pending')) return map;
    map.set(postId, (map.get(postId) || 0) + 1);
    return map;
  }, new Map());
  const projectRows = await prisma.syncRecord.findMany({
    where: { entity: 'projects', deletedAt: null },
    select: { payload: true },
  });
  projectRows.forEach((row) => {
    const payload = row.payload || {};
    const postId = String(payload.postId || payload.post_id || payload.job_id || payload.jobId || '').trim();
    if (!ids.includes(postId)) return;
    const existingApplicationId = String(payload.applicationId || payload.application_id || '').trim();
    if (existingApplicationId) {
      const hasApplication = rows.some((appRow) => {
        const app = appRow.payload || {};
        return String(app.id || app.record_id || '').trim() === existingApplicationId;
      });
      if (hasApplication) return;
    }
    counts.set(postId, (counts.get(postId) || 0) + 1);
  });
  let updatedCount = 0;
  for (const postId of ids) {
    const post = await prisma.communityPost.findUnique({ where: { id: postId } });
    if (!post || post.deletedAt) continue;
    const payload = { ...(post.payload || {}), application_count: counts.get(postId) || 0 };
    await prisma.communityPost.update({ where: { id: postId }, data: { payload } });
    updatedCount += 1;
  }
  return updatedCount;
}

function requireReadAccess(req, res, next) {
  const entity = validateEntity(req.params.entity);
  if (!entity) return fail(res, 404, 'Unknown sync entity');
  if (DEDICATED_ROUTE_ENTITIES.has(entity)) return fail(res, 410, 'Use the dedicated API route for this entity');
  if (PUBLIC_READ_ENTITIES.has(entity)) return next();
  return requireAuth(req, res, next);
}

function normalizeCommunityJobPostingConfig(config = {}) {
  const defaults = DEFAULT_FORM_CONFIGS['community-job-posting'];
  const source = config && typeof config === 'object' ? config : {};
  return {
    job_title_placeholder: String(source.job_title_placeholder ?? source.jobTitlePlaceholder ?? defaults.job_title_placeholder),
    job_description_placeholder: String(source.job_description_placeholder ?? source.jobDescriptionPlaceholder ?? defaults.job_description_placeholder),
    rate_placeholder: String(source.rate_placeholder ?? source.ratePlaceholder ?? defaults.rate_placeholder),
    hours_placeholder: String(source.hours_placeholder ?? source.hoursPlaceholder ?? defaults.hours_placeholder),
    location_placeholder: String(source.location_placeholder ?? source.locationPlaceholder ?? defaults.location_placeholder),
    image_label: String(source.image_label ?? source.imageLabel ?? defaults.image_label),
    image_helper: String(source.image_helper ?? source.imageHelper ?? defaults.image_helper),
    video_link_label: String(source.video_link_label ?? source.videoLinkLabel ?? defaults.video_link_label),
    video_link_helper: String(source.video_link_helper ?? source.videoLinkHelper ?? defaults.video_link_helper),
    video_upload_label: String(source.video_upload_label ?? source.videoUploadLabel ?? defaults.video_upload_label),
    video_upload_helper: String(source.video_upload_helper ?? source.videoUploadHelper ?? defaults.video_upload_helper),
  };
}

function normalizeEmployerNeighborOnboardingConfig(config = {}) {
  const defaults = DEFAULT_FORM_CONFIGS['employer-neighbor-onboarding'];
  const source = config && typeof config === 'object' ? config : {};
  return {
    profile_video_link_label: String(source.profile_video_link_label ?? source.profileVideoLinkLabel ?? defaults.profile_video_link_label),
    profile_video_link_helper: String(source.profile_video_link_helper ?? source.profileVideoLinkHelper ?? defaults.profile_video_link_helper),
    profile_video_upload_label: String(source.profile_video_upload_label ?? source.profileVideoUploadLabel ?? defaults.profile_video_upload_label),
    profile_video_upload_helper: String(source.profile_video_upload_helper ?? source.profileVideoUploadHelper ?? defaults.profile_video_upload_helper),
  };
}

router.get('/form-config/:key', async (req, res) => {
  const key = String(req.params.key || '').trim().toLowerCase();
  const normalizers = {
    'community-job-posting': normalizeCommunityJobPostingConfig,
    'employer-neighbor-onboarding': normalizeEmployerNeighborOnboardingConfig,
  };
  const normalizeConfig = normalizers[key];
  if (!normalizeConfig) return fail(res, 404, 'Unknown form configuration');
  try {
    const row = await prisma.syncRecord.findFirst({
      where: { entity: 'site_settings', recordId: 'site_settings', deletedAt: null },
      select: { payload: true },
    });
    const formConfigs = row?.payload?.form_configs || row?.payload?.formConfigs || {};
    const configured = formConfigs[key] || formConfigs[key.replace(/-/g, '_')] || {};
    return ok(res, {
      key,
      placeholders: normalizeConfig(configured),
    });
  } catch (error) {
    return ok(res, {
      key,
      placeholders: normalizeConfig(),
      fallback: true,
    });
  }
});

router.post('/images/upload', requireAuth, async (req, res) => {
  if (!spacesEnabled()) return fail(res, 503, 'DigitalOcean Spaces is not configured');
  try {
    const body = req.body || {};
    const recordId = String(body.id || body.record_id || `img_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`).trim();
    const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
    const payload = {
      ...metadata,
      id: recordId,
      record_id: recordId,
      variants: body.variants && typeof body.variants === 'object' ? body.variants : {},
      url: body.url || metadata.url || '',
      thumbnail_url: body.thumbnail_url || metadata.thumbnail_url || '',
    };
    const normalized = [{ id: recordId, payload }];
    const imageWriteAllowed = await requireImageWriteAccess(req, res, normalized);
    if (!imageWriteAllowed) return null;
    const storedPayload = await uploadImagePayloadToSpaces(req, normalized[0].payload, recordId);
    if (!hasSpacesImageUrl(storedPayload)) return fail(res, 400, 'No valid image payload was provided');
    await prisma.syncRecord.upsert({
      where: { entity_recordId: { entity: 'images', recordId } },
      create: {
        entity: 'images',
        recordId,
        payload: storedPayload,
      },
      update: {
        payload: storedPayload,
        deletedAt: null,
      },
    });
    await writeAuditLog({
      userId: req.user.id,
      action: 'sync.images.upload',
      entityType: 'sync_record',
      entityId: recordId,
      payload: {
        storage_provider: storedPayload.storage_provider,
        spaces_bucket: storedPayload.spaces_bucket,
        spaces_keys: storedPayload.spaces_keys,
      },
    });
    return ok(res, { image: storedPayload });
  } catch (error) {
    return fail(res, 400, 'Could not upload image', error.message);
  }
});

function requireTestimonialsWriteAccess(req, res, records = [], replace = false) {
  if (req.user.role === 'admin') return true;
  if (replace) return fail(res, 403, 'Admin access required');
  const userId = String(req.user.id || '').trim();
  const valid = records.length > 0 && records.length <= 1 && records.every((record) => {
    const payload = record.payload || {};
    const ownerId = String(payload.user_id || payload.userId || '').trim();
    const status = String(payload.status || '').trim().toLowerCase();
    return ownerId === userId && status === 'pending';
  });
  if (!valid) return fail(res, 403, 'You can only submit your own pending testimonial');
  return true;
}

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

function fetchLegacyWordPressUpload(url) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: LEGACY_WORDPRESS_MEDIA_IP,
      servername: LEGACY_WORDPRESS_MEDIA_HOST,
      path: `${url.pathname}${url.search || ''}`,
      method: 'GET',
      headers: { Host: LEGACY_WORDPRESS_MEDIA_HOST },
      timeout: 12000,
    }, (upstream) => {
      const chunks = [];
      upstream.on('data', (chunk) => chunks.push(chunk));
      upstream.on('end', () => {
        const statusCode = Number(upstream.statusCode || 0);
        const contentType = String(upstream.headers['content-type'] || '');
        if (statusCode < 200 || statusCode >= 300 || !/^image\//i.test(contentType)) {
          return reject(new Error('Legacy image data not found'));
        }
        return resolve({
          buffer: Buffer.concat(chunks),
          contentType,
          lastModified: upstream.headers['last-modified'] || '',
          etag: upstream.headers.etag || '',
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Legacy image request timed out')));
    req.on('error', reject);
    req.end();
  });
}

function sendLegacyWordPressImage(res, legacyImage, fallbackLastModified = null) {
  res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  if (legacyImage.lastModified) res.setHeader('Last-Modified', legacyImage.lastModified);
  else if (fallbackLastModified) res.setHeader('Last-Modified', fallbackLastModified.toUTCString());
  if (legacyImage.etag) res.setHeader('ETag', legacyImage.etag);
  res.type(legacyImage.contentType);
  return res.send(legacyImage.buffer);
}

function redirectLegacyWordPressImage(res, url, fallbackLastModified = null) {
  res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  if (fallbackLastModified) res.setHeader('Last-Modified', fallbackLastModified.toUTCString());
  return res.redirect(302, url.toString());
}

router.get('/legacy-wordpress-media/*', async (req, res) => {
  const rawPath = String(req.params[0] || '').replace(/^\/+/, '');
  const legacyWordPressUrl = parseLegacyWordPressUploadUrl(`/${rawPath}`);
  if (!legacyWordPressUrl) return fail(res, 404, 'Image not found');
  return redirectLegacyWordPressImage(res, legacyWordPressUrl);
});

router.get('/images/:id/file', async (req, res) => {
  const imageId = String(req.params.id || '').trim();
  if (!imageId) return fail(res, 404, 'Image not found');
  const row = await prisma.syncRecord.findFirst({
    where: { entity: 'images', recordId: imageId, deletedAt: null },
    select: { payload: true, updatedAt: true },
  });
  if (!row) return fail(res, 404, 'Image not found');
  const payload = row.payload || {};
  const source = String(payload.url || payload.thumbnail_url || payload.thumb_url || '').trim();
  const legacyWordPressUrl = parseLegacyWordPressUploadUrl(source);
  if (legacyWordPressUrl) {
    return redirectLegacyWordPressImage(res, legacyWordPressUrl, row.updatedAt);
  }
  if (/^https?:\/\//i.test(source)) {
    try {
      const upstream = await fetch(source);
      const contentType = upstream.headers.get('content-type') || 'image/jpeg';
      if (!upstream.ok || !/^image\//i.test(contentType)) return fail(res, 404, 'Image data not found');
      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
      res.setHeader('Last-Modified', row.updatedAt.toUTCString());
      res.type(contentType);
      return res.send(buffer);
    } catch (error) {
      return fail(res, 404, 'Image data not found');
    }
  }
  const embedded = parseEmbeddedImage(source);
  if (!embedded) return fail(res, 404, 'Image data not found');
  res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  res.setHeader('Last-Modified', row.updatedAt.toUTCString());
  res.type(embedded.mime);
  return res.send(embedded.buffer);
});

router.get('/:entity', requireReadAccess, async (req, res) => {
  const entity = validateEntity(req.params.entity);
  try {
    const requestedIds = String(req.query.ids || req.query.id || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, 100);
    const rows = await prisma.syncRecord.findMany({
      where: {
        entity,
        deletedAt: null,
        ...(requestedIds.length ? { recordId: { in: requestedIds } } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: requestedIds.length || Math.min(Number(req.query.limit || 500) || 500, 1000),
    });
    const lightweightImages = entity === 'images' && ['1', 'true', 'yes'].includes(String(req.query.summary || req.query.light || '').toLowerCase());
    const records = entity === 'workshops'
      ? await serializeWorkshopRows(rows)
      : rows.map(lightweightImages ? serializeImageSummary : serialize);
    return ok(res, { entity, records });
  } catch (error) {
    return fail(res, 500, 'Could not load synced records', error.message);
  }
});

router.post('/:entity', requireAuth, async (req, res) => {
  const entity = validateEntity(req.params.entity);
  if (!entity) return fail(res, 404, 'Unknown sync entity');
  if (DEDICATED_ROUTE_ENTITIES.has(entity)) return fail(res, 410, 'Use the dedicated API route for this entity');
  if (ADMIN_WRITE_ENTITIES.has(entity) && req.user.role !== 'admin') return fail(res, 403, 'Admin access required');

  try {
    const records = Array.isArray(req.body?.records) ? req.body.records : [];
    let normalized = records.map((record) => normalizeRecord(record, entity)).filter(Boolean).slice(0, 1000);
    if (entity === 'testimonials') {
      const testimonialsWriteAllowed = requireTestimonialsWriteAccess(req, res, normalized, !!req.body?.replace);
      if (testimonialsWriteAllowed !== true) return null;
    }
    if (entity === 'images') {
      const imageWriteAllowed = await requireImageWriteAccess(req, res, normalized);
      if (!imageWriteAllowed) return null;
      for (const record of normalized) {
        await uploadImageRecordToSpaces(req, record);
      }
    }
    if (entity === 'workshops') {
      const payoutReady = await requireSyncedWorkshopPayoutReady(req, res, normalized);
      if (!payoutReady) return null;
    }
    if (entity === 'projects') {
      normalized = await dedupeSyncedProjectsByApplication(normalized);
    }
    const operations = normalized.map((record) => prisma.syncRecord.upsert({
      where: { entity_recordId: { entity, recordId: record.id } },
      create: {
        entity,
        recordId: record.id,
        payload: record.payload,
      },
      update: {
        payload: record.payload,
        deletedAt: null,
      },
    }));
    if (req.body?.replace === true) {
      const activeIds = normalized.map((record) => record.id);
      operations.push(prisma.syncRecord.updateMany({
        where: {
          entity,
          deletedAt: null,
          ...(activeIds.length ? { recordId: { notIn: activeIds } } : {}),
        },
        data: { deletedAt: new Date() },
      }));
    }
    await prisma.$transaction(operations);
    const mirrored = entity === 'workshops' ? await mirrorWorkshopRecordsToCoreTable(normalized, req) : [];
    const applicationCountUpdates = entity === 'applications'
      ? await refreshCommunityPostApplicationCounts(normalized.map((record) => record.payload?.postId || record.payload?.post_id))
      : 0;
    const applicationNotificationUpdates = entity === 'applications'
      ? await createSyncedApplicationOfferNotifications(normalized, req)
      : 0;
    const communityApplicationNotificationUpdates = entity === 'applications'
      ? await createSyncedCommunityApplicationNotifications(normalized, req)
      : 0;
    const projectNotificationUpdates = entity === 'projects'
      ? await createSyncedProjectStartedNotifications(normalized, req)
      : 0;

    await writeAuditLog({
      userId: req.user.id,
      action: `sync.${entity}`,
      entityType: 'sync_record',
      entityId: entity,
      payload: {
        count: normalized.length,
        mirrored_count: mirrored.length,
        application_count_updates: applicationCountUpdates,
        application_notification_updates: applicationNotificationUpdates,
        community_application_notification_updates: communityApplicationNotificationUpdates,
        project_notification_updates: projectNotificationUpdates,
      },
    });

    return ok(res, {
      entity,
      count: normalized.length,
      mirrored,
      application_count_updates: applicationCountUpdates,
      application_notification_updates: applicationNotificationUpdates,
      community_application_notification_updates: communityApplicationNotificationUpdates,
      project_notification_updates: projectNotificationUpdates,
    });
  } catch (error) {
    return fail(res, 400, 'Could not sync records', error.message);
  }
});

router.delete('/:entity/:recordId', requireAuth, async (req, res) => {
  const entity = validateEntity(req.params.entity);
  if (!entity) return fail(res, 404, 'Unknown sync entity');
  if (DEDICATED_ROUTE_ENTITIES.has(entity)) return fail(res, 410, 'Use the dedicated API route for this entity');
  if (ADMIN_WRITE_ENTITIES.has(entity) && req.user.role !== 'admin') return fail(res, 403, 'Admin access required');
  if (entity === 'testimonials' && req.user.role !== 'admin') return fail(res, 403, 'Admin access required');

  try {
    const recordId = String(req.params.recordId);
    if (entity === 'images' && req.user.role !== 'admin') {
      const image = await prisma.syncRecord.findUnique({
        where: { entity_recordId: { entity, recordId } },
        select: { payload: true, deletedAt: true },
      });
      const ownerId = String((image && image.payload && (image.payload.owner_id || image.payload.ownerId)) || '').trim();
      if (!image || image.deletedAt) return fail(res, 404, 'Image not found');
      if (!ownerId || ownerId !== String(req.user.id || '').trim()) return fail(res, 403, 'You can only delete images you uploaded');
    }
    const result = await prisma.syncRecord.updateMany({
      where: { entity, recordId },
      data: { deletedAt: new Date() },
    });
    await writeAuditLog({
      userId: req.user.id,
      action: `sync.${entity}.delete`,
      entityType: 'sync_record',
      entityId: recordId,
      payload: { matched_count: result.count },
    });
    return ok(res, { entity, record_id: recordId, deleted: result.count > 0, already_missing: result.count === 0 });
  } catch (error) {
    return fail(res, 404, 'Could not delete synced record', error.message);
  }
});

module.exports = router;
