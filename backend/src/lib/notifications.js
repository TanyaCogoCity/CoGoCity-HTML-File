const { prisma } = require('./prisma');
const { sendNotificationEmail } = require('./email');
const config = require('../config');

const protectedStagingEmails = new Set([
  'tanya.lipovich@gmail.com',
  'ilya.lipovich@getcider.com',
  'dan.lipovich@gmail.com',
  'dan.lipovich+staging@gmail.com',
]);

function isStagingRuntime() {
  return /staging\.cogocity\.com/i.test(String(config.appUrl || config.apiBaseUrl || ''));
}

function shouldSkipMisaddressedStagingEmail(user = {}) {
  if (!isStagingRuntime()) return false;
  const email = String(user.email || '').trim().toLowerCase();
  if (!protectedStagingEmails.has(email)) return false;
  const displayName = String(user.displayName || '').trim();
  return /\bqa\b|automated/i.test(displayName);
}

async function sendEmailForNotification(data) {
  const user = await prisma.user.findUnique({
    where: { id: data.userId },
    select: { email: true, displayName: true },
  });
  if (!user?.email) return { skipped: true, reason: 'missing_recipient' };
  if (shouldSkipMisaddressedStagingEmail(user)) {
    console.warn('notification_email_skipped_misaddressed_staging_user', { userId: data.userId, email: user.email, displayName: user.displayName });
    return { skipped: true, reason: 'misaddressed_staging_qa_user' };
  }
  return sendNotificationEmail({ user, title: data.title, body: data.body, link: data.link });
}

async function emailNotification(data, { required = false } = {}) {
  try {
    return await sendEmailForNotification(data);
  } catch (error) {
    if (required) throw error;
    // Never fail the product action because email delivery failed.
    console.error('notification_email_failed', error.message);
    return { skipped: true, reason: 'send_failed' };
  }
}

function withDefaultLink(row = {}) {
  const { dedupeKey, dedupe_key: dedupeKeySnake, ...safeRow } = row || {};
  return Object.assign({ link: '/dashboard?section=notifications' }, safeRow, {
    link: safeRow.link || '/dashboard?section=notifications',
  });
}

function notificationReceiptId(userId = '', dedupeKey = '') {
  return `${userId}:notification:${dedupeKey}`;
}

async function recordNotificationReceipt({ userId, dedupeKey, notification, reusedExisting = false }) {
  if (!userId || !dedupeKey || !notification?.id) return;
  await prisma.syncRecord.upsert({
    where: { entity_recordId: { entity: 'notification_dedupe_receipts', recordId: notificationReceiptId(userId, dedupeKey) } },
    create: {
      entity: 'notification_dedupe_receipts',
      recordId: notificationReceiptId(userId, dedupeKey),
      payload: {
        user_id: userId,
        dedupe_key: dedupeKey,
        backend_notification_id: notification.id,
        title: notification.title,
        reused_existing: reusedExisting,
      },
    },
    update: {
      deletedAt: null,
      payload: {
        user_id: userId,
        dedupe_key: dedupeKey,
        backend_notification_id: notification.id,
        title: notification.title,
        reused_existing: reusedExisting,
      },
    },
  });
}

async function createNotificationRaw({ data, emailRequired = false, sendEmail = true }) {
  const payload = withDefaultLink(data);
  const notification = await prisma.notification.create({ data: payload });
  const email = sendEmail
    ? await emailNotification(payload, { required: emailRequired })
    : { skipped: true, reason: 'email_disabled_for_notification' };
  return Object.assign(notification, { email });
}

async function createNotification({ data, emailRequired = false, sendEmail = true }) {
  const key = String(data?.dedupeKey || data?.dedupe_key || '').trim();
  if (key) return createNotificationOnce({ data, emailRequired, sendEmail, dedupeKey: key });
  return createNotificationRaw({ data, emailRequired, sendEmail });
}

async function createNotificationOnce({ data, emailRequired = false, sendEmail = true, dedupeKey = '' }) {
  const key = String(dedupeKey || data?.dedupeKey || data?.dedupe_key || '').trim();
  if (!key) return createNotificationRaw({ data, emailRequired, sendEmail });

  const payload = withDefaultLink(data);
  const receiptId = notificationReceiptId(payload.userId, key);
  const existingReceipt = await prisma.syncRecord.findUnique({
    where: { entity_recordId: { entity: 'notification_dedupe_receipts', recordId: receiptId } },
  });
  const existingNotificationId = existingReceipt && !existingReceipt.deletedAt
    ? String(existingReceipt.payload?.backend_notification_id || '').trim()
    : '';
  if (existingNotificationId) {
    const existingNotification = await prisma.notification.findUnique({ where: { id: existingNotificationId } });
    if (existingNotification) return Object.assign(existingNotification, { email: { skipped: true, reason: 'duplicate_notification' } });
  }

  const recentDuplicate = await prisma.notification.findFirst({
    where: {
      userId: payload.userId,
      title: payload.title,
      body: payload.body,
      link: payload.link,
      createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (recentDuplicate) {
    await recordNotificationReceipt({ userId: payload.userId, dedupeKey: key, notification: recentDuplicate, reusedExisting: true });
    return Object.assign(recentDuplicate, { email: { skipped: true, reason: 'duplicate_notification' } });
  }

  const notification = await createNotificationRaw({ data: payload, emailRequired, sendEmail });
  await recordNotificationReceipt({ userId: payload.userId, dedupeKey: key, notification });
  return notification;
}

async function createNotifications({ data }) {
  const rows = Array.isArray(data) ? data : [];
  const results = await Promise.all(rows.map((row) => {
    const dedupeKey = String(row?.dedupeKey || row?.dedupe_key || '').trim();
    return dedupeKey
      ? createNotificationOnce({ data: row, dedupeKey })
      : createNotification({ data: row });
  }));
  return { count: results.length, notifications: results };
}

module.exports = { createNotification, createNotificationOnce, createNotifications };
