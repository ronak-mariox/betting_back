const Event = require('../models/Event');
const Market = require('../models/Market');
const ApiProvider = require('../models/ApiProvider');

const TAB_STATUS = {
  live: 'Live',
  upcoming: 'Upcoming',
  completed: 'Completed',
};

const listMatches = async ({ tab }) => {
  const filter = {};
  if (tab && TAB_STATUS[tab]) filter.status = TAB_STATUS[tab];

  const events = await Event.find(filter).sort({ startTime: 1 }).lean();
  const eventIds = events.map((e) => e._id);
  const markets = await Market.find({ event: { $in: eventIds } }).lean();

  const marketsByEvent = markets.reduce((acc, market) => {
    const key = String(market.event);
    if (!acc[key]) acc[key] = [];
    acc[key].push(market);
    return acc;
  }, {});

  // eslint-disable-next-line global-require
  const { mediaFor } = require('./diamondSync.service');
  return events.map((event) => ({ ...event, ...mediaFor(event), markets: marketsByEvent[String(event._id)] || [] }));
};

const listProviders = async () => ApiProvider.find().sort({ name: 1 });

const syncAllProviders = async () => {
  // eslint-disable-next-line global-require
  const diamondSync = require('./diamondSync.service');
  // eslint-disable-next-line global-require
  if (require('./diamond.client').isConfigured()) {
    await diamondSync.syncNow(); // real refresh; its provider row updates itself
    return listProviders();
  }
  const providers = await ApiProvider.find();
  await Promise.all(
    providers.map((provider) =>
      ApiProvider.updateOne(
        { _id: provider._id },
        { $set: { status: 'Connected', healthy: true, lastSyncAt: new Date() } },
      ),
    ),
  );
  return listProviders();
};

module.exports = { listMatches, listProviders, syncAllProviders };
