const { prisma } = require('./prisma');
const { createNotification } = require('./notifications');
const { notificationType } = require('./compat');

const DIRECT_JOB_EXPIRY_REMINDER_DAYS = [5, 2, 1];
const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(value = new Date()) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function daysUntil(value) {
  if (!value) return null;
  const target = new Date(value);
  if (Number.isNaN(target.getTime())) return null;
  return Math.ceil((startOfDay(target).getTime() - startOfDay().getTime()) / DAY_MS);
}

function formatDate(value) {
  return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

async function createDirectJobExpiryReminder(job, daysLeft) {
  const link = `/dashboard?section=my_jobs&employerMyJobsTab=manage&job=${job.id}`;
  const title = `Job listing expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
  const existing = await prisma.notification.findFirst({
    where: {
      userId: job.createdBy,
      title,
      link,
    },
    select: { id: true },
  });
  if (existing) return false;
  await createNotification({
    data: {
      userId: job.createdBy,
      type: notificationType('system'),
      title,
      body: `"${job.title}" expires on ${formatDate(job.expiresAt)} and will be removed from the job board unless extended.`,
      link,
      dedupeKey: `job_expiration:${job.id}:${daysLeft}`,
    },
  });
  return true;
}

async function sendDirectJobExpirationReminders() {
  const now = new Date();
  const maxReminderDate = new Date(now.getTime() + Math.max(...DIRECT_JOB_EXPIRY_REMINDER_DAYS) * DAY_MS);
  const jobs = await prisma.job.findMany({
    where: {
      deletedAt: null,
      status: 'open',
      expiresAt: {
        gte: startOfDay(now),
        lte: new Date(maxReminderDate.getFullYear(), maxReminderDate.getMonth(), maxReminderDate.getDate(), 23, 59, 59, 999),
      },
    },
    select: {
      id: true,
      createdBy: true,
      title: true,
      expiresAt: true,
    },
    take: 500,
  });
  let sent = 0;
  for (const job of jobs) {
    const daysLeft = daysUntil(job.expiresAt);
    if (!DIRECT_JOB_EXPIRY_REMINDER_DAYS.includes(daysLeft)) continue;
    // Run sequentially so one duplicate check finishes before the next email is attempted.
    // eslint-disable-next-line no-await-in-loop
    if (await createDirectJobExpiryReminder(job, daysLeft)) sent += 1;
  }
  if (sent) console.log(`direct_job_expiration_reminders_sent=${sent}`);
  return { checked: jobs.length, sent };
}

function startDirectJobExpirationReminderSchedule() {
  sendDirectJobExpirationReminders().catch((error) => console.error('direct_job_expiration_reminders_failed', error.message));
  const interval = setInterval(() => {
    sendDirectJobExpirationReminders().catch((error) => console.error('direct_job_expiration_reminders_failed', error.message));
  }, 6 * 60 * 60 * 1000);
  if (typeof interval.unref === 'function') interval.unref();
}

module.exports = {
  DIRECT_JOB_EXPIRY_REMINDER_DAYS,
  sendDirectJobExpirationReminders,
  startDirectJobExpirationReminderSchedule,
};
