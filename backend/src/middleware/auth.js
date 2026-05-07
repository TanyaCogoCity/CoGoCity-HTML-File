const { verifyAccessToken } = require('../lib/auth');
const { prisma } = require('../lib/prisma');
const { fail } = require('../lib/http');

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return fail(res, 401, 'Missing bearer token');

    const decoded = verifyAccessToken(token);
    const user = await prisma.user.findUnique({ where: { id: decoded.sub } });
    if (!user || user.deletedAt || user.status !== 'active') return fail(res, 401, 'Unauthorized user');

    req.user = user;
    next();
  } catch (error) {
    return fail(res, 401, 'Invalid or expired token');
  }
}

function requireRoles(roles = []) {
  return (req, res, next) => {
    if (!req.user) return fail(res, 401, 'Unauthorized');
    if (!roles.includes(req.user.role)) return fail(res, 403, 'Forbidden');
    next();
  };
}

module.exports = { requireAuth, requireRoles };
