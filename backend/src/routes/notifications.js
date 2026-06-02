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

router.get('/', requireAuth, async (req, res) => {
  const rows = await prisma.notification.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return ok(res, rows.map((n) => ({
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
  if (req.user.role !== 'admin' && userId !== req.user.id) return fail(res, 403, 'Forbidden');

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

    const receiptId = `${userId}:${frontendId}`;
    const existing = await prisma.syncRecord.findUnique({
      where: { entity_recordId: { entity: 'notification_email_receipts', recordId: receiptId } },
    });
    if (existing && !existing.deletedAt) {
      skippedCount += 1;
      continue;
    }

    const action = item.action && typeof item.action === 'object' ? item.action : {};
    const body = String(item.body || item.message || title).trim();
    const notification = await createNotification({
      data: {
        userId,
        type: frontendNotificationType(action.type || item.type),
        title,
        body,
        link: frontendNotificationLink(item),
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
