import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const indexPath = path.join(rootDir, 'index.html');
const indexHtml = fs.readFileSync(indexPath, 'utf8');
const notificationsRoutePath = path.join(rootDir, 'backend/src/routes/notifications.js');
const notificationsRoute = fs.existsSync(notificationsRoutePath) ? fs.readFileSync(notificationsRoutePath, 'utf8') : '';
const messagesRoutePath = path.join(rootDir, 'backend/src/routes/messages.js');
const messagesRoute = fs.existsSync(messagesRoutePath) ? fs.readFileSync(messagesRoutePath, 'utf8') : '';
const syncRecordsRoutePath = path.join(rootDir, 'backend/src/routes/syncRecords.js');
const syncRecordsRoute = fs.existsSync(syncRecordsRoutePath) ? fs.readFileSync(syncRecordsRoutePath, 'utf8') : '';
const transactionsRoutePath = path.join(rootDir, 'backend/src/routes/transactions.js');
const transactionsRoute = fs.existsSync(transactionsRoutePath) ? fs.readFileSync(transactionsRoutePath, 'utf8') : '';

function sliceBetween(startNeedle, endNeedle) {
  const start = indexHtml.indexOf(startNeedle);
  if (start < 0) return '';
  const end = indexHtml.indexOf(endNeedle, start);
  return indexHtml.slice(start, end > start ? end : undefined);
}

