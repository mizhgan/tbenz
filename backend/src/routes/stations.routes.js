const { Router } = require('express');
const { getStation, getStationHistory } = require('../controllers/stations.controller');
const { requireAuth } = require('../middleware/auth.middleware');

const router = Router();
router.use(requireAuth);

router.get('/:id', getStation);
router.get('/:id/history', getStationHistory);

module.exports = router;
