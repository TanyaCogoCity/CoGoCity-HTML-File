const express = require('express');
const { prisma } = require('../lib/prisma');
const { ok, fail } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');
const { notificationType } = require('../lib/compat');
const { createNotification } = require('../lib/notifications');

const router = express.Router();

function frontendNotificationType(value = '') {
  const type = String(value || '').toLowerCase();
  return ['application', 'project', 'payment', 'message', 'workshop', 'payout', 'refund', 'system'].includes(type)
    ? notificationType(type)
    : notificationType('system');
}

function frontendNotificationLink(item = {}) {
  const link = String(item.link || '').trim();
  if (link) return link;
  const action = item.action || {};
  if (action && action.type === 'dashboard') return '/dashboard';
  return '/dashboard?section=notifications';
}

function frontendNotificationReceiptId(userId = '', item = {}) {
  const dedupeKey = String(item.dedupeKey || item.dedupe_key || item.action?.dedupeKey || item.action?.dedupe_key || '').trim();
  if (dedupeKey) return `${userId}:dedupe:${dedupeKey}`;
  return `${userId}:${String(item?.id || '').trim()}`;
}

function notificationVisibleDedupeKey(row = {}) {
  const title = String(row.title || '').toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
  if (title.includes("you've been paid") && title.includes('my transactions')) return `student_payment:${title}`;
  if (title.startsWith("you've got a message from ")) return `message_thread:${title}:${row.link || ''}`;
  return '';
}

function dedupeNotificationRows(rows = []) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = notificationVisibleDedupeKey(row);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isCommunityApplicationForUser(payload = {}, userId = '') {
  const employerId = String(payload.employerId || payload.employer_id || '').trim();
  const status = String(payload.status || '').trim().toLowerCase();
  const source = String(payload.source || '').trim().toLowerCase();
  return employerId === userId
    && ['pending', 'applied'].includes(status)
    && (!source || source === 'community_feed');
}

