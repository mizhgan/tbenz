const { Router } = require('express');
const {
  listSourceOptions,
  listUnmatched,
  listMatched,
  confirmMatch,
  ignoreSecondary,
  unmatch,
  suggestForStation,
} = require('../controllers/stationMatching.controller');
const { requireAuth, requireAdmin } = require('../middleware/auth.middleware');

const router = Router();
router.use(requireAuth, requireAdmin);

router.get('/sources', listSourceOptions);

// Parameterized by :sourceKey (see services/sourceRegistry.js) instead of
// being hardcoded to gdebenz - adding a source #3 to the registry makes it
// reachable at these same routes with no route/controller changes.
router.get('/:sourceKey/unmatched', listUnmatched);
router.get('/:sourceKey/matched', listMatched);
router.get('/:sourceKey/for-station/:stationId/candidates', suggestForStation);
router.post('/:sourceKey/:id/match', confirmMatch);
router.post('/:sourceKey/:id/ignore', ignoreSecondary);
router.post('/:sourceKey/:id/unmatch', unmatch);

module.exports = router;
