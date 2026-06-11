const express = require('express');
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
  return ['pending', 'applied', 'offer_sent', 'offer_pending'].includes(String(value || '').toLowerCase());
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
  if (/^https?:\/\//i.test(source)) {
    try {
      const upstream = await fetch(source);
      if (!upstream.ok) return fail(res, 404, 'Image data not found');
      const contentType = upstream.headers.get('content-type') || 'image/jpeg';
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
    const normalized = records.map((record) => normalizeRecord(record, entity)).filter(Boolean).slice(0, 1000);
    if (entity === 'testimonials') {
      const testimonialsWriteAllowed = requireTestimonialsWriteAccess(req, res, normalized, !!req.body?.replace);
      if (testimonialsWriteAllowed !== true) return null;
    }
    if (entity === 'images') {
      const imageWriteAllowed = await requireImageWriteAccess(req, res, normalized);
      if (!imageWriteAllowed) return null;
    }
    if (entity === 'workshops') {
      const payoutReady = await requireSyncedWorkshopPayoutReady(req, res, normalized);
      if (!payoutReady) return null;
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