async function backfillCommunityApplicationNotifications(userId = '') {
  if (!userId) return 0;
  const rows = await prisma.syncRecord.findMany({
    where: { entity: 'applications', deletedAt: null },
    select: { recordId: true, payload: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 250,
  });
  const candidates = rows.filter((row) => isCommunityApplicationForUser(row.payload || {}, userId));
  if (!candidates.length) return 0;

  const receiptIds = candidates.map((row) => `${userId}:${row.recordId}:student_application`);
  const receipts = await prisma.syncRecord.findMany({
    where: { entity: 'notification_email_receipts', recordId: { in: receiptIds }, deletedAt: null },
    select: { recordId: true },
  });
  const existing = new Set(receipts.map((row) => row.recordId));
  let created = 0;

  for (const row of candidates) {
    const receiptId = `${userId}:${row.recordId}:student_application`;
    if (existing.has(receiptId)) continue;
    const payload = row.payload || {};
    const studentName = String(payload.studentName || payload.student_name || 'A student').trim();
    const jobTitle = String(payload.jobTitle || payload.job_title || 'your job').trim();
    const notification = await createNotification({
      data: {
        userId,
        type: notificationType('application'),
        title: `${studentName} applied to "${jobTitle}"`,
        body: `${studentName} applied to "${jobTitle}". Open your dashboard to review the request.`,
        link: `/dashboard?section=applicants_projects&employerTab=applicants&application=${encodeURIComponent(row.recordId)}`,
      },
    });
    await prisma.syncRecord.upsert({
      where: { entity_recordId: { entity: 'notification_email_receipts', recordId: receiptId } },
      create: {
        entity: 'notification_email_receipts',
        recordId: receiptId,
        payload: {
          user_id: userId,
          frontend_notification_id: row.recordId,
          backend_notification_id: notification.id,
          title: notification.title,
          emailed: !notification.email?.skipped,
          email: notification.email || null,
        },
      },
      update: {
        deletedAt: null,
        payload: {
          user_id: userId,
          frontend_notification_id: row.recordId,
          backend_notification_id: notification.id,
          title: notification.title,
          emailed: !notification.email?.skipped,
          email: notification.email || null,
        },
      },
    });
    existing.add(receiptId);
    created += 1;
  }
  return created;
}

router.get('/', requireAuth, async (req, res) => {
  try {
    await backfillCommunityApplicationNotifications(req.user.id);
  } catch (error) {
    console.warn('community_application_notification_backfill_failed', error.message);
  }
  const rows = await prisma.notification.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return ok(res, dedupeNotificationRows(rows).map((n) => ({
    id: n.id,
    user_id: n.userId,
    type: n.type,
    title: n.title,
    body: n.body,
    is_read: n.isRead,
    link: n.link,
    created_at: n.createdAt,
  })));
});

router.post('/sync', requireAuth, async (req, res) => {
  const userId = String(req.body?.user_id || req.body?.userId || '').trim();
  if (!userId) return fail(res, 400, 'user_id is required');
  const recipient = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null, status: 'active' },
    select: { id: true },
  });
  if (!recipient) return fail(res, 404, 'Notification recipient not found');

  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  let createdCount = 0;
  let skippedCount = 0;

  for (const item of items.slice(0, 50)) {
    const frontendId = String(item?.id || '').trim();
    const title = String(item?.title || '').trim();
    if (!frontendId || !title) {
      skippedCount += 1;
      continue;
    }

    const receiptId = frontendNotificationReceiptId(userId, item);
    const existing = await prisma.syncRecord.findUnique({
      where: { entity_recordId: { entity: 'notification_email_receipts', recordId: receiptId } },
    });
    if (existing && !existing.deletedAt) {
      skippedCount += 1;
      continue;
    }

    const action = item.action && typeof item.action === 'object' ? item.action : {};
    const body = String(item.body || item.message || title).trim();
    const link = frontendNotificationLink(item);
    const recentDuplicate = await prisma.notification.findFirst({
      where: {
        userId,
        title,
        link,
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (recentDuplicate) {
      await prisma.syncRecord.upsert({
        where: { entity_recordId: { entity: 'notification_email_receipts', recordId: receiptId } },
        create: {
          entity: 'notification_email_receipts',
          recordId: receiptId,
          payload: {
            user_id: userId,
            frontend_notification_id: frontendId,
            backend_notification_id: recentDuplicate.id,
            title,
            dedupe_key: item.dedupeKey || item.dedupe_key || action.dedupeKey || action.dedupe_key || null,
            reused_existing: true,
          },
        },
        update: {
          deletedAt: null,
          payload: {
            user_id: userId,
            frontend_notification_id: frontendId,
            backend_notification_id: recentDuplicate.id,
            title,
            dedupe_key: item.dedupeKey || item.dedupe_key || action.dedupeKey || action.dedupe_key || null,
            reused_existing: true,
          },
        },
      });
      skippedCount += 1;
      continue;
    }
    const notification = await createNotification({
      data: {
        userId,
        type: frontendNotificationType(action.type || item.type),
        title,
        body,
        link,
      },
    });

    await prisma.syncRecord.upsert({
      where: { entity_recordId: { entity: 'notification_email_receipts', recordId: receiptId } },
      create: {
        entity: 'notification_email_receipts',
        recordId: receiptId,
        payload: {
          user_id: userId,
          frontend_notification_id: frontendId,
          backend_notification_id: notification.id,
          title,
          dedupe_key: item.dedupeKey || item.dedupe_key || action.dedupeKey || action.dedupe_key || null,
          emailed: !notification.email?.skipped,
          email: notification.email || null,
        },
      },
      update: {
        deletedAt: null,
        payload: {
          user_id: userId,
          frontend_notification_id: frontendId,
          backend_notification_id: notification.id,
          title,
          dedupe_key: item.dedupeKey || item.dedupe_key || action.dedupeKey || action.dedupe_key || null,
          emailed: !notification.email?.skipped,
          email: notification.email || null,
        },
      },
    });
    createdCount += 1;
  }

  return ok(res, { created: createdCount, skipped: skippedCount });
});

router.post('/test-email', requireAuth, async (req, res) => {
  try {
    const notification = await createNotification({
      data: {
        userId: req.user.id,
        type: notificationType('system'),
        title: 'CoGoCity staging email test',
        body: 'If you received this, Brevo transactional email is connected to staging.',
        link: '/dashboard?section=notifications',
      },
      emailRequired: true,
    });
    return ok(res, { sent: !notification.email?.skipped, notification_id: notification.id, email: notification.email });
  } catch (error) {
    console.error('staging_email_test_failed', error.message);
    return ok(res, { sent: false, error: error.message });
  }
});

router.patch('/:id/read', requireAuth, async (req, res) => {
  const n = await prisma.notification.findUnique({ where: { id: req.params.id } });
  if (!n || n.userId !== req.user.id) return fail(res, 404, 'Notification not found');
  const updated = await prisma.notification.update({ where: { id: n.id }, data: { isRead: true } });
  return ok(res, { id: updated.id, is_read: updated.isRead });
});

module.exports = router;
