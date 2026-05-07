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

app.use('/api/stripe', stripeRoutes);

app.use(express.json({ limit: '1mb' }));

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api', profileRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/applications', applicationRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api', reviewRoutes);
app.use('/api/workshops', workshopRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/notifications', notificationRoutes);

app.use((err, _req, res, _next) => {
  const msg = err?.message || 'Server error';
  const status = msg.startsWith('CORS') ? 403 : 500;
  res.status(status).json({ ok: false, error: { message: msg } });
});

module.exports = { app };