const checks = [
  {
    name: 'Community Apply treats legacy missing status as open',
    test: () => /const status = String\(post\.status \|\| 'open'\)\.toLowerCase\(\);/.test(indexHtml)
      && /!\['closed','completed','in_progress','project_started','removed'\]\.includes\(status\)/.test(indexHtml),
  },
  {
    name: 'Community public feed hides private application status after student applied',
    test: () => /const viewerApplication = getViewerCommunityApplication\(p\.id\);/.test(indexHtml)
      && !/View Status/.test(indexHtml)
      && /const canApply = currentUser && currentUser\.role === 'student' && p\.isJob && jobIsOpen && !viewerApplication;/.test(indexHtml),
  },
  {
    name: 'Community Apply refreshes backend applications before duplicate checks',
    test: () => /async function applyToPost\(postId\)/.test(indexHtml)
      && /loadBackendArraySetting\('applications', 'cogo_applications', \{ force:true, rerender:false \}\)/.test(indexHtml),
  },
  {
    name: 'Community public feed shows only public job status and applicant count',
    test: () => /getCommunityFeedApplicantCountLabel\(appsCount\)/.test(indexHtml)
      && /const publicJobStatusLabel = getCommunityFeedStatusLabel\(p\);/.test(indexHtml)
      && /return getCommunityJobDerivedStatus\(post\) === 'closed' \? 'Closed' : 'Open';/.test(indexHtml),
  },
  {
    name: 'Backend is the global source of truth for shared signed-in data',
    test: () => /function backendSharedDataIsAuthoritative\(\)/.test(indexHtml)
      && /function canUseLocalSharedCache\(entityKey=''\)/.test(indexHtml)
      && /if \(!canUseLocalSharedCache\('applications'\)\) return \[\];/.test(indexHtml)
      && /if \(backendSharedDataIsAuthoritative\(\) && !backendMessagesLoaded\)/.test(indexHtml)
      && /if \(backendSharedDataIsAuthoritative\(\) && currentUser && String\(id\) === String\(currentUser\.id\) && !backendNotificationsLoaded\)/.test(indexHtml),
  },
  {
    name: 'Community posts use backend list as authoritative snapshot',
    test: () => /const nextPosts = backendPosts;/.test(indexHtml)
      && /byId\.set\(id, normalizePostRecord\(Object\.assign\(\{\}, existing, post\)\)\);/.test(indexHtml),
  },
  {
    name: 'Community applicant counts include started projects and avoid stale post count',
    test: () => /const ignoredStatuses = new Set\(\['withdrawn','removed','deleted'\]\);/.test(indexHtml)
      && /getProjects\(\)\.forEach\(project => \{/.test(indexHtml)
      && /const hasFreshApplicationSnapshot = backendAuthEnabled\(\) && currentUser && getBackendAccessToken\(\) && backendSyncArrayIsFresh\('applications', 60000\);/.test(indexHtml),
  },
  {
    name: 'Community rejection stays private and does not allow another offer',
    test: () => /if \(!await persistCommunityJobDerivedState\(application\.postId, apps/.test(indexHtml)
      && /if \(!\['pending','applied'\]\.includes\(String\(a\.status \|\| ''\)\.toLowerCase\(\)\)\) return toast\('This applicant can no longer receive an offer\.'\);/.test(indexHtml)
      && /if \(job && getCommunityFeedStatusLabel\(job\) !== 'Closed'\) actions\.push\(`<button class="btn btn-outline btn-sm" onclick="closeCommunityJob\('\$\{esc\(job\.id\)\}'\)">Close Position<\/button>`\);/.test(indexHtml),
  },
  {
    name: 'Community rejection sends one status notification plus optional message thread',
    test: () => /Your application for "\$\{application\.jobTitle\}" has been rejected\./.test(indexHtml)
      && /dedupeKey:`community_application_rejected:\$\{application\.id\}:\$\{application\.studentUserId\}`/.test(indexHtml)
      && /sendInboxMessage\(application\.studentUserId, application\.studentName, message, null, currentUser, \{ postId: application\.postId \|\| null, applicationId: application\.id \}\);/.test(indexHtml)
      && !/sent you a message about "\$\{application\.jobTitle\}"/.test(indexHtml),
  },
  {
    name: 'Community dashboard applicants page does not list owned posts above applicants',
    test: () => !/My Community Job Posts/.test(indexHtml)
      && !/renderEmployerCommunityJobManageCard/.test(indexHtml)
      && /const allPosts = getPosts\(\)\.filter\(p => currentUserOwnsCommunityPost\(p\)\)/.test(indexHtml)
      && /html \+= `<div style="font-weight:800;margin-bottom:10px">Applicants & Offers<\/div>`;/.test(indexHtml),
  },
  {
    name: 'My Posts is a management list and top post button opens community composer',
    test: () => {
      const goToPostJobBody = sliceBetween('function goToPostJob(){', 'function dashboardLinkForAction');
      const renderMyPostsBody = sliceBetween('function renderMyPosts(el){', '// ---------- Messages ----------');
      return /openCommunityComposer\(\);/.test(goToPostJobBody)
        && !/employerMyJobsTab = 'create'/.test(goToPostJobBody)
        && /<button class="pill \$\{myPostsTab==='all'\?'active':''\}" onclick="myPostsTab='all';renderDashboard\(\)">All<\/button>/.test(renderMyPostsBody)
        && /<button class="pill \$\{myPostsTab==='social'\?'active':''\}" onclick="myPostsTab='social';renderDashboard\(\)">Social<\/button>/.test(renderMyPostsBody)
        && /<button class="pill \$\{myPostsTab==='jobs'\?'active':''\}" onclick="myPostsTab='jobs';renderDashboard\(\)">Jobs<\/button>/.test(renderMyPostsBody)
        && !/empPostContent|empPostImagesValue|empIsJob|submitEmployerDashboardPost/.test(renderMyPostsBody);
    },
  },
  {
    name: 'Employer community button matches neighbor flow and Direct Hire keeps create job',
    test: () => /employer: 'Post or Create a Job'/.test(indexHtml)
      && /const employerPrimaryLabel = !btnLabels\.employer \|\| btnLabels\.employer === 'Post a Job' \? 'Post or Create a Job' : btnLabels\.employer;/.test(indexHtml)
      && /onclick="goToPostJob\(\)">\$\{esc\(employerPrimaryLabel\)\}<\/button>/.test(indexHtml)
      && /openCommunityComposer\(\);/.test(sliceBetween('function goToPostJob(){', 'function dashboardLinkForAction'))
      && /My Direct Hire/.test(indexHtml)
      && /Create Job<\/button>/.test(indexHtml),
  },
  {
    name: 'Community gig text clamps to three lines with see more controls',
    test: () => /function renderCollapsibleLongText\(value='', key='', options=\{\}\)/.test(indexHtml)
      && /max-height:5\.1em;overflow:hidden/.test(indexHtml)
      && /See less/.test(indexHtml)
      && /See more/.test(indexHtml)
      && /\$\{p\.isJob \? '' : `<div style="margin-bottom:10px">\$\{renderCollapsibleLongText\(p\.content \|\| '', `community_post_content_\$\{p\.id\}`\)\}<\/div>`\}/.test(indexHtml)
      && /renderCollapsibleLongText\(p\.description \|\| '', `community_post_description_\$\{p\.id\}`, \{ small:true \}\)/.test(indexHtml)
      && /renderCollapsibleLongText\(displayDescription, `student_app_description_\$\{a\.id\}`, \{ small:true \}\)/.test(indexHtml)
      && /renderCollapsibleLongText\(a\.jobDescription \|\| a\.message \|\| '', `employer_app_description_\$\{a\.id\}`, \{ small:true \}\)/.test(indexHtml),
  },
  {
    name: 'Payment notifications dedupe across frontend and backend sync',
    test: () => /paymentTitle\.includes\("you've been paid"\) && paymentTitle\.includes\('my transactions'\)/.test(indexHtml)
      && /function frontendNotificationReceiptId\(userId = '', item = \{\}\)/.test(notificationsRoute)
      && /`\$\{userId\}:dedupe:\$\{dedupeKey\}`/.test(notificationsRoute)
      && /const recentDuplicate = await prisma\.notification\.findFirst/.test(notificationsRoute)
      && /reused_existing: true/.test(notificationsRoute)
      && /function dedupeNotificationRows\(rows = \[\]\)/.test(notificationsRoute)
      && /dedupeNotificationRows\(rows\)\.map/.test(notificationsRoute),
  },
  {
    name: 'Community project start is idempotent by application before Stripe and sync writes',
    test: () => /const communityProjectStartLocks = new Set\(\);/.test(indexHtml)
      && /communityProjectStartLocks\.has\(startLockKey\)/.test(indexHtml)
      && /await refreshBackendDashboardData\(\{ rerender:false \}\);/.test(indexHtml)
      && /application_id: project\.applicationId \|\| project\.application_id \|\| ''/.test(indexHtml)
      && /applicationId: a\.id/.test(indexHtml)
      && /const applicationId = String\(req\.body\?\.application_id \|\| req\.body\?\.applicationId \|\| ''\)\.trim\(\);/.test(fs.readFileSync(path.join(rootDir, 'backend/src/routes/stripe.js'), 'utf8'))
      && /const projectPaymentKey = applicationId \|\| projectId \|\| jobTitle;/.test(fs.readFileSync(path.join(rootDir, 'backend/src/routes/stripe.js'), 'utf8'))
      && /manual-project:\$\{req\.user\.id\}:\$\{projectPaymentKey\}:\$\{amountTotal\}:intent:v3:connect/.test(fs.readFileSync(path.join(rootDir, 'backend/src/routes/stripe.js'), 'utf8'))
      && /function dedupeSyncedProjectsByApplication/.test(syncRecordsRoute)
      && /normalized = await dedupeSyncedProjectsByApplication\(normalized\);/.test(syncRecordsRoute),
  },
  {
    name: 'Completed booking transactions dedupe by Stripe, project, and logical booking identity',
    test: () => /function transactionDedupeKeys\(tx=\{\}\)/.test(indexHtml)
      && /logical:\$\{studentId\}:\$\{employerId\}:\$\{title\}:\$\{day\}:\$\{rate\}:\$\{hours\}:\$\{workTotal\}:\$\{totalAmount\}:\$\{payoutAmount\}/.test(indexHtml)
      && /const existingIndex = keys\.map\(key => seen\.get\(key\)\)\.find\(index => index !== undefined\);/.test(indexHtml)
      && /function transactionDedupeKeys\(tx = \{\}\)/.test(transactionsRoute)
      && /dedupeTransactionRows\(projectTransactions[\s\S]*\.concat\(manualTransactions, jobListingTransactions, workshopTransactions\)\)/.test(transactionsRoute),
  },
  {
    name: 'Message notifications dedupe to one unread conversation notice',
    test: () => /paymentTitle\.startsWith\("you've got a message from "\)/.test(indexHtml)
      && /title\.startsWith\("you've got a message from "\)/.test(notificationsRoute)
      && /existingUnreadMessageNotice/.test(messagesRoute)
      && /isRead: false/.test(messagesRoute)
      && /if \(notificationRows\.length\) await createNotifications/.test(messagesRoute),
  },
  {
    name: 'Images load through backend-owned CDN variants instead of local embedded cache',
    test: () => /function backendImageAssetUrl\(imageId=''\)/.test(indexHtml)
      && /BACKEND_MIGRATION\.baseUrl}\/sync\/images\/\$\{encodeURIComponent\(cleanId\)\}\/file/.test(indexHtml)
      && /const fullUrl = stored\.full_url \|\| stored\.fullUrl \|\| stored\.url/.test(indexHtml)
      && /const mediumUrl = stored\.medium_url \|\| stored\.mediumUrl \|\| fullUrl;/.test(indexHtml)
      && /const thumbUrl = stored\.thumb_url \|\| stored\.thumbUrl \|\| stored\.thumbnail_url/.test(indexHtml)
      && /storage_provider: 'digitalocean_spaces'/.test(syncRecordsRoute)
      && /router\.post\('\/images\/upload'/.test(syncRecordsRoute)
      && /router\.get\('\/images\/:id\/file'/.test(syncRecordsRoute)
      && /record\.backend_asset_url = publicImageUrl;/.test(syncRecordsRoute)
      && /record\.embedded_image_omitted = false;/.test(syncRecordsRoute)
      && /const upstream = await fetch\(source\);/.test(syncRecordsRoute)
      && !/res\.redirect\(302, source\)/.test(syncRecordsRoute),
  },
  {
    name: 'Community optional image upload never relies on stale draft or local fallback',
    test: () => /let postComposerImageTouched = false;/.test(indexHtml)
      && /const postImages = postComposerImageTouched[\s\S]*\? optionalCommunityPostImages/.test(indexHtml)
      && /entity_images: postComposerImageTouched \? parseJsonArray/.test(indexHtml)
      && /postComposerImageTouched = false;[\s\S]*clearPostComposerDraft\(\);/.test(indexHtml)
      && /console\.warn\('Backend image upload failed', error\);[\s\S]*throw error;/.test(indexHtml)
      && !/falling back to regular image sync/.test(indexHtml),
  },
  {
    name: 'Blog image uploads persist backend image ids and confirm asset URL before blog save',
    test: () => /function imageReferenceForPersistence\(value=''\)/.test(indexHtml)
      && /function imageIdFromBackendAssetUrl\(value=''\)/.test(indexHtml)
      && /const featuredStoredEl = document\.getElementById\('adminBlogFeaturedImageValue'\);/.test(indexHtml)
      && /<input id="adminBlogFeaturedImageValue" type="hidden"/.test(indexHtml)
      && /await loadBackendArraySetting\('images', 'cogo_images', \{ ids:Array\.from\(referencedIds\), full:false, force:true \}\);/.test(indexHtml)
      && /fetch\(assetUrl, \{ method:'GET', cache:'no-store' \}\)/.test(indexHtml)
      && /image_asset_unreachable/.test(indexHtml),
  },
  {
    name: 'Public blog does not use stale local blog cache before backend snapshot loads',
    test: () => /if \(BACKEND_MIGRATION\.enabled && !backendBlogPostsLoaded\) \{[\s\S]*return getSeededBlogPosts\(\)\.filter/.test(indexHtml)
      && /ensureBackendBlogPostsLoaded\(\{ rerender:true \}\);/.test(indexHtml)
      && /loadBackendBlogPosts\(options\)/.test(indexHtml),
  },
  {
    name: 'Profile and service images are backend-confirmed before saved records point at them',
    test: () => /function syncReferencedImagesBeforeProfileSave\(records=\[\]\)/.test(indexHtml)
      && /collectProfileImageReferences\(record, referencedIds\)/.test(indexHtml)
      && /await syncReferencedImagesBeforeProfileSave\(\[\{[\s\S]*profileImages: d\.profileImages \|\| \[\],[\s\S]*services: d\.services \|\| \[\]/.test(indexHtml)
      && /await syncReferencedImagesBeforeProfileSave\(\[profile\]\)/.test(indexHtml)
      && /await syncReferencedImagesBeforeProfileSave\(\[\{ services:\[service\] \}\]\)/.test(indexHtml),
  },
  {
    name: 'Testimonials use backend pending approval and admin publishing controls',
    test: () => /testimonials: '\/sync\/testimonials'/.test(indexHtml)
      && /BACKEND_PUBLIC_SYNC_ENTITIES = new Set\(\['blog_posts','workshops','site_settings','direct_job_packages','testimonials','images'\]\)/.test(indexHtml)
      && /function renderTestimonialsSection\(\)/.test(indexHtml)
      && /openLeaveReviewModal\(\);return false;">Leave us a Review/.test(indexHtml)
      && /status:'pending'/.test(indexHtml)
      && /function renderAdminTestimonialsSection\(el\)/.test(indexHtml)
      && /setAdminTestimonialStatus/.test(indexHtml)
      && /requireTestimonialsWriteAccess/.test(syncRecordsRoute)
      && /'testimonials'/.test(syncRecordsRoute),
  },
  {
    name: 'Community public feed management controls are poster-only',
    test: () => /const canManage = currentUserOwnsCommunityPost\(p\);/.test(indexHtml)
      && /\$\{canManage \? `<button class="btn btn-outline btn-sm" onclick="editPost\('\$\{esc\(p\.id\)\}'\)">Edit<\/button>` : ''\}/.test(indexHtml)
      && /\$\{canManage && p\.isJob && jobIsOpen \? `<button class="btn btn-outline btn-sm" onclick="closeCommunityJob\('\$\{esc\(p\.id\)\}'\)">Close Position<\/button>` : ''\}/.test(indexHtml)
      && /\$\{canManage \? `<button class="btn btn-danger btn-sm" onclick="deletePost\('\$\{esc\(p\.id\)\}'\)">Delete<\/button>` : ''\}/.test(indexHtml),
  },
  {
    name: 'Community poster dashboard finds applicants by owned post as well as employer id',
    test: () => /function currentUserOwnsCommunityApplication\(application=\{\}\)/.test(indexHtml)
      && /const post = getApplicationJobPost\(application\);/.test(indexHtml)
      && /currentUserOwnsCommunityApplication\(a\) && a\.status !== 'project_started'/.test(indexHtml)
      && /renderUserNameLink\(a\.studentUserId \|\| a\.student_user_id, a\.studentName \|\| 'Student', true\)/.test(indexHtml)
      && /openPostFromDashboard\('\$\{esc\(a\.postId\)\}'\)/.test(indexHtml),
  },
  {
    name: 'Direct Hire submit refreshes backend job before failing local-cache applications',
    test: () => /let job = getDirectJobById\(jobId\);/.test(indexHtml)
      && /await refreshBackendDirectJobs\(\{ rerender:false \}\);/.test(indexHtml)
      && /This job is still loading from the database/.test(indexHtml),
  },
  {
    name: 'Direct Hire submit refreshes backend applications before duplicate checks',
    test: () => /await refreshBackendDirectJobApplications\(\{ rerender:false \}\);/.test(indexHtml)
      && /You already applied to this job/.test(indexHtml),
  },
  {
    name: 'Backend write session blocks local-only application writes',
    test: () => /requireBackendWriteSession\('apply to this job'\)/.test(indexHtml)
      && /requireBackendWriteSession\('apply for this job'\)/.test(indexHtml),
  },
];

const failures = checks.filter((check) => !check.test());

if (failures.length) {
  console.error('Production stability check failed:');
  failures.forEach((failure) => console.error(`- ${failure.name}`));
  process.exit(1);
}

console.log(`Production stability check passed (${checks.length} checks).`);
