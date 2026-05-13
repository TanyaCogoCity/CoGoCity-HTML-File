#!/usr/bin/env node
/*
  CoGo City staging cleanup job for DigitalOcean App Platform.

  Purpose:
  - Keep approved/imported staging users only.
  - Delete non-preserved fake/test users and dependent content.

  Safety:
  - Dry-run by default: node scripts/cleanup_staging_users.js
  - Execute requires BOTH:
      COGOCITY_CLEANUP_ALLOW_STAGING=yes
      node scripts/cleanup_staging_users.js --execute
  - DATABASE_URL must be present from DigitalOcean env, normally ${db.DATABASE_URL}.
  - Admin users are protected by default unless --delete-admins is passed.
*/

const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const args = new Set(process.argv.slice(2));
const execute = args.has('--execute');
const deleteAdmins = args.has('--delete-admins');
const jsonOnly = args.has('--json');
const now = new Date();

const KEEP_EMAILS = [
  "admin@cogocity.com",
  "advaychags07@gmail.com",
  "advik.anuganti@gmail.com",
  "akkeovilai@gmail.com",
  "alexa.tarnarider13@gmail.com",
  "alexihorvath1@gmail.com",
  "alexyscarlson1@icloud.com",
  "allisonmtebbe@gmail.com",
  "alyssa_wisenor@yahoo.com",
  "aman@targetintegration.com",
  "anishkawilliam581@gmail.com",
  "asmabhameed@gmail.com",
  "atanaciomargarita31@gmail.com",
  "banjayaga@gmail.com",
  "bauerskis@gmail.com",
  "bob@elsberg.com",
  "bobbysbrigade@yahoo.com",
  "braden@hcprosonline.com",
  "cadenbanks1@gmail.com",
  "cameron@scalembs.com",
  "carapaton46@gmail.com",
  "charlotte.mercy.ricketts@gmail.com",
  "cjpfotie@icloud.com",
  "coachstepper@yahoo.com",
  "cogo.team@system.local",
  "cogocityassistant@gmail.com",
  "contact@masalagossip.com",
  "cramos.ps23@gmail.com",
  "dan.lipovich@gmail.com",
  "daniel@insurance415.com",
  "danna.rapoport@gmail.com",
  "daria.madej09@gmail.com",
  "dawncebert@gmail.com",
  "dilkasy@gmail.com",
  "dmalnaeem119@gmail.com",
  "dongjuan.xi@gmail.com",
  "dsmino1122@gmail.com",
  "e.zakharov2006@gmail.com",
  "edwardkogan1@gmail.com",
  "ellie@shoeboxiq.com",
  "elviramanoser@gmail.com",
  "ethanrudnitskiy@gmail.com",
  "evan.n.tsai@gmail.com",
  "event_team@techbeatconference.com",
  "events@femigrants.com",
  "garciadillon360@gmail.com",
  "gghh@gmail.com",
  "gideonstriumph@aol.com",
  "gigisunshineferreri@icloud.com",
  "ginigini30@gmail.com",
  "guadalupeville016@gmail.com",
  "haileeschreiner@gmail.com",
  "hrhawkins24@gmail.com",
  "huanucdmc@yahoo.com",
  "ilona@votumco.com",
  "ilusha@gmail.com",
  "ilya.lipovich@getcider.com",
  "info@fosteringwishes.org",
  "info@icandothatpac.org",
  "info@premiernnanysource.com",
  "info@seanetvision.com",
  "j@shopfilia.com",
  "jackmaaliska@eteiala.com",
  "jacquelinetkach@yahoo.com",
  "jameskaydevuser@gmail.com",
  "javier@osiengineering.com",
  "jessnokes322@gmail.com",
  "jnaqvi66@gmail.com",
  "joannasbridal@sbcglobal.net",
  "jolenespol6@gmail.com",
  "jong.hahn@gmail.com",
  "jpeek@bestversionmedia.com",
  "jtalbot@u-needacoach.com",
  "junkstershaulaway@gmail.com",
  "khawajamahmood.upwork@gmail.com",
  "kimhourlayaz@gmail.com",
  "kristenb260@gmail.com",
  "kscott@dionhealth.com",
  "latin.accents@gmail.com",
  "lauren@laurenl.net",
  "laxeaj10@icloud.com",
  "lbardzil4@gmail.com",
  "leilamiller26@gmail.com",
  "lilia.vernikfamily@gmail.com",
  "lizagof@gmail.com",
  "loren@prosperitylab.org",
  "lorirlynch@yahoo.com",
  "lpwong7@outlook.com",
  "ltomita@gmail.com",
  "madelinetaylorr2009@gmail.com",
  "mahathi.choudhry@gmail.com",
  "malusilverio@hotmail.com",
  "maxynec@gmail.com",
  "mcastellanospulido@gmail.com",
  "mdpinski@berkeley.edu",
  "mejiavaleria138@gmail.com",
  "mia.cateriano@gmail.com",
  "michellems010@gmail.com",
  "mike.merkur@gmail.com",
  "mjbellig@yahoo.com",
  "mk@rejuvenatedknives.com",
  "mkambweb@gmail.com",
  "monica.laimayum@gmail.com",
  "moretti_samuel@outlook.com",
  "mrs.agaeva90@gmail.com",
  "mybawani@gmail.com",
  "nadine@nb-bio.com",
  "naimastucky9@gmail.com",
  "nam.iyyar@gmail.com",
  "naomi.nisenboim@gmail.com",
  "nikokitten521@gmail.com",
  "noahkogan1@gmail.com",
  "nourian.niki2@gmail.com",
  "oldworldlinen@gmail.com",
  "paulginocchiomft@gmail.com",
  "peterconsos1@gmail.com",
  "plazapet@aol.com",
  "poringpontwitch@gmail.com",
  "radmila.grin@gmail.com",
  "ranarakowdds@gmail.com",
  "randomhuman224093@gmail.com",
  "rishipalle07@gmail.com",
  "ryanjianna21@berkeley.edu",
  "sarabellig@yahoo.com",
  "savannahhagmaier@gmail.com",
  "sfse589@gmail.com",
  "shannendharyl@gmail.com",
  "sivankovitser@gmail.com",
  "slowgeatery@yahoo.com",
  "smukkaram@gmail.com",
  "support@scalembs.com",
  "swanangel99@gmail.com",
  "tanya.lipovich@gmail.com",
  "tanya@cogocity.com",
  "thepatrickoliver@gmail.com",
  "tingaojiang@gmail.com",
  "trey.phelps@rastudents.com",
  "ulyanazilch@gmail.com",
  "utkarsh@worldyogafederation.us",
  "vino@vinopari.com",
  "viviwinnie789@gmail.com",
  "whitlkay4@gmail.com",
  "willoey@yahoo.com",
  "wong.j.stephanie@gmail.com",
  "ybuich@aol.com",
  "yshihab04@gmail.com",
  "yulia172@yahoo.com",
  "zacharytconnors@gmail.com",
  "zgourji@apres-scrubs.com",
  "zliudmylka@gmail.com"
];

