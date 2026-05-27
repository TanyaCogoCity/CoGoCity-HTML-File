const express = require('express');

const { prisma } = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { ok, fail } = require('../lib/http');
const { writeAuditLog } = require('../lib/audit');

const router = express.Router();

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
  'projects',
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

function isUuid(value = '') {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function workshopStatus(value = '') {
  const status = String(value || '').toLowerCase();
  if (status === 'active') return 'published';
  if (['draft', 'published', 'completed', 'canceled'].includes(status)) return status;
  return 'draft';
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
    return ok(res, { entity, records: rows.map(serialize) });
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

    await writeAuditLog({
      userId: req.user.id,
      action: `sync.${entity}`,
      entityType: 'sync_record',
      entityId: entity,
      payload: { count: normalized.length, mirrored_count: mirrored.length },
    });

    return ok(res, { entity, count: normalized.length, mirrored });
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
