const { prisma } = require('./prisma');
const { sendEmail, buildAppLink } = require('./email');

const SYSTEM_ADMIN_EMAIL = 'cogo.team@system.local';

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(value = 0) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function roleLabel(role = '') {
  const value = String(role || '').toLowerCase();
  if (value === 'student') return 'Student';
  if (value === 'neighbor') return 'Neighbor';
  if (value === 'employer') return 'Employer';
  if (value === 'admin') return 'Admin';
  return value || 'User';
}

function userName(user = {}) {
  return user.displayName || [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.email || 'CoGo City user';
}

function userAdminLink(user = {}) {
  const userId = String(user.id || '').trim();
  if (!userId) return buildAppLink('/dashboard');
  if (String(user.role || '').toLowerCase() === 'student') {
    return buildAppLink(`/#/profile/${encodeURIComponent(userId)}`);
  }
  return buildAppLink('/dashboard');
}

function linkHtml(label, href) {
  return `<a href="${escapeHtml(href)}" style="color:#2251ff;text-decoration:underline">${escapeHtml(label)}</a>`;
}

function rowsHtml(rows = []) {
  return rows.map(([label, value]) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#667085;font-weight:700;vertical-align:top">${escapeHtml(label)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#18212f;vertical-align:top">${value}</td>
    </tr>
  `).join('');
}

async function activeAdmins() {
  return prisma.user.findMany({
    where: {
      role: 'admin',
      status: 'active',
      deletedAt: null,
      email: { not: SYSTEM_ADMIN_EMAIL },
    },
    select: { id: true, email: true, displayName: true },
    orderBy: { createdAt: 'asc' },
  });
}

async function sendAdminEmail({ subject, title, intro = '', rows = [], ctaLabel = 'Open CoGo City', ctaLink = '/dashboard' }) {
  const admins = await activeAdmins();
  if (!admins.length) return { skipped: true, reason: 'no_active_admins' };
  const safeTitle = escapeHtml(title || subject || 'CoGo City admin alert');
  const safeIntro = escapeHtml(intro || '').replace(/\n/g, '<br>');
  const url = buildAppLink(ctaLink);
  const htmlContent = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#18212f;max-width:680px;margin:0 auto;padding:24px">
      <h2 style="margin:0 0 12px;color:#18212f">${safeTitle}</h2>
      ${safeIntro ? `<p style="margin:0 0 18px">${safeIntro}</p>` : ''}
      <table style="border-collapse:collapse;width:100%;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin:0 0 22px">
        <tbody>${rowsHtml(rows)}</tbody>
      </table>
      <p style="margin:0 0 24px">
        <a href="${escapeHtml(url)}" style="display:inline-block;background:#2251ff;color:white;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600">${escapeHtml(ctaLabel)}</a>
      </p>
      <p style="font-size:12px;color:#667085;margin-top:28px">Admin alert from CoGo City.</p>
    </div>
  `;
  const textRows = rows.map(([label, value]) => `${label}: ${String(value || '').replace(/<[^>]+>/g, '')}`).join('\n');
  return Promise.all(admins.map((admin) => sendEmail({
    to: { email: admin.email, name: admin.displayName },
    subject,
    htmlContent,
    textContent: `${title || subject}\n\n${intro || ''}\n\n${textRows}\n\n${url}`,
  }).catch((error) => {
    console.error('admin_email_failed', error.message);
    return { skipped: true, reason: 'send_failed' };
  })));
}

async function notifyAdminNewUser(user) {
  const name = userName(user);
  return sendAdminEmail({
    subject: `New CoGo City ${roleLabel(user.role)} registered: ${name}`,
    title: 'New User Registered',
    intro: 'A new user completed registration on CoGo City.',
    rows: [
      ['Name', linkHtml(name, userAdminLink(user))],
      ['User ID', escapeHtml(user.id || '')],
      ['User type', escapeHtml(roleLabel(user.role))],
      ['Email', escapeHtml(user.email || '')],
    ],
    ctaLabel: String(user.role || '').toLowerCase() === 'student' ? 'View User' : 'Open Dashboard',
    ctaLink: String(user.role || '').toLowerCase() === 'student'
      ? `/#/profile/${encodeURIComponent(user.id)}`
      : '/dashboard',
  });
}

async function notifyAdminHourlyJobCreated({ lister, title, link, source = 'Dashboard', amount = null }) {
  const name = userName(lister);
  return sendAdminEmail({
    subject: `New hourly job created: ${title}`,
    title: 'New Hourly Job Created',
    intro: 'A new hourly job was created on CoGo City.',
    rows: [
      ['Job', linkHtml(title || 'Hourly job', buildAppLink(link || '/dashboard'))],
      ['Job lister', linkHtml(name, userAdminLink(lister))],
      ['Lister type', escapeHtml(roleLabel(lister.role))],
      ['Source', escapeHtml(source)],
      ...(amount == null ? [] : [['Estimated work value', escapeHtml(money(amount))]]),
    ],
    ctaLabel: 'View Job',
    ctaLink: link || '/dashboard',
  });
}

async function notifyAdminJobListingCreated({ employer, job, link }) {
  const name = userName(employer);
  return sendAdminEmail({
    subject: `New employer job listing: ${job.title}`,
    title: 'New Employer Job Listing',
    intro: 'An employer created a new job listing.',
    rows: [
      ['Employer', linkHtml(name, userAdminLink(employer))],
      ['Job', linkHtml(job.title || 'Job listing', buildAppLink(link || '/dashboard'))],
      ['Listing fee', escapeHtml(money(job.postingFee || 0))],
      ['Payment status', escapeHtml(job.paymentStatus || 'pending')],
    ],
    ctaLabel: 'View Job',
    ctaLink: link || '/dashboard',
  });
}

async function notifyAdminProjectCommission({ payer, payee, title, amountTotal, platformFee, stripePaymentIntentId, link }) {
  return sendAdminEmail({
    subject: `CoGo commission received: ${money(platformFee)} from ${title}`,
    title: 'CoGo Job Commission Received',
    intro: 'A project payment was captured and CoGo commission was recorded.',
    rows: [
      ['Job', linkHtml(title || 'Project payment', buildAppLink(link || '/dashboard?section=transactions'))],
      ['Payer', payer ? linkHtml(userName(payer), userAdminLink(payer)) : ''],
      ['Student', payee ? linkHtml(userName(payee), userAdminLink(payee)) : ''],
      ['Total charged', escapeHtml(money(amountTotal))],
      ['CoGo commission', escapeHtml(money(platformFee))],
      ['Stripe PaymentIntent', escapeHtml(stripePaymentIntentId || '')],
    ],
    ctaLabel: 'View Transactions',
    ctaLink: link || '/dashboard?section=transactions',
  });
}

async function notifyAdminWorkshopListed({ host, workshop, link }) {
  const name = userName(host);
  return sendAdminEmail({
    subject: `New workshop/class listed: ${workshop.title}`,
    title: 'New Workshop/Class Listed',
    intro: 'A new workshop or class was listed on CoGo City.',
    rows: [
      ['Workshop/Class', linkHtml(workshop.title || 'Workshop', buildAppLink(link || '/workshops'))],
      ['Lister', linkHtml(name, userAdminLink(host))],
      ['Lister type', escapeHtml(roleLabel(host.role))],
      ['Price', escapeHtml(money(workshop.price || 0))],
      ['Status', escapeHtml(workshop.status || '')],
    ],
    ctaLabel: 'View Workshop',
    ctaLink: link || '/workshops',
  });
}

async function notifyAdminWorkshopCommission({ host, registrant, workshop, quantity, amountTotal, platformFee, stripePaymentIntentId, link }) {
  return sendAdminEmail({
    subject: `CoGo workshop commission received: ${money(platformFee)} from ${workshop.title}`,
    title: 'CoGo Workshop/Class Commission Received',
    intro: 'A paid workshop/class registration was completed and CoGo commission was recorded.',
    rows: [
      ['Workshop/Class', linkHtml(workshop.title || 'Workshop', buildAppLink(link || '/dashboard?section=transactions'))],
      ['Lister', host ? linkHtml(userName(host), userAdminLink(host)) : ''],
      ['Registrant', registrant ? linkHtml(userName(registrant), userAdminLink(registrant)) : ''],
      ['Tickets', escapeHtml(String(quantity || 1))],
      ['Total charged', escapeHtml(money(amountTotal))],
      ['CoGo commission', escapeHtml(money(platformFee))],
      ['Stripe PaymentIntent', escapeHtml(stripePaymentIntentId || '')],
    ],
    ctaLabel: 'View Transactions',
    ctaLink: link || '/dashboard?section=transactions',
  });
}

module.exports = {
  notifyAdminNewUser,
  notifyAdminHourlyJobCreated,
  notifyAdminJobListingCreated,
  notifyAdminProjectCommission,
  notifyAdminWorkshopListed,
  notifyAdminWorkshopCommission,
};
