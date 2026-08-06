const express = require('express');
const { prisma } = require('../lib/prisma');
const { ok, created, fail } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');
const { writeAuditLog } = require('../lib/audit');
const { normalizeServicePayload, serializeReview, serializeService } = require('../lib/compat');
const { userProfileMetadata } = require('../lib/onboardingGate');
const { normalizeProfileMetadataMedia } = require('../lib/media');
const { maybeSendOnboardingWelcomeEmail } = require('../lib/welcomeEmails');

const router = express.Router();

function publicUserProfile(profile) {
  if (!profile) return null;
  const metadata = normalizeProfileMetadataMedia(userProfileMetadata(profile));
  return {
    id: profile.id,
    userId: profile.userId,
    type: profile.type,
    about: profile.about,
    school: profile.school,
    age: profile.age,
    avatar: profile.avatar,
    metadata: {
      photo: metadata.photo || '',
      profile_images: Array.isArray(metadata.profile_images) ? metadata.profile_images : [],
      video_url: metadata.video_url || '',
      video_type: metadata.video_type || '',
      video_id: metadata.video_id || '',
      business_logo: metadata.business_logo || '',
    },
  };
}

function publicStudentUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    displayName: user.displayName,
    city: user.city,
    role: user.role,
    co_go_verified: Boolean(user.coGoVerified),
    coGoVerified: Boolean(user.coGoVerified),
    verified_at: user.verifiedAt || null,
    verifiedAt: user.verifiedAt || null,
    verified_by: user.verifiedBy || null,
    verifiedBy: user.verifiedBy || null,
    userProfile: publicUserProfile(user.userProfile),
    reviewsReceived: user.reviewsReceived || [],
  };
}

function serializeStudentProfile(profile) {
  const user = publicStudentUser(profile.user);
  const profileRecord = publicUserProfile(profile.user?.userProfile);
  return {
    id: profile.id,
    user_id: profile.userId,
    userId: profile.userId,
    title: profile.title,
    bio: profile.bio,
    experience: profile.experience,
    is_active: profile.isActive,
    created_at: profile.createdAt,
    services: (profile.services || []).map(serializeService),
    reviews: (profile.user?.reviewsReceived || []).map(serializeReview),
    user,
    profile: profileRecord,
  };
}

function syncedProjectStudentId(payload = {}) {
  return String(payload.studentUserId || payload.student_user_id || payload.studentId || payload.student_id || '').trim();
}

function syncedProjectServiceId(payload = {}) {
  return String(payload.studentServiceId || payload.student_service_id || payload.serviceId || payload.service_id || '').trim();
}

function serializeSyncedProjectReview(review = {}, project = {}) {
  return {
    id: review.id || `${project.id || project.recordId || 'project'}:${review.reviewerId || review.reviewer_id || review.reviewerName || review.reviewer_name || 'review'}:${review.createdAt || review.created_at || review.comment || ''}`,
    project_id: project.id || project.recordId || '',
    projectId: project.id || project.recordId || '',
    reviewer_id: review.reviewerId || review.reviewer_id || '',
    reviewerId: review.reviewerId || review.reviewer_id || '',
    reviewer_name: review.reviewerName || review.reviewer_name || '',
    reviewerName: review.reviewerName || review.reviewer_name || '',
    student_id: syncedProjectStudentId(project),
    studentId: syncedProjectStudentId(project),
    service_id: review.serviceId || review.service_id || syncedProjectServiceId(project) || '',
    serviceId: review.serviceId || review.service_id || syncedProjectServiceId(project) || '',
    rating: review.rating,
    comment: review.comment || '',
    created_at: review.createdAt || review.created_at || project.updatedAt || project.updated_at || '',
    createdAt: review.createdAt || review.created_at || project.updatedAt || project.updated_at || '',
  };
}

function reviewKey(review = {}) {
  return [
    review.id || '',
    review.projectId || review.project_id || '',
    review.reviewerId || review.reviewer_id || review.reviewerName || review.reviewer_name || '',
    review.createdAt || review.created_at || '',
    review.comment || '',
  ].map(value => String(value || '').trim().toLowerCase()).join('|');
}

