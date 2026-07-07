const { Router } = require('express');
const { listUsers, createUser, updateUser, deleteUser } = require('../controllers/users.controller');
const { requireAuth, requireAdmin } = require('../middleware/auth.middleware');

const router = Router();
router.use(requireAuth, requireAdmin);

router.get('/', listUsers);
router.post('/', createUser);
router.put('/:id', updateUser);
router.delete('/:id', deleteUser);

module.exports = router;
