const { Router } = require('express');
const { listCollections, queryCollection } = require('../controllers/rawData.controller');
const { requireAuth, requireAdmin } = require('../middleware/auth.middleware');

const router = Router();
router.use(requireAuth, requireAdmin);

router.get('/collections', listCollections);
router.get('/:collection', queryCollection);

module.exports = router;
