const express = require('express');
const { prisma } = require('../lib/prisma');
const { ok, created, fail } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');
const { normalizeMessagePayload, serializeMessage, notificationType } = require('../lib/compat');
const { ensureConversationBetweenUsers } = require('../lib/messaging');
const { writeAuditLog } = require('../lib/audit');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const conversationId = String(req.query.conversation_id || req.query.thread_id || '').trim();

  if (conversationId) {
    const member = await prisma.conversationParticipant.findFirst({ where: { conversationId, userId: req.user.id } });
    if (!member) return fail(res, 403, 'Forbidden conversation');

    const messages = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      include: { sender: { select: { id: true, displayName: true } } },
    });

    await prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId, userId: req.user.id } },
      data: { lastReadAt: new Date() },
    });

    return ok(res, messages.map((m) => ({
      ...serializeMessage(m),
      sender_name: m.sender.displayName,
    })));
  }

  const rows = await prisma.conversationParticipant.findMany({
    where: { userId: req.user.id },
    include: {
      conversation: {
        include: {
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
          participants: { include: { user: { select: { id: true, displayName: true, role: true } } } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const data = rows.map((row) => {
    const lastMessage = row.conversation.messages[0] || null;
    const partner = row.conversation.participants.find((p) => p.userId !== req.user.id)?.user;
    const isUnread = lastMessage && (!row.lastReadAt || new Date(lastMessage.createdAt) > new Date(row.lastReadAt));
    return {
      conversation_id: row.conversationId,
      thread_id: row.conversationId,
      thread_label: row.conversation.label,
      project_id: row.conversation.projectId,
      partner_id: partner?.id || null,
      partner_name: partner?.displayName || 'Conversation',
      partner_role: partner?.role || null,
      last_message: lastMessage ? serializeMessage(lastMessage) : null,
      unread: Boolean(isUnread),
    };
  });

  return ok(res, data);
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const payload = normalizeMessagePayload(req.body || {});
    if (!payload.messageText.trim()) return fail(res, 400, 'message is required');

    let conversationId = payload.conversationId;

    if (!conversationId) {
      if (!payload.recipientId) return fail(res, 400, 'recipient_id or thread_id is required');
      const conversation = await ensureConversationBetweenUsers({
        userAId: req.user.id,
        userBId: payload.recipientId,
        projectId: payload.projectId,
        label: payload.label,
      });
      conversationId = conversation.id;
    }

    const participant = await prisma.conversationParticipant.findFirst({ where: { conversationId, userId: req.user.id } });
    if (!participant) return fail(res, 403, 'Forbidden conversation');

    const isSystem = payload.messageType === 'system';
    if (isSystem && req.user.role !== 'admin') return fail(res, 403, 'Only admin can send system messages');

    const msg = await prisma.message.create({
      data: {
        conversationId,
        senderId: req.user.id,
        messageText: payload.messageText,
        messageType: isSystem ? 'system' : 'user',
      },
    });

    await prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId, userId: req.user.id } },
      data: { lastReadAt: new Date() },
    });

    const recipients = await prisma.conversationParticipant.findMany({
      where: { conversationId, userId: { not: req.user.id } },
    });

    if (recipients.length) {
      await prisma.notification.createMany({
        data: recipients.map((r) => ({
          userId: r.userId,
          type: notificationType('message'),
          title: isSystem ? 'CoGo Team update' : 'New message',
          body: payload.messageText.slice(0, 180),
          link: `/dashboard?section=messages&thread=${conversationId}`,
        })),
      });
    }

    await writeAuditLog({ userId: req.user.id, action: 'message.send', entityType: 'message', entityId: msg.id, payload: req.body });

    return created(res, serializeMessage(msg));
  } catch (error) {
    return fail(res, 400, 'Failed to send message', error.message);
  }
});

module.exports = router;
