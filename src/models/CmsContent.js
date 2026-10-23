const mongoose = require('mongoose');
const { CMS_KINDS, CMS_STATUSES } = require('../constants/admin');

const { Schema } = mongoose;

/** Announcements, banners, promotions and notices shown in-app; the marquee ticker itself lives on Settings.cms. */
const cmsContentSchema = new Schema(
  {
    kind: { type: String, enum: CMS_KINDS, required: true, index: true },
    status: { type: String, enum: CMS_STATUSES, default: 'Draft', index: true },
    target: { type: String, trim: true, default: 'All' },
    title: { type: String, required: true, trim: true },
    body: { type: String, trim: true, default: '' },
    /** Banners: the picture shown in the app's home carousel (https URL). */
    imageUrl: { type: String, trim: true, default: '' },
    /** Banners: where a tap goes — an app screen ("deposit", "referral", …) or an https URL. */
    link: { type: String, trim: true, default: '' },
    views: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model('CmsContent', cmsContentSchema);
