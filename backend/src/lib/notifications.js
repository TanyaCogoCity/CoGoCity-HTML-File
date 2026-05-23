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
  return Object.assign({ link: '/dashboard?section=notifications' }, row, {
    link: row.link || '/dashboard?section=notifications',
  });
}

async function createNotification({ data, emailRequired = false }) {
  const payload = withDefaultLink(data);
  const notification = await prisma.notification.create({ data: payload });
  const email = await emailNotification(payload, { required: emailRequired });
  return Object.assign(notification, { email });
}

async function createNotifications({ data }) {
  const rows = (Array.isArray(data) ? data : []).map(withDefaultLink);
  const result = await prisma.notification.createMany({ data: rows });
  await Promise.all(rows.map((row) => emailNotification(row)));
  return result;
}

module.exports = { createNotification, createNotifications };
