const config = require('../config');

const PRODUCTION_APP_URL = 'https://cogocity.com';

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function appBaseUrl() {
  const raw = String(config.appUrl || 'https://staging.cogocity.com').replace(/\/api\/?$/, '').replace(/\/$/, '');
  if (/\.ondigitalocean\.app$/i.test(raw) && config.nodeEnv === 'production' && !/staging\.cogocity\.com$/i.test(raw)) {
    return PRODUCTION_APP_URL;
  }
  return raw;
}

function toHashRoute(path = '/dashboard') {
  const value = String(path || '/dashboard').trim() || '/dashboard';
  if (value.startsWith('#/')) return value;
  if (value.startsWith('/#/')) return value.slice(1);
  if (value.startsWith('#')) return `#/${value.slice(1).replace(/^\/+/, '')}`;
  const normalized = value.startsWith('/') ? value : `/${value}`;
  return `#${normalized}`;
}

function buildAppLink(link = '/dashboard') {
  const base = appBaseUrl();
  const fallback = `${base}/#/dashboard`;
  if (!link) return fallback;

  try {
    if (/^https?:\/\//i.test(link)) {
      const parsed = new URL(link);
      const route = parsed.hash || toHashRoute(`${parsed.pathname || '/dashboard'}${parsed.search || ''}`);
      return `${base}/${route}`;
    }
  } catch (_) {
    return fallback;
  }

  return `${base}/${toHashRoute(link)}`;
}

function notificationHtml({ title, body, link }) {
  const safeTitle = escapeHtml(title || 'CoGoCity notification');
  const safeBody = escapeHtml(body || '').replace(/\n/g, '<br>');
  const safeUrl = escapeHtml(buildAppLink(link));
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#18212f;max-width:600px;margin:0 auto;padding:24px">
      <h2 style="margin:0 0 12px;color:#18212f">${safeTitle}</h2>
      <p style="margin:0 0 20px">${safeBody}</p>
      <p style="margin:0 0 24px">
        <a href="${safeUrl}" style="display:inline-block;background:#2251ff;color:white;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600">Open CoGoCity</a>
      </p>
      <p style="font-size:12px;color:#667085;margin-top:28px">You received this because you have a CoGoCity account.</p>
    </div>
  `;
}

async function sendEmail({ to, subject, htmlContent, textContent }) {
  if (!config.brevoApiKey || !config.emailNotificationsEnabled) return { skipped: true, reason: 'email_not_configured' };
  if (!to?.email) return { skipped: true, reason: 'missing_recipient' };

  const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
    ? AbortSignal.timeout(15000)
    : undefined;

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    signal,
    headers: {
      accept: 'application/json',
      'api-key': config.brevoApiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender: { email: config.emailFrom, name: config.emailFromName },
      to: [{ email: to.email, name: to.name || undefined }],
      subject,
      htmlContent,
      textContent,
    }),
  });

  if (!response.ok) {
    throw new Error(`Brevo send failed (${response.status})`);
  }

  return response.json().catch(() => ({ ok: true }));
}

async function sendNotificationEmail({ user, title, body, link }) {
  const appLink = buildAppLink(link);
  return sendEmail({
    to: { email: user.email, name: user.displayName },
    subject: title || 'CoGoCity notification',
    htmlContent: notificationHtml({ title, body, link }),
    textContent: `${title || 'CoGoCity notification'}\n\n${body || ''}\n\n${appLink}`,
  });
}

module.exports = { sendEmail, sendNotificationEmail, buildAppLink };
