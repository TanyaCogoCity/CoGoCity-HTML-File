const express = require('express');
const { prisma } = require('../lib/prisma');
const { ok, fail } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');
const { notificationType } = require('../lib/compat');
const { createNotification } = require('../lib/notifications');

const router = express.Router();

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
    return fail(res, 502, 'Staging email test failed', error.message);
  }
});

router.patch('/:id/read', requireAuth, async (req, res) => {
  const n = await prisma.notification.findUnique({ where: { id: req.params.id } });
  if (!n || n.userId !== req.user.id) return fail(res, 404, 'Notification not found');
  const updated = await prisma.notification.update({ where: { id: n.id }, data: { isRead: true } });
  return ok(res, { id: updated.id, is_read: updated.isRead });
});

module.exports = router;