const PRESERVE_SOURCE_COUNTS = {
  uploadedStudents: 57,
  importedEmployers: 53,
  importedNeighbors: 38,
  protectedAdmins: 3,
  totalKeepEmails: KEEP_EMAILS.length,
};

function email(value) {
  return String(value || '').trim().toLowerCase();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

async function idsFromRows(rows) {
  return rows.map(r => r.id);
}

function summarizeUsers(users, limit = 200) {
  return users.slice(0, limit).map(u => ({
    id: u.id,
    email: u.email,
    role: u.role,
    displayName: u.displayName,
    createdAt: u.createdAt,
  }));
}

async function collectPlan(prisma) {
  const allUsers = await prisma.user.findMany({
    where: { deletedAt: null },
    select: { id: true, email: true, role: true, displayName: true, createdAt: true },
    orderBy: [{ role: 'asc' }, { email: 'asc' }],
  });

  const keepEmailSet = new Set(KEEP_EMAILS.map(email));
  const deleteUsers = allUsers.filter(u => !keepEmailSet.has(email(u.email)) && (deleteAdmins || u.role !== 'admin'));
  const protectedUsers = allUsers.filter(u => !keepEmailSet.has(email(u.email)) && !deleteAdmins && u.role === 'admin');
  const keepUsers = allUsers.filter(u => keepEmailSet.has(email(u.email)) || (!deleteAdmins && u.role === 'admin'));
  const deleteUserIds = await idsFromRows(deleteUsers);

  const studentProfiles = await prisma.studentProfile.findMany({ where: { userId: { in: deleteUserIds } }, select: { id: true } });
  const studentProfileIds = await idsFromRows(studentProfiles);
  const services = await prisma.service.findMany({ where: { profileId: { in: studentProfileIds } }, select: { id: true } });
  const serviceIds = await idsFromRows(services);

  const jobs = await prisma.job.findMany({ where: { createdBy: { in: deleteUserIds } }, select: { id: true } });
  const jobIds = await idsFromRows(jobs);

  const applications = await prisma.application.findMany({
    where: { OR: [{ studentId: { in: deleteUserIds } }, { jobId: { in: jobIds } }] },
    select: { id: true },
  });
  const applicationIds = await idsFromRows(applications);

  const projects = await prisma.project.findMany({
    where: { OR: [
      { employerId: { in: deleteUserIds } },
      { studentId: { in: deleteUserIds } },
      { jobId: { in: jobIds } },
      { applicationId: { in: applicationIds } },
      { serviceId: { in: serviceIds } },
    ] },
    select: { id: true },
  });
  const projectIds = await idsFromRows(projects);

  const conversationsViaParticipants = await prisma.conversationParticipant.findMany({
    where: { userId: { in: deleteUserIds } },
    select: { conversationId: true },
  });
  const conversationsViaMessages = await prisma.message.findMany({
    where: { senderId: { in: deleteUserIds } },
    select: { conversationId: true },
  });
  const conversationsViaProjects = await prisma.conversation.findMany({
    where: { projectId: { in: projectIds } },
    select: { id: true },
  });
  const conversationIds = unique([
    ...conversationsViaParticipants.map(r => r.conversationId),
    ...conversationsViaMessages.map(r => r.conversationId),
    ...conversationsViaProjects.map(r => r.id),
  ]);

  const workshops = await prisma.workshop.findMany({ where: { createdBy: { in: deleteUserIds } }, select: { id: true } });
  const workshopIds = await idsFromRows(workshops);

  const entityIds = unique([...deleteUserIds, ...studentProfileIds, ...serviceIds, ...jobIds, ...applicationIds, ...projectIds, ...workshopIds]);

  const counts = {
    usersTotalActive: allUsers.length,
    usersKept: keepUsers.length,
    usersToDelete: deleteUsers.length,
    protectedAdminsNotInKeepList: protectedUsers.length,
    studentProfilesToDelete: studentProfileIds.length,
    servicesToDelete: serviceIds.length,
    jobsToDelete: jobIds.length,
    applicationsToDelete: applicationIds.length,
    projectsToDelete: projectIds.length,
    conversationsToDelete: conversationIds.length,
    workshopsToDelete: workshopIds.length,
  };

  return {
    generatedAt: now.toISOString(),
    mode: execute ? 'execute' : 'dry-run',
    deleteAdmins,
    preserveSourceCounts: PRESERVE_SOURCE_COUNTS,
    counts,
    samples: {
      keepUsers: summarizeUsers(keepUsers, 60),
      deleteUsers: summarizeUsers(deleteUsers, 200),
      protectedUsers: summarizeUsers(protectedUsers, 50),
    },
    ids: { deleteUserIds, studentProfileIds, serviceIds, jobIds, applicationIds, projectIds, conversationIds, workshopIds, entityIds },
  };
}

async function executePlan(prisma, plan) {
  if (!execute) return null;
  if (process.env.COGOCITY_CLEANUP_ALLOW_STAGING !== 'yes') {
    throw new Error('Refusing execute: set COGOCITY_CLEANUP_ALLOW_STAGING=yes');
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('Refusing execute: DATABASE_URL is required');
  }

  const { deleteUserIds, studentProfileIds, serviceIds, jobIds, applicationIds, projectIds, conversationIds, workshopIds, entityIds } = plan.ids;

  return prisma.$transaction(async tx => {
    const result = {};

    result.workshopEnrollments = await tx.workshopEnrollment.deleteMany({ where: { OR: [{ userId: { in: deleteUserIds } }, { workshopId: { in: workshopIds } }] } });
    result.entityMedia = await tx.entityMedia.deleteMany({ where: { entityId: { in: entityIds } } });
    result.messages = await tx.message.deleteMany({ where: { OR: [{ senderId: { in: deleteUserIds } }, { conversationId: { in: conversationIds } }] } });
    result.conversationParticipants = await tx.conversationParticipant.deleteMany({ where: { OR: [{ userId: { in: deleteUserIds } }, { conversationId: { in: conversationIds } }] } });
    result.conversations = await tx.conversation.deleteMany({ where: { id: { in: conversationIds } } });
    result.notifications = await tx.notification.deleteMany({ where: { userId: { in: deleteUserIds } } });
    result.refreshTokens = await tx.refreshToken.deleteMany({ where: { userId: { in: deleteUserIds } } });
    result.reviews = await tx.review.deleteMany({ where: { OR: [{ projectId: { in: projectIds } }, { reviewerId: { in: deleteUserIds } }, { studentId: { in: deleteUserIds } }, { serviceId: { in: serviceIds } }] } });
    result.transactions = await tx.transaction.deleteMany({ where: { OR: [{ projectId: { in: projectIds } }, { payerId: { in: deleteUserIds } }, { payeeId: { in: deleteUserIds } }] } });
    result.projects = await tx.project.deleteMany({ where: { id: { in: projectIds } } });
    result.applications = await tx.application.deleteMany({ where: { OR: [{ id: { in: applicationIds } }, { studentId: { in: deleteUserIds } }, { jobId: { in: jobIds } }] } });
    result.jobs = await tx.job.deleteMany({ where: { id: { in: jobIds } } });
    result.workshops = await tx.workshop.deleteMany({ where: { id: { in: workshopIds } } });
    result.services = await tx.service.deleteMany({ where: { id: { in: serviceIds } } });
    result.studentProfiles = await tx.studentProfile.deleteMany({ where: { id: { in: studentProfileIds } } });
    result.userProfiles = await tx.userProfile.deleteMany({ where: { userId: { in: deleteUserIds } } });
    result.auditLogs = await tx.auditLog.deleteMany({ where: { userId: { in: deleteUserIds } } });
    result.users = await tx.user.deleteMany({ where: { id: { in: deleteUserIds } } });

    return result;
  }, { timeout: 120000 });
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required. In DigitalOcean, set DATABASE_URL=${db.DATABASE_URL} for this job.');
  }

  const prisma = new PrismaClient();
  try {
    const plan = await collectPlan(prisma);
    const execution = await executePlan(prisma, plan);
    const output = { ...plan, execution };
    const reportPath = path.resolve(process.cwd(), `staging-cleanup-${execute ? 'executed' : 'dry-run'}-${now.toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(output, null, 2));

    if (jsonOnly) {
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log(`${execute ? 'EXECUTED' : 'DRY RUN'} staging cleanup plan`);
      console.log(`Report: ${reportPath}`);
      console.log(JSON.stringify({ preserveSourceCounts: output.preserveSourceCounts, counts: output.counts }, null, 2));
      console.log('');
      console.log('Sample delete users:');
      console.log(JSON.stringify(output.samples.deleteUsers.slice(0, 40), null, 2));
      if (!execute) {
        console.log('');
        console.log('No changes made. After reviewing the report/logs, execute with: COGOCITY_CLEANUP_ALLOW_STAGING=yes node scripts/cleanup_staging_users.js --execute');
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
