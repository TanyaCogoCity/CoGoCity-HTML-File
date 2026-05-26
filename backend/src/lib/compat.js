const { z } = require('zod');

const userRoles = ['student', 'employer', 'neighbor', 'admin'];
const legacyProjectStatuses = ['accepted', 'funded', 'in_progress', 'awaiting_approval', 'completed', 'canceled', 'applied', 'offered', 'rejected'];

const registerSchema = z.object({
  first_name: z.string().min(1).optional(),
  last_name: z.string().min(1).optional(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  display_name: z.string().optional(),
  displayName: z.string().optional(),
  email: z.string().email(),
  phone: z.string().optional(),
  password: z.string().min(8),
  role: z.enum(userRoles),
  date_of_birth: z.string().optional(),
  dateOfBirth: z.string().optional(),
  city: z.string().optional(),
});

function normalizeRegisterPayload(payload = {}) {
  const parsed = registerSchema.parse(payload);
  const firstName = parsed.firstName || parsed.first_name || '';
  const lastName = parsed.lastName || parsed.last_name || '';
  const displayName = parsed.displayName || parsed.display_name || `${firstName} ${lastName ? `${lastName.slice(0, 1)}.` : ''}`.trim();
  return {
    firstName,
    lastName,
    displayName,
    email: parsed.email.toLowerCase(),
    phone: parsed.phone || null,
    role: parsed.role,
    dateOfBirth: parsed.dateOfBirth || parsed.date_of_birth || null,
    city: parsed.city || null,
    password: parsed.password,
  };
}

function normalizeServicePayload(payload = {}) {
  const images = Array.isArray(payload.images) ? payload.images : Array.isArray(payload.entity_images) ? payload.entity_images : [];
  const videoUrl = payload.video_url || payload.videoUrl || null;
  return {
    profileId: payload.profile_id || payload.profileId,
    title: payload.title,
    description: payload.description || '',
    hourlyRate: Number(payload.hourly_rate ?? payload.rate ?? payload.hourlyRate ?? 0),
    availability: payload.availability || '',
    location: payload.location || '',
    isActive: payload.is_active ?? payload.isActive ?? true,
    images,
    entityImages: images,
    videoUrl,
    metadata: Object.assign({}, payload.metadata || {}, {
      images,
      entity_images: images,
      video_url: videoUrl || '',
      video_type: payload.video_type || payload.videoType || '',
      video_id: payload.video_id || payload.videoId || '',
    }),
  };
}

function serializeService(service) {
  const reviews = (service.reviews || []).map(serializeReview);
  const reviewCount = reviews.length;
  const averageRating = reviewCount ? Number((reviews.reduce((sum, review) => sum + Number(review.rating || 0), 0) / reviewCount).toFixed(2)) : 0;
  return {
    id: service.id,
    profile_id: service.profileId,
    profileId: service.profileId,
    title: service.title,
    description: service.description,
    hourly_rate: Number(service.hourlyRate),
    hourlyRate: Number(service.hourlyRate),
    rate: Number(service.hourlyRate),
    availability: service.availability,
    location: service.location,
    images: service.metadata?.images || service.metadata?.entity_images || [],
    entity_images: service.metadata?.entity_images || service.metadata?.images || [],
    video_url: service.metadata?.video_url || '',
    video_type: service.metadata?.video_type || '',
    video_id: service.metadata?.video_id || '',
    is_active: service.isActive,
    isActive: service.isActive,
    reviews,
    review_count: reviewCount,
    reviewCount,
    average_rating: averageRating,
    averageRating,
    created_at: service.createdAt,
    createdAt: service.createdAt,
  };
}

function serializeReview(review) {
  const reviewer = review.reviewer || {};
  return {
    id: review.id,
    project_id: review.projectId,
    projectId: review.projectId,
    reviewer_id: review.reviewerId,
    reviewerId: review.reviewerId,
    reviewer_name: reviewer.displayName || review.reviewerName || '',
    reviewerName: reviewer.displayName || review.reviewerName || '',
    student_id: review.studentId,
    studentId: review.studentId,
    service_id: review.serviceId,
    serviceId: review.serviceId,
    rating: review.rating,
    comment: review.comment || '',
    created_at: review.createdAt,
    createdAt: review.createdAt,
  };
}

function normalizeJobStatus(status = 'open') {
  const value = String(status || '').toLowerCase().trim();
  if (value === 'active') return 'open';
  if (value === 'removed') return 'closed';
  return ['open', 'pending', 'closed'].includes(value) ? value : 'open';
}

function normalizePaymentStatus(status, fallback = 'paid') {
  const value = String(status || '').toLowerCase().trim();
  if (value === 'captured' || value === 'complete' || value === 'completed') return 'paid';
  return ['pending', 'paid', 'failed', 'refunded'].includes(value) ? value : fallback;
}

function normalizeJobPayload(payload = {}) {
  const listingMonths = Math.max(1, Number(payload.listing_months ?? payload.listingMonths ?? 1) || 1);
  const listingDurationDays = Math.max(1, Number(payload.listing_duration_days ?? payload.listingDurationDays ?? 30) || 30);
  const postingFee = Number(payload.posting_fee ?? payload.postingFee ?? 0);
  const defaultPaymentStatus = postingFee > 0 ? 'pending' : 'paid';
  const paymentStatus = normalizePaymentStatus(payload.payment_status || payload.paymentStatus, defaultPaymentStatus);
  const expiresRaw = payload.expires_at || payload.expiresAt || null;
  return {
    title: payload.title || payload.job_title || payload.jobTitle,
    description: payload.description || payload.message || '',
    category: payload.category || 'direct_hire',
    hourlyRate: Number(payload.hourly_rate ?? payload.rate ?? payload.hourlyRate ?? payload.posting_fee ?? 0),
    location: payload.location || '',
    status: normalizeJobStatus(payload.status || 'open'),
    companyName: payload.company_name || payload.companyName || '',
    jobType: payload.job_type || payload.jobType || 'full_time',
    workMode: payload.work_mode || payload.workMode || 'on_site',
    compensationText: payload.compensation_text || payload.compensationText || '',
    requirements: payload.requirements || '',
    schedule: payload.schedule || '',
    expiresAt: expiresRaw ? new Date(expiresRaw) : null,
    postingPackage: String(payload.posting_package || payload.postingPackage || 'basic').toLowerCase(),
    postingFee,
    listingMonths,
    listingDurationDays,
    paymentStatus,
  };
}

function serializeJob(job) {
  const status = job.status === 'open' ? 'active' : (job.status || 'closed');
  return {
    id: job.id,
    created_by: job.createdBy,
    createdBy: job.createdBy,
    employer_id: job.createdBy,
    employerId: job.createdBy,
    employer_name: job.creator?.displayName || '',
    company_name: job.companyName || job.creator?.userProfile?.businessName || job.creator?.displayName || '',
    companyName: job.companyName || job.creator?.userProfile?.businessName || job.creator?.displayName || '',
    title: job.title,
    job_title: job.title,
    jobTitle: job.title,
    description: job.description,
    category: job.category,
    hourly_rate: Number(job.hourlyRate),
    hourlyRate: Number(job.hourlyRate),
    rate: Number(job.hourlyRate),
    compensation_text: job.compensationText || (Number(job.hourlyRate) ? `$${Number(job.hourlyRate)}/hr` : ''),
    compensationText: job.compensationText || (Number(job.hourlyRate) ? `$${Number(job.hourlyRate)}/hr` : ''),
    compensation_type: 'range',
    location: job.location,
    job_type: job.jobType || 'full_time',
    jobType: job.jobType || 'full_time',
    work_mode: job.workMode || 'on_site',
    workMode: job.workMode || 'on_site',
    requirements: job.requirements || '',
    schedule: job.schedule || '',
    status,
    expires_at: job.expiresAt,
    expiresAt: job.expiresAt,
    posting_package: job.postingPackage || 'basic',
    postingPackage: job.postingPackage || 'basic',
    posting_fee: job.postingFee == null ? 0 : Number(job.postingFee),
    postingFee: job.postingFee == null ? 0 : Number(job.postingFee),
    subscription_total: job.postingFee == null ? 0 : Number(job.postingFee),
    listing_months: job.listingMonths || 1,
    listingMonths: job.listingMonths || 1,
    listing_duration_days: job.listingDurationDays || 30,
    listingDurationDays: job.listingDurationDays || 30,
    payment_status: job.paymentStatus || 'paid',
    posting_payment_status: job.paymentStatus || 'paid',
    stripe_checkout_session_id: job.stripeCheckoutSessionId || '',
    stripeCheckoutSessionId: job.stripeCheckoutSessionId || '',
    stripe_payment_intent_id: job.stripePaymentIntentId || '',
    stripePaymentIntentId: job.stripePaymentIntentId || '',
    stripe_charge_id: job.stripeChargeId || '',
    stripeChargeId: job.stripeChargeId || '',
    stripe_payment_status: job.stripePaymentStatus || '',
    stripePaymentStatus: job.stripePaymentStatus || '',
    paid_at: job.paidAt,
    paidAt: job.paidAt,
    date_paid: job.paidAt,
    created_at: job.createdAt,
    createdAt: job.createdAt,
    updated_at: job.updatedAt,
    updatedAt: job.updatedAt,
  };
}

function normalizeApplicationStatus(status = 'applied') {
  const value = String(status || '').toLowerCase().trim();
  if (value === 'new') return 'applied';
  if (value === 'accepted') return 'hired';
  if (value === 'offered') return 'shortlisted';
  return ['applied', 'reviewing', 'shortlisted', 'hired', 'rejected', 'withdrawn'].includes(value) ? value : 'applied';
}

function serializeApplication(app) {
  const student = app.student || {};
  const job = app.job || {};
  return {
    id: app.id,
    job_id: app.jobId,
    jobId: app.jobId,
    employer_id: job.createdBy || job.created_by || '',
    employerId: job.createdBy || job.created_by || '',
    student_id: app.studentId,
    studentId: app.studentId,
    student_name: student.displayName || '',
    studentName: student.displayName || '',
    message: app.message || '',
    resume_file_name: app.resumeFileName || app.resume_file_name || '',
    resumeFileName: app.resumeFileName || app.resume_file_name || '',
    resume_data_url: app.resumeDataUrl || app.resume_data_url || '',
    resumeDataUrl: app.resumeDataUrl || app.resume_data_url || '',
    status: app.status === 'applied' ? 'new' : app.status,
    backend_status: app.status,
    created_at: app.createdAt,
    createdAt: app.createdAt,
    updated_at: app.updatedAt,
    updatedAt: app.updatedAt,
    job: app.job ? serializeJob(app.job) : null,
  };
}

function normalizeApplyPayload(payload = {}) {
  return {
    message: payload.message || payload.cover_letter || '',
    resumeFileName: payload.resume_file_name || payload.resumeFileName || '',
    resumeDataUrl: payload.resume_data_url || payload.resumeDataUrl || '',
    status: normalizeApplicationStatus(payload.status || 'applied'),
    threadId: payload.thread_id || payload.threadId || null,
  };
}

function normalizeProjectStatus(status, strict = false) {
  const value = String(status || '').toLowerCase().trim();
  if (!value) return 'in_progress';
  if (!strict && legacyProjectStatuses.includes(value)) {
    if (value === 'applied' || value === 'offered') return 'accepted';
    if (value === 'rejected') return 'canceled';
    return value;
  }
  if (['accepted', 'funded', 'in_progress', 'awaiting_approval', 'completed', 'canceled'].includes(value)) return value;
  return 'in_progress';
}

function normalizeProjectStartPayload(payload = {}) {
  return {
    applicationId: payload.application_id || payload.applicationId,
    projectId: payload.project_id || payload.projectId || null,
    status: normalizeProjectStatus(payload.status || 'in_progress', false),
    estimatedHours: Number(payload.estimated_hours ?? payload.estimatedHours ?? 0) || null,
    hourlyRate: Number(payload.hourly_rate ?? payload.rate ?? payload.hourlyRate ?? 0) || null,
  };
}

function normalizeMessagePayload(payload = {}) {
  return {
    conversationId: payload.conversation_id || payload.conversationId || payload.thread_id || payload.threadId || null,
    recipientId: payload.to_id || payload.toId || payload.recipient_id || payload.recipientId || null,
    messageText: payload.message_text || payload.message || payload.content || '',
    messageType: payload.message_type || payload.messageType || 'user',
    projectId: payload.project_id || payload.projectId || null,
    label: payload.thread_label || payload.label || null,
  };
}

function serializeMessage(message) {
  return {
    id: message.id,
    conversation_id: message.conversationId,
    conversationId: message.conversationId,
    thread_id: message.conversationId,
    sender_id: message.senderId,
    senderId: message.senderId,
    message_text: message.messageText,
    message: message.messageText,
    message_type: message.messageType,
    created_at: message.createdAt,
    createdAt: message.createdAt,
  };
}

function serializeProject(project) {
  const transaction = project.transaction || null;
  const reviews = (project.reviews || []).map(serializeReview);
  return {
    id: project.id,
    job_id: project.jobId,
    jobId: project.jobId,
    application_id: project.applicationId,
    applicationId: project.applicationId,
    employer_id: project.employerId,
    employerId: project.employerId,
    student_id: project.studentId,
    studentId: project.studentId,
    service_id: project.serviceId,
    serviceId: project.serviceId,
    status: project.status,
    hourly_rate: Number(project.hourlyRate),
    hourlyRate: Number(project.hourlyRate),
    rate: Number(project.hourlyRate),
    estimated_hours: project.estimatedHours,
    estimatedHours: project.estimatedHours,
    actual_hours: project.actualHours,
    actualHours: project.actualHours,
    total_amount: project.totalAmount == null ? null : Number(project.totalAmount),
    totalAmount: project.totalAmount == null ? null : Number(project.totalAmount),
    payment_status: transaction ? transaction.status : undefined,
    paymentStatus: transaction ? transaction.status : undefined,
    stripe_payment_intent_id: transaction ? transaction.stripePaymentIntentId : undefined,
    stripePaymentIntentId: transaction ? transaction.stripePaymentIntentId : undefined,
    stripe_charge_id: transaction ? transaction.stripeChargeId : undefined,
    stripeChargeId: transaction ? transaction.stripeChargeId : undefined,
    stripe_transfer_id: transaction ? transaction.stripeTransferId : undefined,
    stripeTransferId: transaction ? transaction.stripeTransferId : undefined,
    stripe_application_fee_id: transaction ? transaction.stripeApplicationFeeId : undefined,
    stripeApplicationFeeId: transaction ? transaction.stripeApplicationFeeId : undefined,
    stripe_balance_transaction_id: transaction ? transaction.stripeBalanceTransactionId : undefined,
    stripeBalanceTransactionId: transaction ? transaction.stripeBalanceTransactionId : undefined,
    stripe_processing_fee: transaction && transaction.stripeProcessingFee != null ? Number(transaction.stripeProcessingFee) : undefined,
    stripeProcessingFee: transaction && transaction.stripeProcessingFee != null ? Number(transaction.stripeProcessingFee) : undefined,
    platform_net_revenue: transaction && transaction.platformNetRevenue != null ? Number(transaction.platformNetRevenue) : undefined,
    platformNetRevenue: transaction && transaction.platformNetRevenue != null ? Number(transaction.platformNetRevenue) : undefined,
    transfer_status: transaction ? transaction.transferStatus : undefined,
    transferStatus: transaction ? transaction.transferStatus : undefined,
    payout_status: transaction ? transaction.payoutStatus : undefined,
    payoutStatus: transaction ? transaction.payoutStatus : undefined,
    payout_validation_status: transaction ? transaction.payoutValidationStatus : undefined,
    payoutValidationStatus: transaction ? transaction.payoutValidationStatus : undefined,
    payout_validation_checked_at: transaction ? transaction.payoutValidationCheckedAt : undefined,
    payoutValidationCheckedAt: transaction ? transaction.payoutValidationCheckedAt : undefined,
    payout_validation_details: transaction ? transaction.payoutValidationDetails : undefined,
    payoutValidationDetails: transaction ? transaction.payoutValidationDetails : undefined,
    amount_total: transaction ? Number(transaction.amountTotal) : undefined,
    amountTotal: transaction ? Number(transaction.amountTotal) : undefined,
    platform_fee: transaction ? Number(transaction.platformFee) : undefined,
    platformFee: transaction ? Number(transaction.platformFee) : undefined,
    student_payout: transaction ? Number(transaction.studentPayout) : undefined,
    studentPayout: transaction ? Number(transaction.studentPayout) : undefined,
    job: project.job ? serializeJob(project.job) : null,
    application: project.application ? serializeApplication(project.application) : null,
    reviews,
    reviewSubmitted: reviews.some(review => review.reviewerId === project.employerId),
    review_submitted: reviews.some(review => review.reviewerId === project.employerId),
    created_at: project.createdAt,
    createdAt: project.createdAt,
    updated_at: project.updatedAt,
    updatedAt: project.updatedAt,
    completed_at: project.completedAt,
    completedAt: project.completedAt,
  };
}

function notificationType(type = 'system') {
  const allowed = ['application', 'project', 'payment', 'message', 'workshop', 'payout', 'refund', 'system'];
  return allowed.includes(type) ? type : 'system';
}

module.exports = {
  normalizeRegisterPayload,
  normalizeServicePayload,
  serializeReview,
  serializeService,
  normalizeJobPayload,
  serializeJob,
  normalizeApplicationStatus,
  serializeApplication,
  normalizeApplyPayload,
  normalizeProjectStatus,
  normalizeProjectStartPayload,
  normalizeMessagePayload,
  serializeMessage,
  serializeProject,
  notificationType,
};
