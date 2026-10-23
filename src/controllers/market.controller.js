const asyncHandler = require('../utils/asyncHandler');
const marketService = require('../services/market.service');

const list = asyncHandler(async (req, res) => {
  const markets = await marketService.listMarkets(req.query);
  res.json({ markets });
});

const create = asyncHandler(async (req, res) => {
  const market = await marketService.createMarket(req.body);
  res.status(201).json({ market });
});

const update = asyncHandler(async (req, res) => {
  const market = await marketService.updateMarket(req.params.id, req.body);
  res.json({ market });
});

const updateStatus = asyncHandler(async (req, res) => {
  const market = await marketService.updateMarketStatus(req.params.id, req.body.status);
  res.json({ market });
});

const suspendAll = asyncHandler(async (req, res) => {
  const result = await marketService.suspendAll(req.body?.eventId);
  res.json(result);
});

const voidMarket = asyncHandler(async (req, res) => {
  // eslint-disable-next-line global-require
  res.json(await require('../services/playerBet.service').voidMarket(req.params.id, req.body.reason));
});

const settle = asyncHandler(async (req, res) => {
  // The winner, or for run-based markets (sessions, odd / even, last digit) the runs scored.
  // eslint-disable-next-line global-require
  res.json(await require('../services/playerBet.service').settleMarketResult(req.params.id, req.body.winner));
});

module.exports = {
  settle, voidMarket, list, create, update, updateStatus, suspendAll };
