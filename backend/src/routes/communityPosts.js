const express = require('express');

const { prisma } = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { ok, fail } = require('../lib/http');
const { writeAuditLog } = require('../lib/audit');
const { requirePlatformReady } = require('../lib/onboardingGate');
const { normalizeProfileMetadataMedia } = require('../lib/media');
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
  if (payload.isJob) {
    const status = String(record.status || 'open').trim().toLowerCase();
    payload.status = ['closed', 'completed', 'in_progress', 'project_started'].includes(status) ? 'closed' : 'open';
    payload.application_count = Number(record.application_count || 0) || 0;
  } else {
    delete payload.status;
    delete payload.application_count;
  }
  return payload;
}

function displayNameForUser(user = {}) {
  const direct = String(user.displayName || '').trim();
  if (direct) return direct;
  const first = String(user.firstName || '').trim();
  const last = String(user.lastName || '').trim();
  if (first && last) return `${first} ${last.slice(0, 1).toUpperCase()}.`;
  return first || String(user.email || 'User').split('@')[0] || 'User';
}

function normalizeCommentRecord(comment = {}, fallbackUser = {}) {
  const content = String(comment.content || '').trim();
  if (!content) return null;
  return {
    id: String(comment.id || `pc_${Date.now()}`),
    userId: String(comment.userId || fallbackUser.id || '').trim(),
    userName: String(comment.userName || displayNameForUser(fallbackUser)),
    content,
    createdAt: comment.createdAt ? new Date(comment.createdAt).toISOString() : new Date().toISOString(),
  };
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

function publicAuthorSnapshot(user = {}) {
  if (!user || !user.id) return null;
  const profile = user.userProfile || {};
  const metadata = normalizeProfileMetadataMedia(profile.metadata);
  return {
    id: user.id,
    display_name: displayNameForUser(user),
    role: user.role,
    city: user.city || profile.businessCity || '',
    profile: {
      type: profile.type || (user.role === 'employer' ? 'business' : user.role),
      about: profile.about || '',
      avatar: profile.avatar || '',
      businessName: profile.businessName || '',
      businessAbout: profile.businessAbout || '',
      businessCity: profile.businessCity || '',
      metadata: {
        photo: metadata.photo || '',
        business_logo: metadata.business_logo || '',
      },
    },
  };
}

function countableApplicationStatus(value = '') {
  return !['withdrawn', 'removed', 'deleted'].includes(String(value || '').toLowerCase());
}

function isUuid(value = '') {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function legacyImportedJobFallbackCount(post = {}) {
  if (String(post.legacyImportSource || '') !== 'legacy_wordpress_closed_job_import') return 0;
  return Number(post.application_count || 0) || 0;
}

async function applicationCountsForPosts(postIds = []) {
  const ids = [...new Set(postIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await prisma.syncRecord.findMany({
    where: { entity: 'applications', deletedAt: null },
    select: { payload: true },
  });
  const counts = rows.reduce((map, row) => {
    const payload = row.payload || {};
    const postId = String(payload.postId || payload.post_id || '').trim();
    if (!ids.includes(postId) || !countableApplicationStatus(payload.status || 'pending')) return map;
    map.set(postId, (map.get(postId) || 0) + 1);
    return map;
  }, new Map());
  const projectRows = await prisma.syncRecord.findMany({
    where: { entity: 'projects', deletedAt: null },
    select: { payload: true },
  });
  projectRows.forEach((row) => {
    const payload = row.payload || {};
    const postId = String(payload.postId || payload.post_id || payload.job_id || payload.jobId || '').trim();
    if (!ids.includes(postId)) return;
    const existingApplicationId = String(payload.applicationId || payload.application_id || '').trim();
    if (existingApplicationId) {
      const hasApplication = rows.some((appRow) => {
        const app = appRow.payload || {};
        return String(app.id || app.record_id || '').trim() === existingApplicationId;
      });
      if (hasApplication) return;
    }
    counts.set(postId, (counts.get(postId) || 0) + 1);
  });
  return counts;
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
          include: { userProfile: true },
        })
      : [];
    const activeAuthorIds = new Set(activeAuthors.map((user) => user.id));
    const authorSnapshots = new Map(activeAuthors.map((user) => [user.id, publicAuthorSnapshot(user)]));
    const visibleRows = rows.filter((row) => !row.authorId || activeAuthorIds.has(row.authorId));
    const counts = await applicationCountsForPosts(visibleRows.map((row) => row.id));
    res.json({
      ok: true,
      data: {
        posts: visibleRows.map((row) => {
          const post = serializeCommunityPost(row);
          const author = authorSnapshots.get(row.authorId);
          if (author) post.author_user = author;
          if (post.isJob) post.application_count = counts.has(row.id) ? (counts.get(row.id) || 0) : legacyImportedJobFallbackCount(post);
          return post;
        }),
      },
    });
  } catch (error) {
    return fail(res, 500, 'Could not load community posts', error.message);
  }
});

router.post('/community-posts/:id/interactions', requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const action = String(req.body?.action || '').trim().toLowerCase();
    if (!id) return fail(res, 400, 'Post id is required');
    if (!['like', 'unlike', 'comment', 'share'].includes(action)) {
      return fail(res, 400, 'Interaction action is required');
    }

    const row = await prisma.communityPost.findFirst({ where: { id, deletedAt: null } });
    if (!row) return fail(res, 404, 'Community post not found');

    const payload = normalizePostRecord({ ...(row.payload || {}), id: row.id, authorId: row.authorId });
    const currentUserId = String(req.user.id || '').trim();

    if (action === 'like') {
      payload.likes = [...new Set([...payload.likes, currentUserId].filter(Boolean))];
    }
    if (action === 'unlike') {
      payload.likes = payload.likes.filter((likedId) => likedId !== currentUserId);
    }
    if (action === 'share') {
      payload.shares = Number(payload.shares || 0) + 1;
    }
    if (action === 'comment') {
      const comment = normalizeCommentRecord(req.body?.comment || {}, req.user);
      if (!comment) return fail(res, 400, 'Comment is required');
      const byId = new Map(payload.comments.map((item) => [String(item.id), item]));
      byId.set(String(comment.id), comment);
      payload.comments = Array.from(byId.values());
    }

    payload.updatedAt = new Date().toISOString();
    const updated = await prisma.communityPost.update({
      where: { id: row.id },
      data: { payload },
    });

    return ok(res, { post: serializeCommunityPost(updated) });
  } catch (error) {
    return fail(res, 400, 'Could not save community post interaction', error.message);
  }
});

router.post('/sync/posts', requireAuth, async (req, res) => {
  try {
    const records = Array.isArray(req.body?.records) ? req.body.records : [];
    const includesJobPost = records.some((record) => record && record.isJob);
    if (includesJobPost) {
      const gate = await requirePlatformReady({ prisma, user: req.user, requirePayment: true, requirePaymentStrict: true });
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
        source: 'Community Gigs',
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
