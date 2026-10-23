const { Router } = require('express');
const { query } = require('express-validator');
const analyticsController = require('../controllers/analytics.controller');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');

const router = Router();
router.use(authenticate, authorize('super-admin'));

router.get(
  '/series',
  [query('dimension').isIn(['revenue', 'users', 'sports', 'commission'])],
  validate,
  analyticsController.series,
);
router.get('/highlights', analyticsController.highlights);
router.get('/growth', analyticsController.growth);

module.exports = router;
