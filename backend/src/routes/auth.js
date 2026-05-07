const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { ok, created, fail } = require('../lib/http');
const { normalizeRegisterPayload } = require('../lib/compat');
const { hashPassword, comparePassword, signAccessToken, signRefreshToken, hashToken, verifyRefreshToken } = require('../lib/auth');
const { requireAuth } = require('../middleware/auth');
const { writeAuditLog } = require('../lib/audit');

const router = express.Router();

router.post('/register', async (req, res) => {
  try {
    const payload = normalizeRegisterPayload(req.body || {});
    const exists = await prisma.user.findUnique({ where: { email: payload.email } });
    if (exists) return fail(res, 409, 'Email already in use');

    const passwordHash = await hashPassword(payload.password);
    const user = await prisma.user.create({
      data: {
        firstName: payload.firstName,
        lastName: payload.lastName,
        displayName: payload.displayName,
        email: payload.email,
        phone: payload.phone,
        role: payload.role,
        city: payload.city,
        dateOfBirth: payload.dateOfBirth ? new Date(payload.dateOfBirth) : null,
        passwordHash,
      },
    });

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    await writeAuditLog({ userId: user.id, action: 'auth.register', entityType: 'user', entityId: user.id });

    return created(res, {
      user: {
        id: user.id,
        first_name: user.firstName,
        last_name: user.lastName,
        display_name: user.displayName,
        email: user.email,
        role: user.role,
        city: user.city,
      },
      access_token: accessToken,
      refresh_token: refreshToken,
    });
  } catch (error) {
    return fail(res, 400, 'Invalid register payload', error.message);
  }
});

router.post('/login', async (req, res) => {
  try {
    const schema = z.object({ email: z.string().email(), password: z.string().min(1) });
    const payload = schema.parse(req.body || {});

    const user = await prisma.user.findUnique({ where: { email: payload.email.toLowerCase() } });
    if (!user || user.deletedAt || user.status !== 'active') return fail(res, 401, 'Invalid credentials');

    const valid = await comparePassword(payload.password, user.passwordHash);
    if (!valid) return fail(res, 401, 'Invalid credentials');

    await prisma.user.update({ where: { id: user.id }, data: { lastLogin: new Date() } });

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    return ok(res, {
      user: {
        id: user.id,
        first_name: user.firstName,
        last_name: user.lastName,
        display_name: user.displayName,
        email: user.email,
        role: user.role,
        city: user.city,
      },
      access_token: accessToken,
      refresh_token: refreshToken,
    });
  } catch (error) {
    return fail(res, 400, 'Invalid login payload', error.message);
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const token = String(req.body?.refresh_token || '').trim();
    if (!token) return fail(res, 400, 'Missing refresh token');

    const decoded = verifyRefreshToken(token);
    const tokenHash = hashToken(token);

    const dbToken = await prisma.refreshToken.findFirst({
      where: {
        userId: decoded.sub,
        tokenHash,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });

    if (!dbToken) return fail(res, 401, 'Invalid refresh token');

    const user = await prisma.user.findUnique({ where: { id: decoded.sub } });
    if (!user || user.status !== 'active' || user.deletedAt) return fail(res, 401, 'Unauthorized user');

    const accessToken = signAccessToken(user);
    return ok(res, { access_token: accessToken });
  } catch (error) {
    return fail(res, 401, 'Invalid refresh token');
  }
});

router.post('/logout', requireAuth, async (req, res) => {
  const token = String(req.body?.refresh_token || '').trim();
  if (!token) return ok(res, { revoked: false });
  await prisma.refreshToken.updateMany({ where: { userId: req.user.id, tokenHash: hashToken(token), revokedAt: null }, data: { revokedAt: new Date() } });
  return ok(res, { revoked: true });
});

router.get('/me', requireAuth, async (req, res) => {
  const user = req.user;
  return ok(res, {
    id: user.id,
    first_name: user.firstName,
    last_name: user.lastName,
    display_name: user.displayName,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.status,
    city: user.city,
    created_at: user.createdAt,
  });
});

module.exports = router;