function mergeSyncedProjectReviews(profileRows = [], syncedRows = []) {
  const reviewsByStudentId = new Map();
  for (const row of syncedRows) {
    const project = { ...(row.payload || {}), id: row.recordId, recordId: row.recordId };
    const studentId = syncedProjectStudentId(project);
    const reviews = Array.isArray(project.reviews) ? project.reviews : [];
    if (!studentId || !reviews.length) continue;
    const serialized = reviews.map(review => serializeSyncedProjectReview(review, project)).filter(review => review.reviewerName && review.comment);
    if (!serialized.length) continue;
    reviewsByStudentId.set(studentId, [...(reviewsByStudentId.get(studentId) || []), ...serialized]);
  }

  return profileRows.map((profile) => {
    const serialized = serializeStudentProfile(profile);
    const syncedReviews = reviewsByStudentId.get(profile.userId) || [];
    if (!syncedReviews.length) return serialized;

    const seenProfileReviews = new Set((serialized.reviews || []).map(reviewKey));
    const profileAdditions = syncedReviews.filter(review => !seenProfileReviews.has(reviewKey(review)));
    serialized.reviews = [...(serialized.reviews || []), ...profileAdditions]
      .sort((a, b) => Date.parse(b.createdAt || b.created_at || 0) - Date.parse(a.createdAt || a.created_at || 0));

    serialized.services = (serialized.services || []).map((service, index) => {
      const serviceId = String(service.id || '').trim();
      const serviceReviews = syncedReviews.filter(review => {
        const reviewServiceId = String(review.serviceId || review.service_id || '').trim();
        return reviewServiceId ? reviewServiceId === serviceId : index === 0;
      });
      if (!serviceReviews.length) return service;
      const seenServiceReviews = new Set((service.reviews || []).map(reviewKey));
      const additions = serviceReviews.filter(review => !seenServiceReviews.has(reviewKey(review)));
      const reviews = [...(service.reviews || []), ...additions]
        .sort((a, b) => Date.parse(b.createdAt || b.created_at || 0) - Date.parse(a.createdAt || a.created_at || 0));
      const reviewCount = reviews.length;
      const averageRating = reviewCount ? Number((reviews.reduce((sum, review) => sum + Number(review.rating || 0), 0) / reviewCount).toFixed(2)) : 0;
      return {
        ...service,
        reviews,
        review_count: reviewCount,
        reviewCount,
        average_rating: averageRating,
        averageRating,
      };
    });

    return serialized;
  });
}

