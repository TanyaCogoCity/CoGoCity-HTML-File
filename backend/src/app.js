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

const app = express();

app.use(helmet());
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

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'cogocity-backend', environment: config.nodeEnv, time: new Date().toISOString() });
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

app.use(express.json({ limit: '1mb' }));

app.use(['/api/auth', '/auth'], authLimiter, authRoutes);
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

app.use((err, _req, res, _next) => {
  const msg = err?.message || 'Server error';
  const status = msg.startsWith('CORS') ? 403 : 500;
  res.status(status).json({ ok: false, error: { message: msg } });
});

module.exports = { app };
