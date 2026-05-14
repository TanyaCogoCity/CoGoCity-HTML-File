const config = require('../config');

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function notificationHtml({ title, body, link }) {
  const safeTitle = escapeHtml(title || 'CoGoCity notification');
  const safeBody = escapeHtml(body || '').replace(/\n/g, '<br>');
  const url = link && /^https?:\/\//i.test(link) ? link : `${config.appUrl}${link || '/dashboard'}`;
  const safeUrl = escapeHtml(url);
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

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
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
  return sendEmail({
    to: { email: user.email, name: user.displayName },
    subject: title || 'CoGoCity notification',
    htmlContent: notificationHtml({ title, body, link }),
    textContent: `${title || 'CoGoCity notification'}\n\n${body || ''}\n\n${config.appUrl}${link || '/dashboard'}`,
  });
}

module.exports = { sendEmail, sendNotificationEmail };
