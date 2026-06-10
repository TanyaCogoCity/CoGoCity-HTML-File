import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const indexPath = path.join(rootDir, 'index.html');
const indexHtml = fs.readFileSync(indexPath, 'utf8');

const checks = [
  {
    name: 'Community Apply treats legacy missing status as open',
    test: () => /const status = String\(post\.status \|\| 'open'\)\.toLowerCase\(\);/.test(indexHtml)
      && /!\['closed','completed','in_progress','removed'\]\.includes\(status\)/.test(indexHtml),
  },
  {
    name: 'Community Apply hides duplicate Apply button after student applied',
    test: () => /const viewerApplication = getViewerCommunityApplication\(p\.id\);/.test(indexHtml)
      && /View Status/.test(indexHtml)
      && /const canApply = currentUser && currentUser\.role === 'student' && p\.isJob && jobIsOpen && !viewerApplication;/.test(indexHtml),
  },
  {
    name: 'Community Apply refreshes backend applications before duplicate checks',
    test: () => /async function applyToPost\(postId\)/.test(indexHtml)
      && /loadBackendArraySetting\('applications', 'cogo_applications', \{ force:true, rerender:false \}\)/.test(indexHtml),
  },
  {
    name: 'Community public feed shows applicant counts separately from private status',
    test: () => /getCommunityFeedApplicantCountLabel\(appsCount\)/.test(indexHtml)
      && /const showJobStatus = canViewCommunityJobStatus\(p\);/.test(indexHtml),
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
    test: () => /const ignoredStatuses = new Set\(\['withdrawn','rejected','declined','removed','deleted'\]\);/.test(indexHtml)
      && /getProjects\(\)\.forEach\(project => \{/.test(indexHtml)
      && /const hasFreshApplicationSnapshot = backendAuthEnabled\(\) && currentUser && getBackendAccessToken\(\) && backendSyncArrayIsFresh\('applications', 60000\);/.test(indexHtml),
  },
  {
    name: 'Community private status is explicitly scoped to poster or applying student',
    test: () => /function canViewCommunityJobStatus\(post=\{\}\)/.test(indexHtml)
      && /String\(currentUser\.id \|\| ''\) === String\(post\.authorId \|\| ''\) \|\| !!getViewerCommunityApplication\(post\.id\)/.test(indexHtml)
      && /return `Your status: \$\{String\(application\.status \|\| 'pending'\)\.replaceAll\('_', ' '\)\}`;/.test(indexHtml)
      && /const statusBadgeText = viewerApplication \? visibleJobStatusLabel : `Job status: \$\{visibleJobStatusLabel\}`;/.test(indexHtml),
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
