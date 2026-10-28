const asyncHandler = require('../utils/asyncHandler');
const reportService = require('../services/report.service');
const { requireGrant, scopeFor } = require('../services/scope.service');
const { toCsv } = require('../utils/csv');

/** The commission report shows the same rows as the Commission page, so it needs that page's view grant too. */
async function reportScope(req) {
  if (req.params.kind === 'commission') {
    await requireGrant(req.user, 'finance', 'commission', 'V', 'You do not have permission to view commission');
  }
  return scopeFor(req.user);
}

const preview = asyncHandler(async (req, res) => {
  const rows = await reportService.buildReport(req.params.kind, { ...req.query, scope: await reportScope(req) });
  res.json({ kind: req.params.kind, rows, total: rows.length });
});

const exportCsv = asyncHandler(async (req, res) => {
  const rows = await reportService.buildReport(req.params.kind, { ...req.query, scope: await reportScope(req) });
  const columns = rows.length ? Object.keys(rows[0]) : [];
  const csv = toCsv(rows, columns);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.kind}-report.csv"`);
  res.send(csv);
});

module.exports = { preview, exportCsv };
