const asyncHandler = require('../utils/asyncHandler');
const riskService = require('../services/risk.service');
const riskDetection = require('../services/riskDetection.service');
const ApiError = require('../utils/ApiError');

const stats = asyncHandler(async (_req, res) => {
  res.json({ stats: await riskService.getStats() });
});

const exposure = asyncHandler(async (_req, res) => {
  res.json(await riskService.getExposure());
});

const panels = asyncHandler(async (_req, res) => {
  res.json(await riskService.getPanels());
});

const suspendExposure = asyncHandler(async (req, res) => {
  const market = await riskService.suspendExposure(req.params.marketId);
  res.json({ market });
});

/** Runs the detection rules now instead of waiting for the next 10-minute scan. */
const scan = asyncHandler(async (_req, res) => {
  res.json({ result: await riskDetection.scanOnce(), ...(await riskService.getPanels()) });
});

const resolveFlag = asyncHandler(async (req, res) => {
  const flagged = await riskDetection.resolveFlag(req.params.id, req.user);
  if (!flagged) throw ApiError.notFound('Flag not found');
  res.json({ flagged });
});

const resolvePattern = asyncHandler(async (req, res) => {
  const pattern = await riskDetection.resolvePattern(req.params.id, req.user);
  if (!pattern) throw ApiError.notFound('Pattern not found');
  res.json({ pattern });
});

module.exports = { stats, exposure, panels, suspendExposure, scan, resolveFlag, resolvePattern };
