const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const config = require('./config');
const { apiLimiter, authLimiter } = require('./middleware/rateLimit');

const authRoutes = require('./routes/auth');
const profileRoutes = require('./routes/profiles');
const serviceRoutes = require('./routes/services');
const jobRoutes = require('./routes/jobs');
const applicationRoutes = require('./routes/applications');
const projectRoutes = require('./routes/projects');
const stripeRoutes = require('./routes/stripe');
const messageRoutes = require('./routes/messages');
const reviewRoutes = require('./routes/reviews');
const workshopRoutes = require('./routes/workshops');
const transactionRoutes = require('./routes/transactions');
const notificationRoutes = require('./routes/notifications');
const communityPostRoutes = require('./routes/communityPosts');
const syncRecordRoutes = require('./routes/syncRecords');
const seoRoutes = require('./routes/seo');

const app = express();

app.set('trust proxy', 1);

const imageSources = ["'self'", 'data:', 'blob:', 'https:'];
if (config.spacesCdnUrl) imageSources.push(config.spacesCdnUrl.replace(/\/+$/, ''));
if (config.spacesBucket && config.spacesRegion) {
  imageSources.push(`https://${config.spacesBucket}.${config.spacesRegion}.digitaloceanspaces.com`);
}
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        fontSrc: ["'self'", 'https:', 'data:'],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        imgSrc: imageSources,
        mediaSrc: imageSources,
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", 'https:', "'unsafe-inline'"],
        connectSrc: ["'self'", 'https:'],
        frameSrc: [
          "'self'",
          'https://js.stripe.com',
          'https://hooks.stripe.com',
          'https://www.youtube.com',
          'https://www.youtube-nocookie.com',
          'https://player.vimeo.com',
        ],
      },
    },
  })
);
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (config.corsOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS not allowed for origin ${origin}`));
    },
    credentials: true,
  })
);
app.use(morgan('dev'));
app.use(apiLimiter);

function healthPayload() {
  return { ok: true, service: 'cogocity-backend', environment: config.nodeEnv, time: new Date().toISOString() };
}

app.get(['/health', '/api/health'], (_req, res) => {
  res.json(healthPayload());
});

app.get('/health/db', async (_req, res) => {
  const { prisma } = require('./lib/prisma');
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, database: 'connected', time: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({ ok: false, database: 'unavailable', error: error.message });
  }
});

// DigitalOcean public ingress routes /api/* to this service and strips the /api prefix.
// Keep /api mounts for direct/local backend access and add unprefixed mounts for staging ingress.
app.use(['/api/stripe', '/stripe'], stripeRoutes);

app.use(express.json({ limit: '25mb' }));

app.use(['/api/auth', '/auth'], authLimiter, authRoutes);
app.use(['/api', '/'], seoRoutes);
app.use(['/api', '/'], profileRoutes);
app.use(['/api/services', '/services'], serviceRoutes);
app.use(['/api/jobs', '/jobs'], jobRoutes);
app.use(['/api/applications', '/applications'], applicationRoutes);
app.use(['/api/projects', '/projects'], projectRoutes);
app.use(['/api/messages', '/messages'], messageRoutes);
app.use(['/api', '/'], reviewRoutes);
app.use(['/api/workshops', '/workshops'], workshopRoutes);
app.use(['/api/transactions', '/transactions'], transactionRoutes);
app.use(['/api/notifications', '/notifications'], notificationRoutes);
app.use(['/api', '/'], communityPostRoutes);
app.use(['/api/sync', '/sync'], syncRecordRoutes);

app.use((err, _req, res, _next) => {
  const msg = err?.message || 'Server error';
  const status = msg.startsWith('CORS') ? 403 : 500;
  res.status(status).json({ ok: false, error: { message: msg } });
});

module.exports = { app };
