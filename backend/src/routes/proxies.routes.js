const { Router } = require('express');
const {
  listProxies,
  createProxy,
  updateProxy,
  deleteProxy,
  checkProxy,
  importProxies,
} = require('../controllers/proxies.controller');
const { requireAuth, requireAdmin } = require('../middleware/auth.middleware');

const router = Router();
router.use(requireAuth, requireAdmin);

router.get('/', listProxies);
router.post('/', createProxy);
router.post('/import', importProxies);
router.put('/:id', updateProxy);
router.delete('/:id', deleteProxy);
router.post('/:id/check', checkProxy);

module.exports = router;
