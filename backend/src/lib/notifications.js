const { prisma } = require('./prisma');
const { sendNotificationEmail } = require('./email');

async function sendEmailForNotification(data) {
  const user = await prisma.user.findUnique({
    where: { id: data.userId },
    select: { email: true, displayName: true },
  });
  if (!user?.email) return { skipped: true, reason: 'missing_recipient' };
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

async function createNotification({ data, emailRequired = false }) {
  const notification = await prisma.notification.create({ data });
  const email = await emailNotification(data, { required: emailRequired });
  return Object.assign(notification, { email });
}

async function createNotifications({ data }) {
  const rows = Array.isArray(data) ? data : [];
  const result = await prisma.notification.createMany({ data: rows });
  await Promise.all(rows.map((row) => emailNotification(row)));
  return result;
}

module.exports = { createNotification, createNotifications };
