const { Router } = require('express');
const {
  listCollections,
  queryCollection,
  findDuplicateStations,
} = require('../controllers/rawData.controller');
const { requireAuth, requireAdmin } = require('../middleware/auth.middleware');

const router = Router();
router.use(requireAuth, requireAdmin);

router.get('/collections', listCollections);
// Must come before the generic '/:collection' route below, or it would be
// swallowed as a (nonexistent) collection name.
router.get('/duplicate-stations', findDuplicateStations);
router.get('/:collection', queryCollection);

module.exports = router;
