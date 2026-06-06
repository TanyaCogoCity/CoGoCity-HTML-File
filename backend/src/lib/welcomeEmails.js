const { prisma } = require('./prisma');
const { sendEmail, buildAppLink } = require('./email');

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function firstName(user = {}) {
  return String(user.firstName || user.displayName || user.email || 'there').trim().split(/\s+/)[0] || 'there';
}

function paragraphsHtml(items = []) {
  return items.map((item) => `<p style="margin:0 0 16px">${escapeHtml(item)}</p>`).join('');
}

function bulletListHtml(items = []) {
  return `<ul style="margin:0 0 18px 20px;padding:0">${items.map((item) => `<li style="margin:0 0 8px">${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function sectionHtml(title, body = []) {
  return `
    <h3 style="margin:22px 0 10px;color:#18212f">${escapeHtml(title)}</h3>
    ${Array.isArray(body) ? paragraphsHtml(body) : body}
  `;
}

function welcomeEmailHtml({ title, greetingName, sections = [], closing = [] }) {
  const dashboardUrl = buildAppLink('/dashboard');
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.55;color:#18212f;max-width:680px;margin:0 auto;padding:24px">
      <h2 style="margin:0 0 18px;color:#18212f">${escapeHtml(title)}</h2>
      <p style="margin:0 0 16px">Hi ${escapeHtml(greetingName)},</p>
      ${sections.join('')}
      ${paragraphsHtml(closing)}
      <p style="margin:22px 0 24px">
        <a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;background:#2251ff;color:white;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600">Open Your Dashboard</a>
      </p>
      <p style="font-size:12px;color:#667085;margin-top:28px">You received this because you completed onboarding for CoGo City.</p>
    </div>
  `;
}

function welcomeEmailText({ title, greetingName, parts = [] }) {
  return [title, '', `Hi ${greetingName},`, '', ...parts, '', 'Open your dashboard:', buildAppLink('/dashboard')].join('\n');
}

function studentTemplate(user) {
  const greetingName = firstName(user);
  const title = 'Welcome to CoGo City – Your Journey Starts Here';
  const intro = [
    'Welcome to CoGo City!',
    'We are thrilled to welcome another young entrepreneur, creator, and future leader to our community.',
    'CoGo City was built to help students gain real-world experience, develop valuable skills, earn money, and build confidence long before graduation. Every project you complete, every client you help, and every challenge you overcome becomes part of your story.',
  ];
  const dashboardBullets = [
    'Manage your profile',
    'Track job applications',
    'Monitor project status',
    'Connect with employers and community members',
    'Build your professional reputation',
  ];
  return {
    subject: title,
    htmlContent: welcomeEmailHtml({
      title,
      greetingName,
      sections: [
        paragraphsHtml(intro),
        sectionHtml('Getting Started'),
        sectionHtml('Community Gigs', ['Visit the Community Gigs section to find part-time opportunities, short-term projects, and odd jobs in your local community. You can also showcase your skills and services, share updates about your achievements, and celebrate your growth along the way. We would love to see your success stories and hear about your journey.']),
        sectionHtml('Direct Hire Opportunities', ["If you're looking for internships or longer-term employment opportunities, visit the Direct Hire Jobs section. These positions are offered directly by businesses that are seeking talented students like you. If selected, you will be hired and paid directly by the employer."]),
        sectionHtml('Your Dashboard', [`Your dashboard is your command center. There you can:`]),
        bulletListHtml(dashboardBullets),
      ],
      closing: [
        "Remember, every successful career starts with a first opportunity. We are excited to be part of your journey and can't wait to see what you accomplish.",
        'Welcome to the CoGo City community!',
        'The CoGo City Team',
      ],
    }),
    textContent: welcomeEmailText({
      title,
      greetingName,
      parts: [
        ...intro,
        '',
        'Getting Started',
        '',
        'Community Gigs',
        'Visit the Community Gigs section to find part-time opportunities, short-term projects, and odd jobs in your local community. You can also showcase your skills and services, share updates about your achievements, and celebrate your growth along the way. We would love to see your success stories and hear about your journey.',
        '',
        'Direct Hire Opportunities',
        "If you're looking for internships or longer-term employment opportunities, visit the Direct Hire Jobs section. These positions are offered directly by businesses that are seeking talented students like you. If selected, you will be hired and paid directly by the employer.",
        '',
        'Your Dashboard',
        ...dashboardBullets.map((item) => `- ${item}`),
        '',
        "Remember, every successful career starts with a first opportunity. We are excited to be part of your journey and can't wait to see what you accomplish.",
        'Welcome to the CoGo City community!',
        'The CoGo City Team',
      ],
    }),
  };
}

function neighborTemplate(user) {
  const greetingName = firstName(user);
  const title = 'Welcome to CoGo City – Thank You for Supporting Local Students';
  const dashboardBullets = [
    'Manage job postings',
    'Connect with students',
    'Review applications',
    'Track project progress',
    'Leave reviews and feedback',
  ];
  return {
    subject: title,
    htmlContent: welcomeEmailHtml({
      title,
      greetingName,
      sections: [
        paragraphsHtml([
          'Welcome to CoGo City!',
          'Thank you for joining our community and for supporting the next generation of leaders, workers, and entrepreneurs.',
          "Every opportunity you provide helps a student gain confidence, develop practical skills, earn income, and build meaningful connections within their community. Whether it's babysitting, tutoring, pet sitting, yard work, event assistance, technology help, or support for seniors, each experience becomes an important stepping stone in a student's personal and professional growth.",
          'Your participation has a real impact.',
        ]),
        sectionHtml('How to Get Started'),
        sectionHtml('Post a Community Gig', ["Create a job post in the Community Feed and tell us what help you need. We'll do our best to connect you with talented, motivated students in your area."]),
        sectionHtml('Manage Everything in Your Dashboard', ['Your dashboard allows you to:']),
        bulletListHtml(dashboardBullets),
      ],
      closing: [
        "Together, we're creating opportunities that help students learn valuable life skills while strengthening our local communities.",
        'Thank you for being part of the CoGo City mission.',
        'The CoGo City Team',
      ],
    }),
    textContent: welcomeEmailText({
      title,
      greetingName,
      parts: [
        'Welcome to CoGo City!',
        'Thank you for joining our community and for supporting the next generation of leaders, workers, and entrepreneurs.',
        "Every opportunity you provide helps a student gain confidence, develop practical skills, earn income, and build meaningful connections within their community. Whether it's babysitting, tutoring, pet sitting, yard work, event assistance, technology help, or support for seniors, each experience becomes an important stepping stone in a student's personal and professional growth.",
        'Your participation has a real impact.',
        '',
        'How to Get Started',
        '',
        'Post a Community Gig',
        "Create a job post in the Community Feed and tell us what help you need. We'll do our best to connect you with talented, motivated students in your area.",
        '',
        'Manage Everything in Your Dashboard',
        ...dashboardBullets.map((item) => `- ${item}`),
        '',
        "Together, we're creating opportunities that help students learn valuable life skills while strengthening our local communities.",
        'Thank you for being part of the CoGo City mission.',
        'The CoGo City Team',
      ],
    }),
  };
}

function employerTemplate(user) {
  const greetingName = firstName(user);
  const title = 'Welcome to CoGo City – Build Your Team, Inspire the Future';
  const dashboardBullets = [
    'Manage job postings',
    'Review applications',
    'Connect with students',
    'Monitor hiring progress',
    'Manage ongoing projects',
  ];
  return {
    subject: title,
    htmlContent: welcomeEmailHtml({
      title,
      greetingName,
      sections: [
        paragraphsHtml([
          'Welcome to CoGo City!',
          'Thank you for joining a growing community of businesses that believe in investing in the next generation.',
          'By offering students meaningful opportunities, you are helping them gain real-world experience, develop professional skills, and take their first steps toward a successful career. At the same time, you gain access to motivated, energetic, and talented young people who are eager to learn and contribute.',
          "We have an amazing network of students, and we can't wait to help you find the right fit for your team.",
        ]),
        sectionHtml('How to Get Started'),
        sectionHtml('Post a Job', ['You can create opportunities for students in two ways:']),
        sectionHtml('Community Gigs', ['If you have a short-term project, one-time task, seasonal work, or community-based opportunity, create a job in the Community Feed. This is a great option for flexible projects and gigs.']),
        sectionHtml('Direct Hire Jobs', ['If you are looking to hire a student directly for an internship, part-time position, or longer-term employment opportunity, create a job in the Direct Hire section. Students hired through Direct Hire positions are employed and paid directly by your business.']),
        paragraphsHtml(["Whether you need administrative support, marketing assistance, event help, customer service support, technology skills, or an intern, we'll do our best to connect you with qualified candidates."]),
        sectionHtml('Use Your Dashboard', ['Your dashboard allows you to:']),
        bulletListHtml(dashboardBullets),
      ],
      closing: [
        "Every opportunity you create helps shape a student's future while helping your business grow.",
        'Thank you for supporting the next generation of talent.',
        'The CoGo City Team',
      ],
    }),
    textContent: welcomeEmailText({
      title,
      greetingName,
      parts: [
        'Welcome to CoGo City!',
        'Thank you for joining a growing community of businesses that believe in investing in the next generation.',
        'By offering students meaningful opportunities, you are helping them gain real-world experience, develop professional skills, and take their first steps toward a successful career. At the same time, you gain access to motivated, energetic, and talented young people who are eager to learn and contribute.',
        "We have an amazing network of students, and we can't wait to help you find the right fit for your team.",
        '',
        'How to Get Started',
        '',
        'Post a Job',
        'You can create opportunities for students in two ways:',
        '',
        'Community Gigs',
        'If you have a short-term project, one-time task, seasonal work, or community-based opportunity, create a job in the Community Feed. This is a great option for flexible projects and gigs.',
        '',
        'Direct Hire Jobs',
        'If you are looking to hire a student directly for an internship, part-time position, or longer-term employment opportunity, create a job in the Direct Hire section. Students hired through Direct Hire positions are employed and paid directly by your business.',
        '',
        "Whether you need administrative support, marketing assistance, event help, customer service support, technology skills, or an intern, we'll do our best to connect you with qualified candidates.",
        '',
        'Use Your Dashboard',
        ...dashboardBullets.map((item) => `- ${item}`),
        '',
        "Every opportunity you create helps shape a student's future while helping your business grow.",
        'Thank you for supporting the next generation of talent.',
        'The CoGo City Team',
      ],
    }),
  };
}

function templateForUser(user = {}) {
  const role = String(user.role || '').toLowerCase();
  if (role === 'student') return studentTemplate(user);
  if (role === 'neighbor') return neighborTemplate(user);
  if (role === 'employer') return employerTemplate(user);
  return null;
}

async function maybeSendOnboardingWelcomeEmail(user = {}) {
  if (!user?.id || !user.email) return { skipped: true, reason: 'missing_user_or_email' };
  if (user.deletedAt || user.status === 'suspended') return { skipped: true, reason: 'inactive_user' };

  const template = templateForUser(user);
  if (!template) return { skipped: true, reason: 'unsupported_role' };

  const recordId = String(user.id);
  const now = new Date().toISOString();
  try {
    await prisma.syncRecord.create({
      data: {
        entity: 'onboarding_welcome_email',
        recordId,
        payload: {
          status: 'pending',
          user_id: recordId,
          email: user.email,
          role: user.role,
          subject: template.subject,
          created_at: now,
        },
      },
    });
  } catch (error) {
    if (error?.code === 'P2002') return { skipped: true, reason: 'already_sent_or_pending' };
    throw error;
  }

  try {
    const email = await sendEmail({
      to: { email: user.email, name: user.displayName || `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email },
      subject: template.subject,
      htmlContent: template.htmlContent,
      textContent: template.textContent,
    });
    await prisma.syncRecord.update({
      where: { entity_recordId: { entity: 'onboarding_welcome_email', recordId } },
      data: {
        payload: {
          status: email?.skipped ? 'skipped' : 'sent',
          user_id: recordId,
          email: user.email,
          role: user.role,
          subject: template.subject,
          result: email || null,
          sent_at: new Date().toISOString(),
        },
      },
    });
    return email?.skipped ? { skipped: true, reason: email.reason || 'email_skipped' } : { sent: true };
  } catch (error) {
    await prisma.syncRecord.update({
      where: { entity_recordId: { entity: 'onboarding_welcome_email', recordId } },
      data: {
        payload: {
          status: 'failed',
          user_id: recordId,
          email: user.email,
          role: user.role,
          subject: template.subject,
          error: error.message,
          failed_at: new Date().toISOString(),
        },
      },
    }).catch(() => {});
    console.error('onboarding_welcome_email_failed', error.message);
    return { skipped: true, reason: 'send_failed' };
  }
}

module.exports = { maybeSendOnboardingWelcomeEmail };
