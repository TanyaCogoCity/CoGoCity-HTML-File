#!/usr/bin/env node
/*
  Staging-only safety gate for migrated employer/neighbor accounts.

  Default mode is DRY RUN. With --execute, marks the employer/neighbor emails from the
  staging import CSV as requiring:
    - profile review/update completion
    - a saved Stripe payment method before hiring/platform actions

  It preserves existing user profile metadata and refuses production-looking DATABASE_URLs.
*/
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const args = new Set(process.argv.slice(2));
const execute = args.has('--execute');
const inputDirArg = process.argv.find((a) => a.startsWith('--input-dir='));
const inputDir = path.resolve(inputDirArg ? inputDirArg.split('=').slice(1).join('=') : path.join(__dirname, '../../live-wordpress-export/employer-neighbor-staging-import'));
const allow = process.env.COGOCITY_IMPORT_ALLOW_STAGING === 'yes';

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inQuotes) {
      if (c === '"' && n === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const headers = (rows.shift() || []).map((h) => h.trim());
  return rows.filter((r) => r.some((v) => String(v || '').trim())).map((r, idx) => {
    const obj = { __row: idx + 2 };
    headers.forEach((h, i) => obj[h] = String(r[i] || '').trim());
    return obj;
  });
}
function readUsersCsv() {
  const file = path.join(inputDir, 'cogocity-staging-import-users.csv');
  if (!fs.existsSync(file)) throw new Error(`Missing CSV: ${file}`);
  return parseCsv(fs.readFileSync(file, 'utf8'));
}
function selected(row) { return String(row.import_action || '').toLowerCase() !== 'skip'; }
function failIfProduction() {
  const url = process.env.DATABASE_URL || '';
  if (/prod|production|cogocity\.com/i.test(url) && !/staging|do-user/i.test(url)) {
    throw new Error('DATABASE_URL looks production-like. Refusing to run. Use staging only.');
  }
}
function metadataObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function main() {
  const sourceRows = readUsersCsv()
    .filter(selected)
    .filter((row) => ['employer', 'neighbor'].includes(String(row.role || '').toLowerCase()));
  const sourceEmails = [...new Set(sourceRows.map((row) => String(row.email || '').trim().toLowerCase()).filter(Boolean))];
  const sourceRoleByEmail = new Map(sourceRows.map((row) => [String(row.email || '').trim().toLowerCase(), String(row.role || '').trim().toLowerCase()]));

  console.log(JSON.stringify({ mode: execute ? 'EXECUTE' : 'DRY_RUN', inputDir, sourceCount: sourceEmails.length }, null, 2));
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  failIfProduction();
  if (execute && !allow) throw new Error('Refusing execute without COGOCITY_IMPORT_ALLOW_STAGING=yes');

  const prisma = new PrismaClient();
  try {
    const users = await prisma.user.findMany({
      where: { email: { in: sourceEmails }, deletedAt: null },
      include: { userProfile: true },
      orderBy: { email: 'asc' },
    });
    const found = new Set(users.map((u) => u.email.toLowerCase()));
    const missing = sourceEmails.filter((email) => !found.has(email));
    const eligible = users.filter((u) => ['employer', 'neighbor'].includes(u.role));
    const skippedRoleMismatch = users
      .filter((u) => !['employer', 'neighbor'].includes(u.role))
      .map((u) => ({ email: u.email, source_role: sourceRoleByEmail.get(u.email.toLowerCase()), current_role: u.role }));

    if (execute) {
      for (const user of eligible) {
        const metadata = Object.assign({}, metadataObject(user.userProfile?.metadata), {
          migration_onboarding_required: true,
          payment_method_required: true,
        });
        await prisma.userProfile.upsert({
          where: { userId: user.id },
          create: { userId: user.id, metadata },
          update: { metadata },
        });
      }
    }

    console.log(JSON.stringify({
      ok: true,
      execute,
      sourceCount: sourceEmails.length,
      found: users.length,
      flaggedOrWouldFlag: eligible.length,
      missing,
      skippedRoleMismatch,
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
