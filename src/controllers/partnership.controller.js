const asyncHandler = require('../utils/asyncHandler');
const partnershipService = require('../services/partnership.service');

const listPartners = asyncHandler(async (_req, res) => {
  res.json({ partners: await partnershipService.listPartners() });
});

const createPartner = asyncHandler(async (req, res) => {
  const partner = await partnershipService.createPartner(req.body);
  res.status(201).json({ partner });
});

const updatePartner = asyncHandler(async (req, res) => {
  const partner = await partnershipService.updatePartner(req.params.id, req.body);
  res.json({ partner });
});

const updatePartnerStatus = asyncHandler(async (req, res) => {
  const partner = await partnershipService.updatePartnerStatus(req.params.id, req.body.status);
  res.json({ partner });
});

const revenue = asyncHandler(async (_req, res) => {
  res.json(await partnershipService.getRevenue());
});

const settlements = asyncHandler(async (_req, res) => {
  res.json({ settlements: await partnershipService.listSettlements() });
});

const paySettlement = asyncHandler(async (req, res) => {
  res.json({ settlement: await partnershipService.paySettlement(req.params.id, req.user) });
});

module.exports = { listPartners, createPartner, updatePartner, updatePartnerStatus, revenue, settlements, paySettlement };
