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
const { requireAuth, requireAdmin, optionalAuth } = require('../middleware/auth.middleware');

const router = Router();

// Public (map/reports pages) - listRegions/getRegion trim operational
// fields (poll status, error text, source URLs) for an anonymous caller;
// optionalAuth lets them see the full set they already get today, unchanged
// (see regions.controller.js's PUBLIC_REGION_EXCLUDE).
router.get('/', optionalAuth, listRegions);
router.get('/:id', optionalAuth, getRegion);
router.get('/:id/history-range', getHistoryRange);
router.get('/:id/snapshot-times', getSnapshotTimes);
router.get('/:id/snapshot', getRegionSnapshot);
router.get('/:id/metrics/trend', getTrend);
router.get('/:id/metrics/stations', getStations);
router.get('/:id/metrics/brands', getBrands);
router.get('/:id/metrics/heatmap', getHeatmap);
router.get('/:id/metrics/trend-forecast', getTrendForecast);

// Operationally sensitive (proxy failures, scraper URLs, raw third-party
// responses) - stays behind a login, any role.
router.get('/:id/poll-stats', requireAuth, getPollStats);
router.get('/:id/poll-logs', requireAuth, getPollLogs);
router.get('/:id/raw-response', requireAuth, getRawResponse);

// Mutating endpoints - admins only.
router.post('/', requireAuth, requireAdmin, createRegion);
router.put('/:id', requireAuth, requireAdmin, updateRegion);
router.delete('/:id', requireAuth, requireAdmin, deleteRegion);
router.post('/:id/poll', requireAuth, requireAdmin, pollRegionNow);

module.exports = router;
