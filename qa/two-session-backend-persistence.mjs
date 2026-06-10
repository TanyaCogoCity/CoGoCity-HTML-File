const API_BASE = process.env.API_BASE || 'https://staging.cogocity.com/api';
const RUN_DIRECT_HIRE = process.env.RUN_DIRECT_HIRE !== 'false';
const RUN_PROJECT_SYNC = process.env.RUN_PROJECT_SYNC !== 'false';
const RUN_STRIPE_SCENARIOS = process.env.RUN_STRIPE_SCENARIOS === 'true';
const KEEP_QA_DATA = process.env.KEEP_QA_DATA === 'true';

const credentials = {
  tatyana: {
    email: process.env.TATYANA_EMAIL || 'tanya.lipovich@gmail.com',
    password: process.env.TATYANA_PASSWORD,
  },
  daniel: {
    email: process.env.DANIEL_EMAIL || 'dan.lipovich@gmail.com',
    password: process.env.DANIEL_PASSWORD,
  },
  ilya: {
    email: process.env.ILYA_EMAIL || 'ilya.lipovich@getcider.com',
    password: process.env.ILYA_PASSWORD,
  },
  admin: {
    email: process.env.ADMIN_EMAIL || 'Tanya@cogocity.com',
    password: process.env.ADMIN_PASSWORD,
  },
};

const requiredPasswords = ['tatyana', 'daniel', 'admin'].concat(RUN_DIRECT_HIRE || RUN_STRIPE_SCENARIOS ? ['ilya'] : []);
for (const name of requiredPasswords) {
  if (!credentials[name].password) throw new Error(`Missing ${name.toUpperCase()}_PASSWORD`);
}

const stamp = `QA-PERSIST-${Date.now()}`;
const results = [];
const cleanup = {
  sync: [],
  communityPostIds: [],
  directJobIds: [],
};

function jsonHeaders(extra = {}) {
  return { 'content-type': 'application/json', ...extra };
}

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: jsonHeaders(options.headers || {}),
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
  if (!response.ok) {
    const message = body?.error?.message || body?.message || body?.text || text;
    const details = body?.error?.details ? ` (${body.error.details})` : '';
    throw new Error(`${path} ${response.status}: ${String(message).slice(0, 500)}${details}`);
  }
  return body?.data ?? body;
}

async function login(label, creds) {
  const data = await request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: creds.email, password: creds.password }),
  });
  const token = data.access_token || data.accessToken;
  if (!token) throw new Error(`${label} login returned no access token`);
  return { label, token, user: data.user };
}

function auth(session) {
  return { authorization: `Bearer ${session.token}` };
}

function records(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.records)) return data.records;
  if (Array.isArray(data?.posts)) return data.posts;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.data?.records)) return data.data.records;
  if (Array.isArray(data?.data?.posts)) return data.data.posts;
  return [];
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function includesJson(value, needle) {
  return JSON.stringify(value).toLowerCase().includes(String(needle || '').toLowerCase());
}

async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, status: 'PASS', ms: Date.now() - started, detail: detail || '' });
    console.log(`PASS ${name}${detail ? ` - ${detail}` : ''}`);
  } catch (error) {
    results.push({ name, status: 'FAIL', ms: Date.now() - started, detail: error.message });
    console.log(`FAIL ${name} - ${error.message}`);
  }
}

