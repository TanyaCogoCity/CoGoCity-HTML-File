const express = require('express');
const { prisma } = require('../lib/prisma');
const { ok, fail } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');

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

router.patch('/:id/read', requireAuth, async (req, res) => {
  const n = await prisma.notification.findUnique({ where: { id: req.params.id } });
  if (!n || n.userId !== req.user.id) return fail(res, 404, 'Notification not found');
  const updated = await prisma.notification.update({ where: { id: n.id }, data: { isRead: true } });
  return ok(res, { id: updated.id, is_read: updated.isRead });
});

module.exports = router;
