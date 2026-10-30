const asyncHandler = require('../utils/asyncHandler');
const notificationService = require('../services/notification.service');

const list = asyncHandler(async (req, res) => {
  const { items, unreadCount } = await notificationService.listNotifications({
    recipientRole: req.user.role,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
    user: req.user,
  });
  res.json({ notifications: items, unreadCount });
});

const readAll = asyncHandler(async (req, res) => {
  const { items, unreadCount } = await notificationService.markAllRead({ recipientRole: req.user.role, user: req.user });
  res.json({ notifications: items, unreadCount });
});

const clear = asyncHandler(async (req, res) => {
  await notificationService.clearAll({ recipientRole: req.user.role });
  res.json({ success: true });
});

module.exports = { list, readAll, clear };