router.get('/student-profiles', async (req, res) => {
  const userId = String(req.query.user_id || req.query.userId || '').trim();
  const where = { deletedAt: null, isActive: true };
  if (userId) where.userId = userId;

  const rows = await prisma.studentProfile.findMany({
    where,
    include: {
      services: {
        where: { deletedAt: null, isActive: true },
        orderBy: { createdAt: 'desc' },
        include: { reviews: { include: { reviewer: { select: { id: true, displayName: true } } }, orderBy: { createdAt: 'desc' } } },
      },
      user: { select: { id: true, displayName: true, city: true, role: true, coGoVerified: true, verifiedAt: true, verifiedBy: true, userProfile: true, reviewsReceived: { include: { reviewer: { select: { id: true, displayName: true } } }, orderBy: { createdAt: 'desc' } } } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const studentIds = rows.map(row => row.userId).filter(Boolean);
  const syncedRows = studentIds.length
    ? await prisma.syncRecord.findMany({
        where: { entity: 'projects', deletedAt: null },
        select: { recordId: true, payload: true },
      })
    : [];

  return ok(res, mergeSyncedProjectReviews(rows, syncedRows));
});

router.patch('/user-profile/me', requireAuth, async (req, res) => {
  const payload = req.body || {};
  const profilePayload = payload.profile || payload;
  const businessPayload = payload.businessProfile || profilePayload.businessProfile || {};
  const hasProfileField = (field) => Object.prototype.hasOwnProperty.call(profilePayload, field);
  const hasBusinessField = (field) => Object.prototype.hasOwnProperty.call(businessPayload, field);
  const metadata = {};
  if (hasProfileField('photo')) metadata.photo = profilePayload.photo || '';
  if (hasProfileField('profileImages') || hasProfileField('profile_images')) {
    metadata.profile_images = profilePayload.profileImages || profilePayload.profile_images || [];
  }
  if (hasProfileField('video_url') || hasProfileField('videoUrl')) metadata.video_url = profilePayload.video_url || profilePayload.videoUrl || '';
  if (hasProfileField('video_type') || hasProfileField('videoType')) metadata.video_type = profilePayload.video_type || profilePayload.videoType || '';
  if (hasProfileField('video_id') || hasProfileField('videoId')) metadata.video_id = profilePayload.video_id || profilePayload.videoId || '';
  if (hasProfileField('birthDate') || hasProfileField('birth_date') || hasProfileField('birthday')) {
    const birthDate = profilePayload.birthDate || profilePayload.birth_date || profilePayload.birthday || '';
    metadata.birth_date = birthDate;
    metadata.birthday = birthDate;
  }
  if (hasProfileField('birthYear') || hasProfileField('birth_year')) metadata.birth_year = profilePayload.birthYear || profilePayload.birth_year || '';
  if (hasProfileField('privateEmail') || hasProfileField('private_email')) metadata.private_email = profilePayload.privateEmail || profilePayload.private_email || '';
  if (hasBusinessField('logo') || hasBusinessField('business_logo') || hasProfileField('business_logo')) {
    metadata.business_logo = businessPayload.logo || businessPayload.business_logo || profilePayload.business_logo || '';
  }

  const updated = await prisma.$transaction(async (tx) => {
    const existingProfile = await tx.userProfile.findUnique({ where: { userId: req.user.id } });
    const nextMetadata = normalizeProfileMetadataMedia(Object.assign({}, userProfileMetadata(existingProfile), metadata));
    if (payload.migrationOnboardingCompleted || payload.migration_onboarding_completed) {
      nextMetadata.migration_onboarding_completed_at = new Date().toISOString();
    }
    const userUpdates = {};
    if (payload.firstName !== undefined) userUpdates.firstName = String(payload.firstName || '').trim();
    if (payload.lastName !== undefined) userUpdates.lastName = String(payload.lastName || '').trim();
    if (payload.displayName !== undefined) userUpdates.displayName = String(payload.displayName || '').trim();
    if (payload.phone !== undefined) userUpdates.phone = String(payload.phone || '').trim();
    if (payload.city !== undefined) userUpdates.city = String(payload.city || '').trim();
    if (Object.keys(userUpdates).length) await tx.user.update({ where: { id: req.user.id }, data: userUpdates });

    return tx.userProfile.upsert({
      where: { userId: req.user.id },
      create: {
        userId: req.user.id,
        type: profilePayload.type || null,
        about: profilePayload.about || null,
        address: profilePayload.address || null,
        school: profilePayload.school || null,
        age: profilePayload.age ? Number(profilePayload.age) : null,
        avatar: profilePayload.avatar || null,
        businessName: businessPayload.name || payload.businessName || null,
        businessAbout: businessPayload.about || payload.businessAbout || null,
        businessPhone: businessPayload.phone || payload.businessPhone || null,
        businessAddress: businessPayload.address || payload.businessAddress || null,
        businessCity: businessPayload.city || payload.businessCity || null,
        businessTin: businessPayload.tin || payload.businessTin || payload.tin || null,
        metadata: nextMetadata,
      },
      update: {
        type: profilePayload.type ?? undefined,
        about: profilePayload.about ?? undefined,
        address: profilePayload.address ?? undefined,
        school: profilePayload.school ?? undefined,
        age: profilePayload.age === undefined ? undefined : (profilePayload.age ? Number(profilePayload.age) : null),
        avatar: profilePayload.avatar ?? undefined,
        businessName: businessPayload.name ?? payload.businessName ?? undefined,
        businessAbout: businessPayload.about ?? payload.businessAbout ?? undefined,
        businessPhone: businessPayload.phone ?? payload.businessPhone ?? undefined,
        businessAddress: businessPayload.address ?? payload.businessAddress ?? undefined,
        businessCity: businessPayload.city ?? payload.businessCity ?? undefined,
        businessTin: businessPayload.tin ?? payload.businessTin ?? payload.tin ?? undefined,
        metadata: nextMetadata,
      },
    });
  });

  await writeAuditLog({ userId: req.user.id, action: 'user_profile.update', entityType: 'user_profile', entityId: updated.id, payload: req.body });
  if (payload.migrationOnboardingCompleted || payload.migration_onboarding_completed) {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    await maybeSendOnboardingWelcomeEmail(user);
  }
  return ok(res, updated);
});

router.post('/student-profiles', requireAuth, async (req, res) => {
  if (!['student', 'admin'].includes(req.user.role)) return fail(res, 403, 'Only student/admin can create profiles');

  const payload = req.body || {};
  const profile = await prisma.studentProfile.create({
    data: {
      userId: req.user.id,
      title: String(payload.title || '').trim() || 'Student Service',
      bio: String(payload.bio || payload.about || ''),
      experience: String(payload.experience || payload.highlights || ''),
      isActive: payload.is_active ?? payload.isActive ?? true,
    },
  });

  await writeAuditLog({ userId: req.user.id, action: 'student_profile.create', entityType: 'student_profile', entityId: profile.id, payload: req.body });

  return created(res, {
    id: profile.id,
    user_id: profile.userId,
    title: profile.title,
    bio: profile.bio,
    experience: profile.experience,
    is_active: profile.isActive,
    created_at: profile.createdAt,
  });
});

router.patch('/student-profiles/:id', requireAuth, async (req, res) => {
  const profile = await prisma.studentProfile.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!profile) return fail(res, 404, 'Profile not found');
  if (req.user.role !== 'admin' && profile.userId !== req.user.id) return fail(res, 403, 'Forbidden');

  const payload = req.body || {};
  const updated = await prisma.studentProfile.update({
    where: { id: profile.id },
    data: {
      title: payload.title ?? profile.title,
      bio: payload.bio ?? payload.about ?? profile.bio,
      experience: payload.experience ?? payload.highlights ?? profile.experience,
      isActive: payload.is_active ?? payload.isActive ?? profile.isActive,
    },
  });

  await writeAuditLog({ userId: req.user.id, action: 'student_profile.update', entityType: 'student_profile', entityId: profile.id, payload: req.body });

  const fresh = await prisma.studentProfile.findUnique({
    where: { id: updated.id },
    include: {
      services: {
        where: { deletedAt: null, isActive: true },
        orderBy: { createdAt: 'desc' },
        include: { reviews: { include: { reviewer: { select: { id: true, displayName: true } } }, orderBy: { createdAt: 'desc' } } },
      },
      user: { select: { id: true, displayName: true, city: true, role: true, coGoVerified: true, verifiedAt: true, verifiedBy: true, userProfile: true, reviewsReceived: { include: { reviewer: { select: { id: true, displayName: true } } }, orderBy: { createdAt: 'desc' } } } },
    },
  });

  return ok(res, serializeStudentProfile(fresh));
});

router.post('/student-profiles/:id/services', requireAuth, async (req, res) => {
  try {
    const profile = await prisma.studentProfile.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!profile) return fail(res, 404, 'Profile not found');
    if (req.user.role !== 'admin' && profile.userId !== req.user.id) return fail(res, 403, 'Forbidden');

    const payload = normalizeServicePayload({ ...(req.body || {}), profileId: profile.id });
    if (!payload.title || payload.hourlyRate <= 0) return fail(res, 400, 'title and rate are required');

    const service = await prisma.service.create({
      data: {
        profileId: profile.id,
        title: payload.title,
        description: payload.description,
        hourlyRate: payload.hourlyRate,
        availability: payload.availability,
        location: payload.location,
        isActive: Boolean(payload.isActive),
        metadata: payload.metadata,
      },
    });

    await writeAuditLog({ userId: req.user.id, action: 'service.create', entityType: 'service', entityId: service.id, payload: req.body });
    return created(res, serializeService(service));
  } catch (error) {
    return fail(res, 400, 'Invalid service payload', error.message);
  }
});

router.patch('/services/:id', requireAuth, async (req, res) => {
  try {
    const service = await prisma.service.findFirst({ where: { id: req.params.id, deletedAt: null }, include: { profile: true } });
    if (!service) return fail(res, 404, 'Service not found');
    if (req.user.role !== 'admin' && service.profile.userId !== req.user.id) return fail(res, 403, 'Forbidden');

    const payload = normalizeServicePayload({
      profileId: service.profileId,
      title: service.title,
      description: service.description,
      hourlyRate: service.hourlyRate,
      availability: service.availability,
      location: service.location,
      isActive: service.isActive,
      metadata: service.metadata || {},
      ...(req.body || {}),
    });
    if (!payload.title || payload.hourlyRate <= 0) return fail(res, 400, 'title and rate are required');

    const updated = await prisma.service.update({
      where: { id: service.id },
      data: {
        title: payload.title,
        description: payload.description,
        hourlyRate: payload.hourlyRate,
        availability: payload.availability,
        location: payload.location,
        isActive: Boolean(payload.isActive),
        metadata: payload.metadata,
      },
    });

    await writeAuditLog({ userId: req.user.id, action: 'service.update', entityType: 'service', entityId: service.id, payload: req.body });
    return ok(res, serializeService(updated));
  } catch (error) {
    return fail(res, 400, 'Invalid service update payload', error.message);
  }
});

router.delete('/services/:id', requireAuth, async (req, res) => {
  try {
    const service = await prisma.service.findFirst({ where: { id: req.params.id, deletedAt: null }, include: { profile: true } });
    if (!service) return fail(res, 404, 'Service not found');
    if (req.user.role !== 'admin' && service.profile.userId !== req.user.id) return fail(res, 403, 'Forbidden');

    await prisma.service.update({ where: { id: service.id }, data: { deletedAt: new Date(), isActive: false } });
    await writeAuditLog({ userId: req.user.id, action: 'service.delete', entityType: 'service', entityId: service.id });
    return ok(res, { deleted: true });
  } catch (error) {
    return fail(res, 400, 'Invalid service delete request', error.message);
  }
});

module.exports = router;
