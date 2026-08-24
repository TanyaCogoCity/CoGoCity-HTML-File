const { prisma } = require('./prisma');
const { createNotification } = require('./notifications');
const { notificationType } = require('./compat');
const { sendDirectMessageReminderEmail } = require('./email');

const DIRECT_MESSAGE_EMAIL_ENTITY = 'pending_direct_message_email';
const DIRECT_MESSAGE_EMAIL_DELAY_MS = 5 * 60 * 1000;
const DIRECT_MESSAGE_EMAIL_POLL_MS = 60 * 1000;

function pendingDirectMessageEmailRecordId(conversationId = '', recipientId = '') {
  return `${String(conversationId || '').trim()}:${String(recipientId || '').trim()}`;
}

function isPendingDirectMessageEmailPayload(payload = {}) {
  return payload && typeof payload === 'object' && !Array.isArray(payload);
}

function pendingPayloadFromRecord(record = null) {
  if (!record || typeof record !== 'object') return null;
  const rawPayload = record.payload;
  return isPendingDirectMessageEmailPayload(rawPayload) ? rawPayload : null;
}

function validDate(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function directMessageThreadLink(conversationId = '') {
  return `/#/dashboard?section=messages&thread=${encodeURIComponent(String(conversationId || '').trim())}`;
}

function senderDisplayName(user = {}) {
  return String(user.displayName || user.email || 'Someone').trim() || 'Someone';
}

async function scheduleDirectMessageReminder({
  conversationId = '',
  messageId = '',
  messageCreatedAt = null,
  sender = null,
  recipient = null,
} = {}) {
  const nextConversationId = String(conversationId || '').trim();
  const nextMessageId = String(messageId || '').trim();
  const recipientId = String(recipient?.id || '').trim();
  const senderId = String(sender?.id || '').trim();
  if (!nextConversationId || !nextMessageId || !recipientId || !senderId) return null;

  const createdAt = validDate(messageCreatedAt) || new Date();
  const triggerAt = new Date(createdAt.getTime() + DIRECT_MESSAGE_EMAIL_DELAY_MS);
  const recordId = pendingDirectMessageEmailRecordId(nextConversationId, recipientId);
  const payload = {
    conversation_id: nextConversationId,
    message_id: nextMessageId,
    message_created_at: createdAt.toISOString(),
    trigger_at: triggerAt.toISOString(),
    recipient_id: recipientId,
    recipient_email: String(recipient?.email || '').trim().toLowerCase(),
    recipient_name: String(recipient?.displayName || recipient?.email || 'User').trim() || 'User',
    sender_id: senderId,
    sender_name: senderDisplayName(sender),
    status: 'pending',
  };

  return prisma.syncRecord.upsert({
    where: { entity_recordId: { entity: DIRECT_MESSAGE_EMAIL_ENTITY, recordId } },
    create: {
      entity: DIRECT_MESSAGE_EMAIL_ENTITY,
      recordId,
      payload,
    },
    update: {
      deletedAt: null,
      payload,
    },
  });
}

async function cancelPendingDirectMessageReminderForReply({
  conversationId = '',
  replierId = '',
  partnerId = '',
} = {}) {
  const nextConversationId = String(conversationId || '').trim();
  const nextReplierId = String(replierId || '').trim();
  const nextPartnerId = String(partnerId || '').trim();
  if (!nextConversationId || !nextReplierId || !nextPartnerId) return false;

  const recordId = pendingDirectMessageEmailRecordId(nextConversationId, nextReplierId);
  const existing = await prisma.syncRecord.findUnique({
    where: { entity_recordId: { entity: DIRECT_MESSAGE_EMAIL_ENTITY, recordId } },
  });
  const payload = pendingPayloadFromRecord(existing);
  if (!payload || payload.status !== 'pending') return false;
  if (String(payload.sender_id || '') !== nextPartnerId) return false;

  await prisma.syncRecord.update({
    where: { entity_recordId: { entity: DIRECT_MESSAGE_EMAIL_ENTITY, recordId } },
    data: {
      payload: {
        ...payload,
        status: 'canceled',
        canceled_at: new Date().toISOString(),
        canceled_reason: 'recipient_replied',
      },
    },
  });
  return true;
}

async function markDirectMessageReminder(recordId = '', payload = {}, updates = {}) {
  return prisma.syncRecord.update({
    where: { entity_recordId: { entity: DIRECT_MESSAGE_EMAIL_ENTITY, recordId } },
    data: {
      payload: {
        ...payload,
        ...updates,
      },
    },
  });
}

async function recipientRepliedBeforeDeadline(payload = {}) {
  const triggerAt = validDate(payload.trigger_at);
  const messageCreatedAt = validDate(payload.message_created_at);
  if (!triggerAt || !messageCreatedAt) return false;
  const reply = await prisma.message.findFirst({
    where: {
      conversationId: String(payload.conversation_id || '').trim(),
      senderId: String(payload.recipient_id || '').trim(),
      createdAt: {
        gt: messageCreatedAt,
        lte: triggerAt,
      },
    },
    select: { id: true },
  });
  return Boolean(reply);
}

async function processDirectMessageReminderRecord(record = null) {
  const payload = pendingPayloadFromRecord(record);
  if (!record || !payload || payload.status !== 'pending') return { checked: false, sent: false };

  const now = Date.now();
  const triggerAt = validDate(payload.trigger_at);
  if (!triggerAt) {
    await markDirectMessageReminder(record.recordId, payload, {
      status: 'canceled',
      canceled_at: new Date().toISOString(),
      canceled_reason: 'invalid_trigger_at',
    });
    return { checked: true, sent: false };
  }
  if (triggerAt.getTime() > now) return { checked: true, sent: false };

  if (await recipientRepliedBeforeDeadline(payload)) {
    await markDirectMessageReminder(record.recordId, payload, {
      status: 'canceled',
      canceled_at: new Date().toISOString(),
      canceled_reason: 'recipient_replied',
    });
    return { checked: true, sent: false };
  }

  const user = await prisma.user.findUnique({
    where: { id: String(payload.recipient_id || '').trim() },
    select: { id: true, email: true, displayName: true },
  });
  if (!user?.id) {
    await markDirectMessageReminder(record.recordId, payload, {
      status: 'canceled',
      canceled_at: new Date().toISOString(),
      canceled_reason: 'recipient_missing',
    });
    return { checked: true, sent: false };
  }

  await createNotification({
    data: {
      userId: user.id,
      type: notificationType('message'),
      title: `New message from ${payload.sender_name || 'Someone'} on CoGo City`,
      body: `You’ve got a message from ${payload.sender_name || 'Someone'}. Open My Messages to reply.`,
      link: `/dashboard?section=messages&thread=${String(payload.conversation_id || '').trim()}`,
      dedupeKey: `direct_message:${String(payload.message_id || '').trim()}:${user.id}`,
    },
    sendEmail: false,
  });

  const emailResult = await sendDirectMessageReminderEmail({
    user,
    senderName: payload.sender_name || 'Someone',
    link: directMessageThreadLink(payload.conversation_id || ''),
  });

  await markDirectMessageReminder(record.recordId, payload, {
    status: emailResult?.skipped ? 'skipped' : 'sent',
    sent_at: new Date().toISOString(),
    email_result: emailResult || null,
  });
  return { checked: true, sent: !emailResult?.skipped };
}

async function processPendingDirectMessageReminders() {
  const rows = await prisma.syncRecord.findMany({
    where: {
      entity: DIRECT_MESSAGE_EMAIL_ENTITY,
      deletedAt: null,
    },
    orderBy: { updatedAt: 'asc' },
    take: 500,
  });

  let sent = 0;
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const result = await processDirectMessageReminderRecord(row);
    if (result.sent) sent += 1;
  }
  if (sent) console.log(`direct_message_reminder_emails_sent=${sent}`);
  return { checked: rows.length, sent };
}

function startDirectMessageReminderSchedule() {
  processPendingDirectMessageReminders().catch((error) => console.error('direct_message_reminders_failed', error.message));
  const interval = setInterval(() => {
    processPendingDirectMessageReminders().catch((error) => console.error('direct_message_reminders_failed', error.message));
  }, DIRECT_MESSAGE_EMAIL_POLL_MS);
  if (typeof interval.unref === 'function') interval.unref();
}

module.exports = {
  DIRECT_MESSAGE_EMAIL_ENTITY,
  DIRECT_MESSAGE_EMAIL_DELAY_MS,
  scheduleDirectMessageReminder,
  cancelPendingDirectMessageReminderForReply,
  processPendingDirectMessageReminders,
  startDirectMessageReminderSchedule,
};
