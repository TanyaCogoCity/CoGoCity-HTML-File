const express = require('express');
const { prisma } = require('../lib/prisma');
const { ok, created, fail } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');
const { writeAuditLog } = require('../lib/audit');
const { normalizeServicePayload, serializeReview, serializeService } = require('../lib/compat');
const { userProfileMetadata } = require('../lib/onboardingGate');
const { maybeSendOnboardingWelcomeEmail } = require('../lib/welcomeEmails');

const router = express.Router();

function publicUserProfile(profile) {
  if (!profile) return null;
  const metadata = userProfileMetadata(profile);
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
      user: { select: { id: true, displayName: true, city: true, role: true, userProfile: true, reviewsReceived: { include: { reviewer: { select: { id: true, displayName: true } } }, orderBy: { createdAt: 'desc' } } } },
    },
    orderBy: { createdAt: 'desc' },
  });

  return ok(res, rows.map(serializeStudentProfile));
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
    const nextMetadata = Object.assign({}, userProfileMetadata(existingProfile), metadata);
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
      user: { select: { id: true, displayName: true, city: true, role: true, userProfile: true, reviewsReceived: { include: { reviewer: { select: { id: true, displayName: true } } }, orderBy: { createdAt: 'desc' } } } },
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
