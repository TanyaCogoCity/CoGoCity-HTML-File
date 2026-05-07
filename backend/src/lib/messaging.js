const { prisma } = require('./prisma');

async function ensureConversationBetweenUsers({ userAId, userBId, projectId = null, label = null }) {
  if (projectId) {
    const existing = await prisma.conversation.findFirst({ where: { projectId } });
    if (existing) return existing;
  } else {
    const existing = await prisma.conversation.findFirst({
      where: {
        projectId: null,
        AND: [
          { participants: { some: { userId: userAId } } },
          { participants: { some: { userId: userBId } } },
        ],
      },
      include: { participants: true },
    });
    if (existing && existing.participants.length === 2) return existing;
  }

  const conversation = await prisma.conversation.create({
    data: {
      projectId,
      label,
      participants: {
        create: [
          { userId: userAId, lastReadAt: new Date() },
          { userId: userBId, lastReadAt: null },
        ],
      },
    },
  });

  return conversation;
}

async function sendSystemMessage({ conversationId, senderId, text }) {
  return prisma.message.create({
    data: {
      conversationId,
      senderId,
      messageText: text,
      messageType: 'system',
    },
  });
}

module.exports = { ensureConversationBetweenUsers, sendSystemMessage };
