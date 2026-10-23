const { Router } = require('express');
const { body, param, query } = require('express-validator');
const cmsController = require('../controllers/cms.controller');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { CMS_KINDS, CMS_STATUSES, CMS_TARGETS } = require('../constants/admin');

const httpsUrl = (field) =>
  body(field)
    .optional({ checkFalsy: true })
    .trim()
    .matches(/^https?:\/\/\S+$/i)
    .withMessage('Image URL must start with http:// or https://');
const contentRules = [
  body('body').optional().isString(),
  body('status').optional().isIn(CMS_STATUSES),
  body('target').optional().isIn(CMS_TARGETS).withMessage(`Target must be one of ${CMS_TARGETS.join(', ')}`),
  httpsUrl('imageUrl'),
  body('link').optional().isString().trim().isLength({ max: 300 }),
];

const router = Router();
router.use(authenticate, authorize('super-admin'));

router.get('/marquee', cmsController.getMarquee);
router.patch('/marquee', [body('marqueeText').isString()], validate, cmsController.updateMarquee);

router.get('/', [query('kind').optional().isIn(CMS_KINDS)], validate, cmsController.list);

router.post(
  '/',
  [
    body('kind').isIn(CMS_KINDS),
    body('title').trim().notEmpty(),
    ...contentRules,
  ],
  validate,
  cmsController.create,
);

router.patch(
  '/:id',
  [param('id').isMongoId(), body('title').optional().trim().notEmpty(), ...contentRules],
  validate,
  cmsController.update,
);
router.delete('/:id', [param('id').isMongoId()], validate, cmsController.remove);

module.exports = router;
