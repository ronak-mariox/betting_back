const mongoose = require('mongoose');

/**
 * Runs `work(session)` as one Mongo transaction, so a money movement (debit,
 * credit, ledger rows) is applied whole or not at all. Atlas is a replica set
 * and supports this; a standalone local mongod doesn't, and there `work` runs
 * with `session = null` exactly as before.
 */
let supported = null;

async function transactionsSupported() {
  if (supported !== null) return supported;
  try {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    supported = Boolean(hello.setName || hello.msg === 'isdbgrid');
  } catch {
    supported = false;
  }
  return supported;
}

async function inTransaction(work) {
  if (!(await transactionsSupported())) return work(null);
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

module.exports = { inTransaction };