async function deleteSyncRecord(session, entity, id) {
  if (!entity || !id) return;
  await request(`/sync/${encodeURIComponent(entity)}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: auth(session),
  }).catch(() => null);
}

async function main() {
  console.log(`Two-session backend persistence QA against ${API_BASE}`);
  console.log(`Stamp: ${stamp}`);

  const sessions = {
    tatyanaA: await login('tatyanaA', credentials.tatyana),
    tatyanaFresh: await login('tatyanaFresh', credentials.tatyana),
    danielA: await login('danielA', credentials.daniel),
    danielFresh: await login('danielFresh', credentials.daniel),
    adminA: await login('adminA', credentials.admin),
    adminFresh: await login('adminFresh', credentials.admin),
  };
  if (RUN_DIRECT_HIRE || RUN_STRIPE_SCENARIOS) {
    sessions.ilyaA = await login('ilyaA', credentials.ilya);
    sessions.ilyaFresh = await login('ilyaFresh', credentials.ilya);
  }

  await check('Auth sessions are independent and backend-backed', async () => {
    for (const session of Object.values(sessions)) {
      const me = await request('/auth/me', { headers: auth(session) });
      ensure(me.id === session.user.id, `${session.label} /auth/me mismatch`);
    }
    return `${Object.keys(sessions).length} independent sessions`;
  });

  let communityPostId = '';
  let communityApplicationId = '';
  let projectId = '';
  let imageId = '';
  let directJobId = '';

  await check('Community post persists from Tatyana session to public fresh read', async () => {
    communityPostId = `qa_post_${Date.now()}`;
    cleanup.communityPostIds.push(communityPostId);
    const post = {
      id: communityPostId,
      authorId: sessions.tatyanaA.user.id,
      authorName: sessions.tatyanaA.user.display_name || sessions.tatyanaA.user.displayName || 'Tatyana',
      authorEmoji: 'QA',
      isJob: true,
      content: `${stamp} community job persistence post`,
      jobTitle: `${stamp} Community Job`,
      description: `${stamp} community job description`,
      rate: 11,
      hoursNeeded: 2,
      location: 'Danville, CA',
      status: 'open',
      application_count: 0,
      likes: [],
      comments: [],
      shares: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await request('/sync/posts', {
      method: 'POST',
      headers: auth(sessions.tatyanaA),
      body: JSON.stringify({ records: [post] }),
    });
    const publicPosts = records(await request('/community-posts'));
    ensure(publicPosts.some((item) => item.id === communityPostId), 'public backend feed cannot see created post');
    return communityPostId;
  });

  await check('Community interactions persist from Daniel session to Tatyana fresh session', async () => {
    const commentId = `qa_comment_${Date.now()}`;
    await request(`/community-posts/${communityPostId}/interactions`, {
      method: 'POST',
      headers: auth(sessions.danielA),
      body: JSON.stringify({ action: 'like' }),
    });
    await request(`/community-posts/${communityPostId}/interactions`, {
      method: 'POST',
      headers: auth(sessions.danielA),
      body: JSON.stringify({ action: 'comment', comment: { id: commentId, content: `${stamp} Daniel comment` } }),
    });
    const publicPost = records(await request('/community-posts')).find((item) => item.id === communityPostId);
    ensure(publicPost, 'post missing after interaction reload');
    ensure((publicPost.likes || []).includes(sessions.danielA.user.id), 'like did not persist to backend');
    ensure(includesJson(publicPost.comments || [], commentId), 'comment did not persist to backend');
    return commentId;
  });

  await check('Community application and offer persist across student/poster fresh sessions', async () => {
    communityApplicationId = `qa_app_${Date.now()}`;
    cleanup.sync.push(['applications', communityApplicationId]);
    const app = {
      id: communityApplicationId,
      postId: communityPostId,
      jobTitle: `${stamp} Community Job`,
      employerId: sessions.tatyanaA.user.id,
      employerName: sessions.tatyanaA.user.display_name || sessions.tatyanaA.user.displayName || 'Tatyana',
      studentUserId: sessions.danielA.user.id,
      studentName: sessions.danielA.user.display_name || sessions.danielA.user.displayName || 'Daniel',
      message: `${stamp} Daniel application`,
      rate: 11,
      estimatedHours: 2,
      location: 'Danville, CA',
      source: 'community_feed',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await request('/sync/applications', {
      method: 'POST',
      headers: auth(sessions.danielA),
      body: JSON.stringify({ records: [app] }),
    });
    const posterApps = records(await request('/sync/applications', { headers: auth(sessions.tatyanaFresh) }));
    ensure(posterApps.some((item) => item.id === communityApplicationId), 'poster fresh session cannot see application');
    const posterNotifications = await request('/notifications', { headers: auth(sessions.tatyanaFresh) });
    ensure(includesJson(posterNotifications, `${stamp} Community Job`) || includesJson(posterNotifications, 'applied'), 'poster notification missing');

    const offered = { ...app, status: 'offer_sent', updatedAt: new Date().toISOString() };
    await request('/sync/applications', {
      method: 'POST',
      headers: auth(sessions.tatyanaA),
      body: JSON.stringify({ records: [offered] }),
    });
    const studentApps = records(await request('/sync/applications', { headers: auth(sessions.danielFresh) }));
    const studentApp = studentApps.find((item) => item.id === communityApplicationId);
    ensure(studentApp && String(studentApp.status).toLowerCase() === 'offer_sent', 'student fresh session cannot see offer status');
    const studentNotifications = await request('/notifications', { headers: auth(sessions.danielFresh) });
    ensure(includesJson(studentNotifications, 'offer') && includesJson(studentNotifications, `${stamp} Community Job`), 'student offer notification missing');
    return communityApplicationId;
  });

  await check('Messages persist from Daniel session to Tatyana fresh session', async () => {
    const sent = await request('/messages', {
      method: 'POST',
      headers: auth(sessions.danielA),
      body: JSON.stringify({
        recipientId: sessions.tatyanaA.user.id,
        message: `${stamp} message persistence`,
        label: `${stamp} Message Thread`,
      }),
    });
    ensure(sent.id || sent.message?.id, 'message response did not include an id');
    const threads = records(await request('/messages', { headers: auth(sessions.tatyanaFresh) }));
    ensure(includesJson(threads, `${stamp} message persistence`), 'recipient fresh session cannot see message');
    return sent.id || sent.message?.id;
  });

  await check('Image sync persists uploaded image record to fresh backend read', async () => {
    imageId = `qa_img_${Date.now()}`;
    cleanup.sync.push(['images', imageId]);
    const image = {
      id: imageId,
      url: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMjAiIGhlaWdodD0iNjgiPjxyZWN0IHdpZHRoPSIxMjAiIGhlaWdodD0iNjgiIGZpbGw9IiNmZmQ4MDAiLz48dGV4dCB4PSIxMCIgeT0iMzgiIGZpbGw9IiMxMTEiPkNvR28gUUE8L3RleHQ+PC9zdmc+',
      thumbnail_url: '',
      source: 'qa_persistence',
      entity_type: 'qa',
      entity_id: stamp,
      owner_id: sessions.danielA.user.id,
      createdAt: new Date().toISOString(),
    };
    await request('/sync/images', {
      method: 'POST',
      headers: auth(sessions.danielA),
      body: JSON.stringify({ records: [image] }),
    });
    const publicImages = records(await request(`/sync/images?ids=${encodeURIComponent(imageId)}&full=true&limit=1`));
    ensure(publicImages.some((item) => item.id === imageId || item.record_id === imageId || item.recordId === imageId), 'fresh backend image read missing uploaded image');
    return imageId;
  });

  if (RUN_PROJECT_SYNC) {
    await check('Project and review sync persist across employer/student sessions', async () => {
      projectId = `qa_project_${Date.now()}`;
      cleanup.sync.push(['projects', projectId]);
      const reviewId = `qa_review_${Date.now()}`;
      const project = {
        id: projectId,
        postId: communityPostId,
        applicationId: communityApplicationId,
        title: `${stamp} Community Job`,
        jobTitle: `${stamp} Community Job`,
        employerId: sessions.tatyanaA.user.id,
        employerName: sessions.tatyanaA.user.display_name || sessions.tatyanaA.user.displayName || 'Tatyana',
        studentUserId: sessions.danielA.user.id,
        studentName: sessions.danielA.user.display_name || sessions.danielA.user.displayName || 'Daniel',
        status: 'completed',
        hourlyRate: 11,
        estimatedHours: 2,
        actualHours: 2,
        reviewSubmitted: true,
        reviews: [{
          id: reviewId,
          projectId,
          reviewerId: sessions.tatyanaA.user.id,
          reviewerName: sessions.tatyanaA.user.display_name || sessions.tatyanaA.user.displayName || 'Tatyana',
          studentId: sessions.danielA.user.id,
          rating: 5,
          comment: `${stamp} review persistence`,
          createdAt: new Date().toISOString(),
        }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await request('/sync/projects', {
        method: 'POST',
        headers: auth(sessions.tatyanaA),
        body: JSON.stringify({ records: [project] }),
      });
      const studentProjects = records(await request('/sync/projects', { headers: auth(sessions.danielFresh) }));
      ensure(studentProjects.some((item) => item.id === projectId && includesJson(item, reviewId)), 'student fresh session cannot see project/review');
      return projectId;
    });
  }

  if (RUN_DIRECT_HIRE) {
    await check('Direct Hire application persists from student session to employer/admin fresh session', async () => {
      const title = `${stamp} Direct Hire`;
      const job = await request('/jobs', {
        method: 'POST',
        headers: auth(sessions.adminA),
        body: JSON.stringify({
          title,
          description: `${stamp} direct hire QA job`,
          rate: 21,
          hourlyRate: 21,
          location: 'Danville, CA',
          companyName: 'CoGo QA',
          jobType: 'part_time',
          workMode: 'remote',
          status: 'active',
          postingPackage: 'basic',
          postingFee: 0,
          listingMonths: 1,
        }),
      });
      directJobId = job.id;
      cleanup.directJobIds.push(directJobId);
      const publicJobs = records(await request('/jobs'));
      ensure(publicJobs.some((item) => item.id === directJobId), 'fresh public jobs read cannot see direct job');
      const app = await request(`/jobs/${directJobId}/apply`, {
        method: 'POST',
        headers: auth(sessions.danielA),
        body: JSON.stringify({
          message: `${stamp} direct hire application`,
          resumeFileName: `${stamp}.txt`,
          resumeDataUrl: 'data:text/plain;base64,Q29HbyBRQSByZXN1bWU=',
        }),
      });
      ensure(app.id, 'direct hire application did not return id');
      const adminApps = records(await request('/jobs/applications/me', { headers: auth(sessions.adminFresh) }));
      ensure(adminApps.some((item) => item.id === app.id && includesJson(item, stamp)), 'fresh employer/admin session cannot see direct hire application');
      const adminMessages = records(await request('/messages', { headers: auth(sessions.adminFresh) }));
      ensure(includesJson(adminMessages, `${stamp} direct hire application`), 'direct hire message missing for employer/admin fresh session');
      const adminNotifications = await request('/notifications', { headers: auth(sessions.adminFresh) });
      ensure(includesJson(adminNotifications, title), 'direct hire notification missing for employer/admin fresh session');
      return `${directJobId}/${app.id}`;
    });
  }

  if (RUN_STRIPE_SCENARIOS) {
    await check('Optional Stripe final-hours scenarios are enabled but not implemented in this lightweight suite', async () => {
      return 'Use work/final_staging_qa_20260609.mjs for same/less/more Stripe capture checks';
    });
  }

  await cleanupRecords();

  const failed = results.filter((item) => item.status === 'FAIL');
  console.log('\nTWO_SESSION_BACKEND_PERSISTENCE_SUMMARY');
  console.log(JSON.stringify({
    apiBase: API_BASE,
    stamp,
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    failures: failed,
    keptData: KEEP_QA_DATA,
  }, null, 2));
  if (failed.length) process.exitCode = 1;

  async function cleanupRecords() {
    if (KEEP_QA_DATA) {
      console.log('Cleanup skipped because KEEP_QA_DATA=true');
      return;
    }
    await check('Cleanup removes QA records where backend supports deletion', async () => {
      const removed = [];
      for (const id of cleanup.communityPostIds) {
        await request(`/community-posts/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: auth(sessions.tatyanaA),
        }).catch(() => null);
        removed.push(`community-post:${id}`);
      }
      for (const id of cleanup.directJobIds) {
        await request(`/jobs/admin/hard-delete/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: auth(sessions.adminA),
        }).catch(async () => {
          await request(`/jobs/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers: auth(sessions.adminA),
          }).catch(() => null);
        });
        removed.push(`direct-job:${id}`);
      }
      for (const [entity, id] of cleanup.sync) {
        await deleteSyncRecord(sessions.adminA, entity, id);
        removed.push(`${entity}:${id}`);
      }
      return removed.length ? removed.join(', ') : 'nothing to clean';
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
