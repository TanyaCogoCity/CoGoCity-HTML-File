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
  return {
    profileId: payload.profile_id || payload.profileId,
    title: payload.title,
    description: payload.description || '',
    hourlyRate: Number(payload.hourly_rate ?? payload.rate ?? payload.hourlyRate ?? 0),
    availability: payload.availability || '',
    location: payload.location || '',
    isActive: payload.is_active ?? payload.isActive ?? true,
    videoUrl: payload.video_url || payload.videoUrl || null,
  };
}

function serializeService(service) {
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
    is_active: service.isActive,
    isActive: service.isActive,
    created_at: service.createdAt,
    createdAt: service.createdAt,
  };
}

function normalizeJobPayload(payload = {}) {
  return {
    title: payload.title,
    description: payload.description || payload.message || '',
    category: payload.category || 'general',
    hourlyRate: Number(payload.hourly_rate ?? payload.rate ?? payload.hourlyRate ?? 0),
    location: payload.location || '',
    status: payload.status || 'open',
  };
}

function serializeJob(job) {
  return {
    id: job.id,
    created_by: job.createdBy,
    createdBy: job.createdBy,
    title: job.title,
    description: job.description,
    category: job.category,
    hourly_rate: Number(job.hourlyRate),
    hourlyRate: Number(job.hourlyRate),
    rate: Number(job.hourlyRate),
    location: job.location,
    status: job.status,
    created_at: job.createdAt,
    createdAt: job.createdAt,
  };
}

function normalizeApplyPayload(payload = {}) {
  return {
    message: payload.message || payload.cover_letter || '',
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
  return {
    id: project.id,
    job_id: project.jobId,
    jobId: project.jobId,
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
    created_at: project.createdAt,
    createdAt: project.createdAt,
  };
}

function notificationType(type = 'system') {
  const allowed = ['application', 'project', 'payment', 'message', 'workshop', 'payout', 'refund', 'system'];
  return allowed.includes(type) ? type : 'system';
}

module.exports = {
  normalizeRegisterPayload,
  normalizeServicePayload,
  serializeService,
  normalizeJobPayload,
  serializeJob,
  normalizeApplyPayload,
  normalizeProjectStatus,
  normalizeProjectStartPayload,
  normalizeMessagePayload,
  serializeMessage,
  serializeProject,
  notificationType,
};
