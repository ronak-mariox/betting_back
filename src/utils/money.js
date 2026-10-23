const { currency } = require('../services/settings.service');

/** An amount in the platform's currency (Settings → General): "₹1,250" — whole units, sign dropped. */
const money = (amount) => `${currency().symbol}${Math.round(Math.abs(Number(amount) || 0)).toLocaleString('en-IN')}`;

module.exports = { money };
