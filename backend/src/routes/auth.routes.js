const { Router } = require('express');
const { postLogin, getMe } = require('../controllers/auth.controller');
const { requireAuth } = require('../middleware/auth.middleware');

const router = Router();

router.post('/login', postLogin);
router.get('/me', requireAuth, getMe);

module.exports = router;
