const { prisma } = require('./prisma');

async function writeAuditLog({ userId = null, action, entityType, entityId = null, payload = null }) {
  try {
    await prisma.auditLog.create({
      data: { userId, action, entityType, entityId, payload },
    });
  } catch (error) {
    console.error('audit_log_failed', error.message);
  }
}

module.exports = { writeAuditLog };
