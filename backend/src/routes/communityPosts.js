const express = require('express');

const { prisma } = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { fail } = require('../lib/http');

const router = express.Router();

function normalizePostRecord(record = {}) {
  const id = String(record.id || '').trim();
  if (!id) return null;
  const createdAt = record.createdAt ? new Date(record.createdAt) : new Date();
  const payload = {
    ...record,
    id,
    authorId: String(record.authorId || ''),
    authorName: String(record.authorName || 'Community Member'),
    content: String(record.content || ''),
    isJob: !!record.isJob,
    createdAt: Number.isNaN(createdAt.getTime()) ? new Date().toISOString() : createdAt.toISOString(),
    updatedAt: new Date().toISOString(),
    likes: Array.isArray(record.likes) ? record.likes : [],
    comments: Array.isArray(record.comments) ? record.comments : [],
    shares: Number(record.shares || 0),
  };
  return payload;
}

function serializeCommunityPost(row) {
  return {
    ...(row.payload || {}),
    id: row.id,
    authorId: row.payload?.authorId || row.authorId || '',
    createdAt: row.payload?.createdAt || row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.get('/community-posts', async (_req, res) => {
  try {
    const rows = await prisma.communityPost.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 250,
    });
    res.json({ ok: true, data: { posts: rows.map(serializeCommunityPost) } });
  } catch (error) {
    return fail(res, 500, 'Could not load community posts', error.message);
  }
});

router.post('/sync/posts', requireAuth, async (req, res) => {
  try {
    const records = Array.isArray(req.body?.records) ? req.body.records : [];
    const normalized = records.map(normalizePostRecord).filter(Boolean).slice(0, 250);
    await prisma.$transaction(normalized.map((post) => prisma.communityPost.upsert({
      where: { id: post.id },
      create: {
        id: post.id,
        authorId: post.authorId || req.user.id,
        payload: post,
        createdAt: new Date(post.createdAt),
      },
      update: {
        authorId: post.authorId || req.user.id,
        payload: post,
        deletedAt: null,
      },
    })));
    res.json({ ok: true, data: { count: normalized.length } });
  } catch (error) {
    return fail(res, 400, 'Could not sync community posts', error.message);
  }
});

module.exports = router;
