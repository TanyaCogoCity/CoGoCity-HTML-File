const express = require('express');
const Stripe = require('stripe');

const { prisma } = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { ok, fail } = require('../lib/http');
const { writeAuditLog } = require('../lib/audit');
const config = require('../config');
const { stripeConnectReady } = require('../lib/onboardingGate');

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
const ADMIN_WRITE_ENTITIES = new Set(['blog_posts', 'direct_job_packages', 'payment_settings', 'site_settings', 'images', 'finance', 'admin_action_log', 'email_queue']);
const DEDICATED_ROUTE_ENTITIES = new Set([
  'users',
  'students',
  'direct_jobs',
  'direct_job_applications',
  'messages',
  'notifications',
  'transactions',
]);

function normalizeRecord(record = {}, entity = '') {
  const fallbackId = SINGLETON_ENTITIES.has(entity) ? entity : '';
  const id = String(record.id || record.record_id || record.user_id || record.key || fallbackId || '').trim();
  if (!id) return null;
  const payload = { ...record, id };
  payload.updatedAt = payload.updatedAt || payload.updated_at || new Date().toISOString();
  return { id, payload };
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
    return {
      ...serialize(row),
      registered_count: registeredCount,
      registeredCount,
      spots_left: capacity && capacity > 0 ? Math.max(0, capacity - registeredCount) : null,
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
    let createdBy = isUuid(payload.host_id) ? payload.host_id : req.user.id;
    const creator = await prisma.user.findUnique({ where: { id: createdBy }, select: { id: true } }).catch(() => null);
    if (!creator) createdBy = req.user.id;

    let workshop = null;
    const backendWorkshopId = payload.backend_workshop_id || payload.backendWorkshopId;
    if (isUuid(backendWorkshopId)) {
      workshop = await prisma.workshop.findUnique({ where: { id: backendWorkshopId } });
    }
    if (!workshop && isUuid(record.id)) {
      workshop = await prisma.workshop.findUnique({ where: { id: record.id } });
    }

    const data = workshopDataFromPayload(payload, workshop?.createdBy || createdBy);
    if (workshop) {
      workshop = await prisma.workshop.update({ where: { id: workshop.id }, data });
    } else {
      workshop = await prisma.workshop.create({ data });
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

router.get('/:entity', requireReadAccess, async (req, res) => {
  const entity = validateEntity(req.params.entity);
  try {
    const rows = await prisma.syncRecord.findMany({
      where: { entity, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      take: Math.min(Number(req.query.limit || 500) || 500, 1000),
    });
    const records = entity === 'workshops' ? await serializeWorkshopRows(rows) : rows.map(serialize);
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

    await writeAuditLog({
      userId: req.user.id,
      action: `sync.${entity}`,
      entityType: 'sync_record',
      entityId: entity,
      payload: { count: normalized.length, mirrored_count: mirrored.length, application_count_updates: applicationCountUpdates },
    });

    return ok(res, { entity, count: normalized.length, mirrored, application_count_updates: applicationCountUpdates });
  } catch (error) {
    return fail(res, 400, 'Could not sync records', error.message);
  }
});

router.delete('/:entity/:recordId', requireAuth, async (req, res) => {
  const entity = validateEntity(req.params.entity);
  if (!entity) return fail(res, 404, 'Unknown sync entity');
  if (DEDICATED_ROUTE_ENTITIES.has(entity)) return fail(res, 410, 'Use the dedicated API route for this entity');
  if (ADMIN_WRITE_ENTITIES.has(entity) && req.user.role !== 'admin') return fail(res, 403, 'Admin access required');

  try {
    await prisma.syncRecord.update({
      where: { entity_recordId: { entity, recordId: String(req.params.recordId) } },
      data: { deletedAt: new Date() },
    });
    await writeAuditLog({
      userId: req.user.id,
      action: `sync.${entity}.delete`,
      entityType: 'sync_record',
      entityId: String(req.params.recordId),
      payload: null,
    });
    return ok(res, { entity, record_id: String(req.params.recordId) });
  } catch (error) {
    return fail(res, 404, 'Could not delete synced record', error.message);
  }
});

module.exports = router;
