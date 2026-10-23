const CmsContent = require('../models/CmsContent');
const Settings = require('../models/Settings');
const ApiError = require('../utils/ApiError');
const { reloadCache } = require('./settings.service');

/** Published content / the marquee changed: apps and panels refetch /api/app-config. */
const changed = () => require('../realtime').emitConfigChanged(); // eslint-disable-line global-require

const listContent = async ({ kind }) => {
  const filter = {};
  if (kind) filter.kind = kind;
  return CmsContent.find(filter).sort({ createdAt: -1 });
};

const createContent = async ({ actor, ...data }) => {
  const content = await CmsContent.create({ ...data, createdBy: actor._id });
  changed();
  return content;
};

/** Fields an edit may change; `views` is counted from the app and `kind` is fixed at creation. */
const EDITABLE = ['title', 'body', 'status', 'target', 'imageUrl', 'link'];

const updateContent = async (id, updates) => {
  const allowed = Object.fromEntries(EDITABLE.filter((key) => updates[key] !== undefined).map((key) => [key, updates[key]]));
  const content = await CmsContent.findByIdAndUpdate(id, allowed, { new: true, runValidators: true });
  if (!content) throw ApiError.notFound('CMS content not found');
  changed();
  return content;
};

const deleteContent = async (id) => {
  const content = await CmsContent.findByIdAndDelete(id);
  if (!content) throw ApiError.notFound('CMS content not found');
  changed();
};

const getMarquee = async () => {
  const settings = await Settings.findByIdAndUpdate(
    'main',
    { $setOnInsert: { _id: 'main' } },
    { new: true, upsert: true },
  );
  return settings.cms?.marqueeText || '';
};

const setMarquee = async (marqueeText) => {
  const settings = await Settings.findByIdAndUpdate(
    'main',
    { $set: { 'cms.marqueeText': marqueeText } },
    { new: true, upsert: true },
  );
  await reloadCache();
  changed();
  return settings.cms?.marqueeText || '';
};

module.exports = { listContent, createContent, updateContent, deleteContent, getMarquee, setMarquee };
