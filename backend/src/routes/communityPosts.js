const express = require('express');

const { prisma } = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { ok, fail } = require('../lib/http');
const { writeAuditLog } = require('../lib/audit');
const { requirePlatformReady } = require('../lib/onboardingGate');
const { notifyAdminHourlyJobCreated } = require('../lib/adminEmails');

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

function countableApplicationStatus(value = '') {
  return ['pending', 'applied', 'offer_sent', 'offer_pending'].includes(String(value || '').toLowerCase());
}

function isUuid(value = '') {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

async function applicationCountsForPosts(postIds = []) {
  const ids = [...new Set(postIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await prisma.syncRecord.findMany({
    where: { entity: 'applications', deletedAt: null },
    select: { payload: true },
  });
  return rows.reduce((map, row) => {
    const payload = row.payload || {};
    const postId = String(payload.postId || payload.post_id || '').trim();
    if (!ids.includes(postId) || !countableApplicationStatus(payload.status || 'pending')) return map;
    map.set(postId, (map.get(postId) || 0) + 1);
    return map;
  }, new Map());
}

router.get('/community-posts', async (_req, res) => {
  try {
    const rows = await prisma.communityPost.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 250,
    });
    const authorIds = [...new Set(rows.map((row) => row.authorId).filter(isUuid))];
    const activeAuthors = authorIds.length
      ? await prisma.user.findMany({
          where: { id: { in: authorIds }, deletedAt: null, status: 'active' },
          select: { id: true },
        })
      : [];
    const activeAuthorIds = new Set(activeAuthors.map((user) => user.id));
    const visibleRows = rows.filter((row) => !row.authorId || activeAuthorIds.has(row.authorId));
    const counts = await applicationCountsForPosts(visibleRows.map((row) => row.id));
    res.json({
      ok: true,
      data: {
        posts: visibleRows.map((row) => {
          const post = serializeCommunityPost(row);
          if (post.isJob) post.application_count = counts.get(row.id) || 0;
          return post;
        }),
      },
    });
  } catch (error) {
    return fail(res, 500, 'Could not load community posts', error.message);
  }
});

router.post('/sync/posts', requireAuth, async (req, res) => {
  try {
    const records = Array.isArray(req.body?.records) ? req.body.records : [];
    const includesJobPost = records.some((record) => record && record.isJob);
    if (includesJobPost) {
      const gate = await requirePlatformReady({ prisma, user: req.user, requirePayment: true });
      if (!gate.ok) return fail(res, gate.status, gate.message, gate.requirements);
    }
    const canCreateJobs = ['employer', 'neighbor', 'admin'].includes(req.user.role);
    const normalized = records
      .map(normalizePostRecord)
      .filter(Boolean)
      .filter((post) => req.user.role === 'admin' || !post.authorId || post.authorId === req.user.id)
      .map((post) => {
        const authorId = post.authorId || req.user.id;
        const safePost = { ...post, authorId };
        if (!canCreateJobs) {
          safePost.isJob = false;
          delete safePost.jobTitle;
          delete safePost.description;
          delete safePost.rate;
          delete safePost.hoursNeeded;
          delete safePost.location;
          delete safePost.status;
          delete safePost.application_count;
        }
        return safePost;
      })
      .slice(0, 250);
    const existingRows = normalized.length
      ? await prisma.communityPost.findMany({
          where: { id: { in: normalized.map((post) => post.id) } },
          select: { id: true },
        })
      : [];
    const existingIds = new Set(existingRows.map((row) => row.id));
    await prisma.$transaction(normalized.map((post) => prisma.communityPost.upsert({
      where: { id: post.id },
      create: {
        id: post.id,
        authorId: post.authorId,
        payload: post,
        createdAt: new Date(post.createdAt),
      },
      update: {
        authorId: post.authorId,
        payload: post,
        deletedAt: null,
      },
    })));
    await Promise.all(normalized
      .filter((post) => post.isJob && !existingIds.has(post.id))
      .map((post) => notifyAdminHourlyJobCreated({
        lister: req.user,
        title: post.jobTitle || post.content || 'Community job opportunity',
        source: 'Community feed',
        amount: Number(post.rate || 0) * Number(post.hoursNeeded || 0),
        link: `/community/post/${post.id}`,
      })));
    res.json({ ok: true, data: { count: normalized.length } });
  } catch (error) {
    return fail(res, 400, 'Could not sync community posts', error.message);
  }
});

router.delete('/community-posts/:id', requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return fail(res, 400, 'Post id is required');

    const post = await prisma.communityPost.findFirst({ where: { id, deletedAt: null } });
    if (!post) return fail(res, 404, 'Community post not found');
    if (req.user.role !== 'admin' && post.authorId !== req.user.id) return fail(res, 403, 'Forbidden');

    await prisma.communityPost.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    await writeAuditLog({
      userId: req.user.id,
      action: 'community_post.delete',
      entityType: 'community_post',
      entityId: id,
      payload: { authorId: post.authorId },
    });

    return ok(res, { id, deleted: true });
  } catch (error) {
    return fail(res, 400, 'Could not delete community post', error.message);
  }
});

module.exports = router;
