#!/usr/bin/env node
/*
  Clear a stale Stripe Connect account from a staging user so they can re-onboard.

  Safety defaults:
  - Dry-run unless EXECUTE=1 is set.
  - Refuses production-looking DATABASE_URL unless ALLOW_PRODUCTION=1 is set.

  Usage examples:
    STUDENT_EMAIL=daniel@example.com node scripts/clear_stale_connect_account.js
    STUDENT_EMAIL=daniel@example.com EXECUTE=1 node scripts/clear_stale_connect_account.js
    STRIPE_ACCOUNT_ID=acct_123 EXECUTE=1 node scripts/clear_stale_connect_account.js
*/

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

function assertSafeDatabaseUrl() {
  const url = process.env.DATABASE_URL || '';
  if (!url) throw new Error('DATABASE_URL is required');
  const lower = url.toLowerCase();
  const looksProduction = /prod|production/.test(lower) && !/stag|staging|dev|test/.test(lower);
  if (looksProduction && process.env.ALLOW_PRODUCTION !== '1') {
    throw new Error('DATABASE_URL looks production-like. Refusing to run without ALLOW_PRODUCTION=1.');
  }
}

async function main() {
  assertSafeDatabaseUrl();
  const prisma = new PrismaClient();
  const execute = process.env.EXECUTE === '1';
  const email = (process.env.STUDENT_EMAIL || '').trim();
  const userId = (process.env.STUDENT_USER_ID || '').trim();
  const accountId = (process.env.STRIPE_ACCOUNT_ID || 'acct_1TYBzIRQIHXnGn7h').trim();

  if (!email && !userId && !accountId) {
    throw new Error('Set STUDENT_EMAIL, STUDENT_USER_ID, or STRIPE_ACCOUNT_ID');
  }

  const where = userId
    ? { id: userId }
    : email
      ? { email: { equals: email, mode: 'insensitive' } }
      : { stripeAccountId: accountId };

  const users = await prisma.user.findMany({
    where,
    select: {
      id: true,
      displayName: true,
      firstName: true,
      lastName: true,
      email: true,
      role: true,
      stripeAccountId: true,
      stripeConnectOnboardingStatus: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
      stripeDetailsSubmitted: true,
    },
  });

  if (users.length !== 1) {
    console.log(JSON.stringify(users, null, 2));
    throw new Error(`Expected exactly 1 matching user, found ${users.length}. Refusing to update.`);
  }

  const user = users[0];
  console.log('Matched user before reset:');
  console.log(JSON.stringify(user, null, 2));

  const data = {
    stripeAccountId: null,
    stripeConnectOnboardingStatus: 'not_started',
    stripeChargesEnabled: false,
    stripePayoutsEnabled: false,
    stripeDetailsSubmitted: false,
  };

  if (!execute) {
    console.log('\nDRY RUN ONLY. Re-run with EXECUTE=1 to clear these fields:');
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data,
    select: {
      id: true,
      displayName: true,
      email: true,
      role: true,
      stripeAccountId: true,
      stripeConnectOnboardingStatus: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
      stripeDetailsSubmitted: true,
    },
  });

  console.log('\nUpdated user:');
  console.log(JSON.stringify(updated, null, 2));
  await prisma.$disconnect();
}

main().catch(async error => {
  console.error(error.message || error);
  process.exitCode = 1;
});
