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
const {
  getTrend,
  getStations,
  getBrands,
  getHeatmap,
} = require('../controllers/metrics.controller');
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
router.get('/:id/metrics/trend', getTrend);
router.get('/:id/metrics/stations', getStations);
router.get('/:id/metrics/brands', getBrands);
router.get('/:id/metrics/heatmap', getHeatmap);

module.exports = router;
