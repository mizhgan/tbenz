const { Router } = require('express');
const { listStations, getStation, getStationHistory, getForecast } = require('../controllers/stations.controller');
const { requireAuth } = require('../middleware/auth.middleware');

const router = Router();
router.use(requireAuth);

router.get('/', listStations);
router.get('/:id', getStation);
router.get('/:id/history', getStationHistory);
router.get('/:id/forecast', getForecast);

module.exports = router;
