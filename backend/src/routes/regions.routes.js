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
  getPollStats,
  getPollLogs,
  getRawResponse,
} = require('../controllers/regions.controller');
const {
  getTrend,
  getStations,
  getBrands,
  getHeatmap,
  getTrendForecast,
} = require('../controllers/metrics.controller');
const { requireAuth, requireAdmin } = require('../middleware/auth.middleware');

const router = Router();
router.use(requireAuth);

// Read-only endpoints - available to any authenticated user (admin or viewer).
router.get('/', listRegions);
router.get('/:id', getRegion);

// Mutating endpoints - admins only.
router.post('/', requireAdmin, createRegion);
router.put('/:id', requireAdmin, updateRegion);
router.delete('/:id', requireAdmin, deleteRegion);
router.post('/:id/poll', requireAdmin, pollRegionNow);
router.get('/:id/history-range', getHistoryRange);
router.get('/:id/snapshot-times', getSnapshotTimes);
router.get('/:id/snapshot', getRegionSnapshot);
router.get('/:id/poll-stats', getPollStats);
router.get('/:id/poll-logs', getPollLogs);
router.get('/:id/raw-response', getRawResponse);
router.get('/:id/metrics/trend', getTrend);
router.get('/:id/metrics/stations', getStations);
router.get('/:id/metrics/brands', getBrands);
router.get('/:id/metrics/heatmap', getHeatmap);
router.get('/:id/metrics/trend-forecast', getTrendForecast);

module.exports = router;
