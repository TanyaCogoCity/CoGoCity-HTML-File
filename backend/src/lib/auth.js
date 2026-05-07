const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../config');

function signAccessToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, email: user.email }, config.jwtAccessSecret, { expiresIn: config.jwtAccessTtl });
}

function signRefreshToken(user) {
  return jwt.sign({ sub: user.id, typ: 'refresh' }, config.jwtRefreshSecret, { expiresIn: config.jwtRefreshTtl });
}

function verifyAccessToken(token) {
  return jwt.verify(token, config.jwtAccessSecret);
}

function verifyRefreshToken(token) {
  return jwt.verify(token, config.jwtRefreshSecret);
}

async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  hashPassword,
  comparePassword,
  hashToken,
};
