const { prisma } = require('./prisma');
const { hashPassword } = require('./auth');

const SYSTEM_EMAIL = 'cogo.team@system.local';

async function getOrCreateSystemUser() {
  const existing = await prisma.user.findUnique({ where: { email: SYSTEM_EMAIL } });
  if (existing) return existing;

  const passwordHash = await hashPassword('system-user-not-for-login');
  return prisma.user.create({
    data: {
      firstName: 'CoGo',
      lastName: 'Team',
      displayName: 'CoGo Team',
      email: SYSTEM_EMAIL,
      role: 'admin',
      status: 'active',
      passwordHash,
      city: 'System',
    },
  });
}

module.exports = { getOrCreateSystemUser };
