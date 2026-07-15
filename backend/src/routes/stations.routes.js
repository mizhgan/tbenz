const { Router } = require('express');
const {
  listStations,
  getStation,
  updateStationDetails,
  getStationHistory,
  getForecast,
  getStationReliability,
} = require('../controllers/stations.controller');
const { requireAuth, requireAdmin } = require('../middleware/auth.middleware');

const router = Router();

// Public (map/reports pages) - getStation already strips its own
// admin/internal-only fields unconditionally (see stations.controller.js),
// so no optionalAuth branching is needed here unlike regions.routes.js.
router.get('/', listStations);
router.get('/:id', getStation);
router.get('/:id/history', getStationHistory);
router.get('/:id/forecast', getForecast);
router.get('/:id/reliability', getStationReliability);

router.put('/:id', requireAuth, requireAdmin, updateStationDetails);

module.exports = router;
