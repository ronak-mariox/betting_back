const User = require('../models/User');
const Commission = require('../models/Commission');
const env = require('../config/env');
const { hashPassword } = require('./password.service');
const permissionService = require('./permission.service');
const { seedAdminDemoData } = require('./seed.service');
const { ensureAgentReferralCodes } = require('./account.service');
const { backfillPlayerFeeds } = require('./notification.service');
const { ensurePartnerCodes } = require('./partnership.service');

/**
 * Every hierarchy needs a root. If no super-admin exists yet, one is
 * created from SUPER_ADMIN_USERNAME / SUPER_ADMIN_PASSWORD (falling back to
 * the bettingWeb Quick Demo Login credentials outside production, so the
 * panel's demo login keeps working against a real backend).
 */
async function ensureRootSuperAdmin() {
  const exists = await User.exists({ role: 'super-admin' });
  if (exists) return;

  const username = process.env.SUPER_ADMIN_USERNAME || (env.nodeEnv !== 'production' ? 'mithu8178' : null);
  const password = process.env.SUPER_ADMIN_PASSWORD || (env.nodeEnv !== 'production' ? 'superadmin@123' : null);

  if (!username || !password) {
    console.warn( // eslint-disable-line no-console
      'No super-admin account exists and SUPER_ADMIN_USERNAME/SUPER_ADMIN_PASSWORD are not set — skipping bootstrap.',
    );
    return;
  }

  const passwordHash = await hashPassword(password);
  await User.create({
    username: username.toLowerCase(),
    passwordHash,
    role: 'super-admin',
    name: 'Ankit Sharma',
    status: 'active',
  });
  console.log(`Seeded root super-admin account "${username}"`); // eslint-disable-line no-console
}

/**
 * Seeds the rest of the bettingWeb Quick Demo Login chain (franchise ->
 * super-agent -> agent), each parented under the previous, matching
 * config/roles.ts exactly. Skipped in production and if the accounts
 * already exist.
 */
async function seedDemoHierarchy() {
  if (env.nodeEnv === 'production' && process.env.SEED_DEMO_DATA !== 'true') return;

  const superAdmin = await User.findOne({ role: 'super-admin' });
  if (!superAdmin) return;

  const chain = [
    { username: 'franchise01', password: 'franchise@123', role: 'franchise', name: 'Rakesh Kadam' },
    { username: 'superagent01', password: 'superagent@123', role: 'super-agent', name: 'Imran Sheikh' },
    { username: 'agent01', password: 'agent@123', role: 'agent', name: 'Sahil Verma' },
  ];

  let parent = superAdmin;
  for (const seed of chain) {
    // eslint-disable-next-line no-await-in-loop
    let user = await User.findOne({ username: seed.username });
    if (!user) {
      // eslint-disable-next-line no-await-in-loop
      const passwordHash = await hashPassword(seed.password);
      // eslint-disable-next-line no-await-in-loop
      user = await User.create({
        username: seed.username,
        passwordHash,
        role: seed.role,
        name: seed.name,
        parent: parent._id,
        createdBy: parent._id,
        status: 'active',
      });
      console.log(`Seeded demo ${seed.role} account "${seed.username}"`); // eslint-disable-line no-console
    }
    parent = user;
  }
}

/**
 * Commission rows used to be unique per entity + period; a period can now
 * hold one row per settlement, so the old unique index has to go.
 */
async function dropLegacyIndexes() {
  try {
    await Commission.collection.dropIndex('entity_1_period_1');
  } catch {
    // Already gone (or the collection doesn't exist yet).
  }
}

async function runBootstrap() {
  await dropLegacyIndexes();
  await ensureRootSuperAdmin();
  await seedDemoHierarchy();
  await permissionService.seedDefaults();
  try {
    await seedAdminDemoData();
  } catch (err) {
    // Demo data is a convenience — a seeding problem must not keep the API down.
    console.error('Demo data seed failed (server continues):', err.message); // eslint-disable-line no-console
  }
  await ensureAgentReferralCodes();
  await ensurePartnerCodes();
  try {
    await backfillPlayerFeeds();
  } catch (err) {
    console.error('Notification backfill failed (server continues):', err.message); // eslint-disable-line no-console
  }
}

module.exports = { runBootstrap, ensureRootSuperAdmin, seedDemoHierarchy };
