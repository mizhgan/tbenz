const { Router } = require('express');
const {
  listUnmatched,
  listMatched,
  confirmMatch,
  ignoreGdebenzStation,
  unmatch,
  suggestForStation,
} = require('../controllers/stationMatching.controller');
const { requireAuth, requireAdmin } = require('../middleware/auth.middleware');

const router = Router();
router.use(requireAuth, requireAdmin);

router.get('/unmatched', listUnmatched);
router.get('/matched', listMatched);
router.get('/for-station/:stationId/candidates', suggestForStation);
router.post('/:id/match', confirmMatch);
router.post('/:id/ignore', ignoreGdebenzStation);
router.post('/:id/unmatch', unmatch);

module.exports = router;
