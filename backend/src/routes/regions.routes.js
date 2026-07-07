const { Router } = require('express');
const {
  listRegions,
  getRegion,
  createRegion,
  updateRegion,
  deleteRegion,
  pollRegionNow,
  getHistoryRange,
  getSnapshotTimes,
  getRegionSnapshot,
} = require('../controllers/regions.controller');
const { requireAuth } = require('../middleware/auth.middleware');

const router = Router();
router.use(requireAuth);

router.get('/', listRegions);
router.post('/', createRegion);
router.get('/:id', getRegion);
router.put('/:id', updateRegion);
router.delete('/:id', deleteRegion);
router.post('/:id/poll', pollRegionNow);
router.get('/:id/history-range', getHistoryRange);
router.get('/:id/snapshot-times', getSnapshotTimes);
router.get('/:id/snapshot', getRegionSnapshot);

module.exports = router;
