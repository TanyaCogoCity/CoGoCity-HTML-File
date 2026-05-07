const dotenv = require('dotenv');
dotenv.config();

const toList = (value = '') => String(value)
  .split(',')
  .map((part) => part.trim())
  .filter(Boolean);

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4000),
  apiBaseUrl: process.env.API_BASE_URL || 'http://localhost:4000',
  appUrl: process.env.APP_URL || 'https://staging.cogocity.com',
  corsOrigins: toList(process.env.CORS_ORIGIN || 'https://staging.cogocity.com,http://127.0.0.1:8080,http://localhost:8080,file://'),

  databaseUrl: process.env.DATABASE_URL,
  requireDatabase: process.env.REQUIRE_DATABASE === 'true',

  jwtAccessSecret: process.env.JWT_ACCESS_SECRET || 'dev-access-secret',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret',
  jwtAccessTtl: process.env.JWT_ACCESS_TTL || '15m',
  jwtRefreshTtl: process.env.JWT_REFRESH_TTL || '30d',

  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  stripePlatformFeeBps: Number(process.env.STRIPE_PLATFORM_FEE_BPS || 1000),

  strictStatusTransitions: process.env.STRICT_STATUS_TRANSITIONS === 'true',
};
