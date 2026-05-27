const { app } = require('./app');
const config = require('./config');
const { prisma } = require('./lib/prisma');
const { startDirectJobExpirationReminderSchedule } = require('./lib/jobExpirationNotifications');

async function start() {
  try {
    if (config.requireDatabase) {
      await prisma.$connect();
      console.log('Database connection verified.');
    } else {
      prisma.$connect()
        .then(() => console.log('Database connection verified.'))
        .catch((error) => console.warn('Database connection not ready; API will still serve health checks.', error.message));
    }

    app.listen(config.port, () => {
      console.log(`CoGo backend running on port ${config.port}`);
      startDirectJobExpirationReminderSchedule();
    });
  } catch (error) {
    console.error('Failed to start server', error);
    process.exit(1);
  }
}

start();
