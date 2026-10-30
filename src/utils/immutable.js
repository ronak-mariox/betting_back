const ApiError = require('./ApiError');

const UPDATES = ['updateOne', 'updateMany', 'findOneAndUpdate'];
const BLOCKED = ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'];

/**
 * Financial records are append-only: once written they are never edited or
 * deleted by the app. A mistake is corrected with a separate Adjustment entry
 * that records its reason. `allow` lists fields that may still change (for
 * example a transfer's status moving from Pending to Completed).
 */
function makeAppendOnly(schema, label, { allow = [] } = {}) {
  const allowed = new Set([...allow, 'updatedAt']);
  schema.pre(BLOCKED, function guard() {
    if (allow.length && UPDATES.includes(this.op)) {
      const update = this.getUpdate() || {};
      const keys = Object.keys(update);
      const onlySet = keys.every((k) => k === '$set' || !k.startsWith('$'));
      const fields = [...Object.keys(update.$set || {}), ...keys.filter((k) => !k.startsWith('$'))];
      if (onlySet && fields.every((f) => allowed.has(f))) return;
    }
    throw ApiError.forbidden(`${label} records can't be changed or deleted — add an adjustment entry instead`);
  });
  schema.pre('save', function guardSave() {
    if (this.isNew) return;
    const changed = this.modifiedPaths().filter((p) => !allowed.has(p));
    if (changed.length) throw ApiError.forbidden(`${label} records can't be changed — add an adjustment entry instead`);
  });
}

module.exports = { makeAppendOnly };
