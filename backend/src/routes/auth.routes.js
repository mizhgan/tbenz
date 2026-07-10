const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const { postLogin, getMe } = require('../controllers/auth.controller');
const { requireAuth } = require('../middleware/auth.middleware');

const router = Router();

// Login had zero brute-force protection - fine while the whole app sat
// behind a login wall nobody could reach without already knowing it
// existed, not once the domain is public. Keyed per-IP by default (express
// -rate-limit reads req.ip, which respects `trust proxy` - see index.js);
// skipSuccessfulRequests so a legitimate user who mistypes their password
// once isn't penalized once they get it right.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Слишком много попыток входа, попробуйте позже' },
});

router.post('/login', loginLimiter, postLogin);
router.get('/me', requireAuth, getMe);

module.exports = router;
