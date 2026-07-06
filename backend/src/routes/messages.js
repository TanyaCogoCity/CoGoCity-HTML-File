const express = require('express');
const { prisma } = require('../lib/prisma');
const { ok, created, fail } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');
const { normalizeMessagePayload, serializeMessage, notificationType } = require('../lib/compat');
const { ensureConversationBetweenUsers } = require('../lib/messaging');
const { writeAuditLog } = require('../lib/audit');
const { requirePlatformReady } = require('../lib/onboardingGate');
const { createNotifications } = require('../lib/notifications');

const router = express.Router();

const SYSTEM_ADMIN_EMAIL = 'cogo.team@system.local';

async function primaryAdminForUser(userId = '') {
  const admins = await prisma.user.findMany({
    where: {
      role: 'admin',
      status: 'active',
      deletedAt: null,
      id: userId ? { not: userId } : undefined,
      email: { not: SYSTEM_ADMIN_EMAIL },
    },
    orderBy: { createdAt: 'asc' },
    take: 1,
  });
  return admins[0] || null;
}

function publicConversationName(user = null, viewer = null, fallback = 'Conversation') {
  if (!user) return fallback;
  if (user.role === 'admin' && viewer?.role !== 'admin') return 'Admin';
  return user.displayName || fallback;
}

async function messageTargetsAdmin(payload = {}, senderId = '') {
  if (payload.recipientId) {
    const recipient = await prisma.user.findUnique({ where: { id: payload.recipientId }, select: { role: true } });
    return recipient?.role === 'admin';
  }
  if (payload.conversationId) {
    const adminParticipant = await prisma.conversationParticipant.findFirst({
      where: {
        conversationId: payload.conversationId,
        userId: { not: senderId },
        user: { role: 'admin' },
      },
    });
    return Boolean(adminParticipant);
  }
  return false;
}

router.get('/', requireAuth, async (req, res) => {
  const conversationId = String(req.query.conversation_id || req.query.thread_id || '').trim();

  if (conversationId) {
    const member = await prisma.conversationParticipant.findFirst({ where: { conversationId, userId: req.user.id } });
    if (!member) return fail(res, 403, 'Forbidden conversation');

    const messages = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      include: { sender: { select: { id: true, displayName: true, role: true } } },
    });

    await prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId, userId: req.user.id } },
      data: { lastReadAt: new Date() },
    });

    return ok(res, messages.map((m) => ({
      ...serializeMessage(m),
      sender_name: publicConversationName(m.sender, req.user, m.sender.displayName),
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

  const data = await Promise.all(rows.map(async (row) => {
    const lastMessage = row.conversation.messages[0] || null;
    const partner = row.conversation.participants.find((p) => p.userId !== req.user.id)?.user;
    const isUnread = lastMessage && (!row.lastReadAt || new Date(lastMessage.createdAt) > new Date(row.lastReadAt));
    const unreadWhere = {
      conversationId: row.conversationId,
      senderId: { not: req.user.id },
    };
    if (row.lastReadAt) unreadWhere.createdAt = { gt: row.lastReadAt };
    const unreadCount = await prisma.message.count({ where: unreadWhere });
    return {
      conversation_id: row.conversationId,
      thread_id: row.conversationId,
      thread_label: row.conversation.label,
      project_id: row.conversation.projectId,
      partner_id: partner?.id || null,
      partner_name: publicConversationName(partner, req.user, 'Conversation'),
      partner_role: partner?.role || null,
      last_message: lastMessage ? serializeMessage(lastMessage) : null,
      unread: Boolean(isUnread),
      unread_count: unreadCount,
      unreadCount,
    };
  }));

  return ok(res, data);
});

router.post('/contact-admin', requireAuth, async (req, res) => {
  try {
    const messageText = String(req.body?.message || req.body?.message_text || req.body?.issue || '').trim();
    if (!messageText) return fail(res, 400, 'Request/issue is required');

    const admin = await primaryAdminForUser(req.user.id);
    if (!admin) return fail(res, 404, 'Admin account not found');

    const name = String(req.body?.name || req.user.displayName || '').trim();
    const conversation = await ensureConversationBetweenUsers({
      userAId: req.user.id,
      userBId: admin.id,
      label: 'Admin Support',
    });
    const body = `${name ? `Name: ${name}\n` : ''}Request/issue:\n${messageText}`;
    const msg = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderId: req.user.id,
        messageText: body,
        messageType: 'user',
      },
    });

    await prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId: conversation.id, userId: req.user.id } },
      data: { lastReadAt: new Date() },
    });

    await writeAuditLog({ userId: req.user.id, action: 'message.contact_admin', entityType: 'message', entityId: msg.id, payload: { conversationId: conversation.id } });

    return created(res, {
      conversation_id: conversation.id,
      thread_id: conversation.id,
      admin: { id: admin.id, display_name: 'Admin', name: 'Admin', role: 'admin' },
      message: Object.assign(serializeMessage(msg), { sender_name: req.user.displayName }),
    });
  } catch (error) {
    return fail(res, 400, 'Failed to send admin message', error.message);
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const payload = normalizeMessagePayload(req.body || {});
    if (!payload.messageText.trim()) return fail(res, 400, 'message is required');
    const isAdminSupportMessage = req.user.role !== 'admin' && await messageTargetsAdmin(payload, req.user.id);
    if (!isAdminSupportMessage) {
      const gate = await requirePlatformReady({ prisma, user: req.user, requirePayment: ['employer', 'neighbor'].includes(req.user.role), requirePayout: req.user.role === 'student' });
      if (!gate.ok) return fail(res, gate.status, gate.message, gate.requirements);
    }

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

    if (isSystem && recipients.length) {
      const notificationRows = [];
      for (const r of recipients) {
        const row = {
          userId: r.userId,
          type: notificationType('message'),
          title: 'CoGoCity team update',
          body: payload.messageText.slice(0, 180),
          link: `/dashboard?section=messages&thread=${conversationId}`,
        };
        notificationRows.push(row);
      }
      if (notificationRows.length) await createNotifications({ data: notificationRows });
    }

    await writeAuditLog({ userId: req.user.id, action: 'message.send', entityType: 'message', entityId: msg.id, payload: req.body });

    return created(res, serializeMessage(msg));
  } catch (error) {
    return fail(res, 400, 'Failed to send message', error.message);
  }
});

module.exports = router;
