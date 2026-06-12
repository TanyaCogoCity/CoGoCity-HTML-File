const dotenv = require('dotenv');
dotenv.config();

const toList = (value = '') => String(value)
  .split(',')
  .map((part) => part.trim())
  .filter(Boolean);

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4000),
  apiBaseUrl: process.env.API_BASE_URL || process.env.APP_URL || 'https://staging.cogocity.com',
  appUrl: process.env.APP_URL || 'https://staging.cogocity.com',
  corsOrigins: toList(process.env.CORS_ORIGIN || 'https://staging.cogocity.com'),

  databaseUrl: process.env.DATABASE_URL,
  requireDatabase: process.env.REQUIRE_DATABASE === 'true',

  jwtAccessSecret: process.env.JWT_ACCESS_SECRET || 'dev-access-secret',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret',
  deletedEmailHashSecret: process.env.DELETED_EMAIL_HASH_SECRET || process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret',
  jwtAccessTtl: process.env.JWT_ACCESS_TTL || '15m',
  jwtRefreshTtl: process.env.JWT_REFRESH_TTL || '30d',

  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  stripePlatformFeeBps: Number(process.env.STRIPE_PLATFORM_FEE_BPS || 1000),

  brevoApiKey: process.env.BREVO_API_KEY || '',
  emailFrom: process.env.EMAIL_FROM || process.env.EMAIL_FROM_ADDRESS || 'support@cogocity.com',
  emailFromName: process.env.EMAIL_FROM_NAME || 'CoGoCity',
  emailNotificationsEnabled: process.env.EMAIL_NOTIFICATIONS_ENABLED === 'true',

  strictStatusTransitions: process.env.STRICT_STATUS_TRANSITIONS === 'true',

  spacesKey: process.env.DO_SPACES_KEY || '',
  spacesSecret: process.env.DO_SPACES_SECRET || '',
  spacesBucket: process.env.DO_SPACES_BUCKET || '',
  spacesRegion: process.env.DO_SPACES_REGION || 'sfo3',
  spacesEndpoint: process.env.DO_SPACES_ENDPOINT || '',
  spacesCdnUrl: process.env.DO_SPACES_CDN_URL || '',
};
