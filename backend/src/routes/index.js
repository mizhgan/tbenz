const { Router } = require('express');
const authRoutes = require('./auth.routes');
const regionsRoutes = require('./regions.routes');
const stationsRoutes = require('./stations.routes');
const usersRoutes = require('./users.routes');
const proxiesRoutes = require('./proxies.routes');
const telegramRoutes = require('./telegram.routes');
const stationMatchingRoutes = require('./stationMatching.routes');

const router = Router();

router.get('/health', (req, res) => res.json({ ok: true }));
router.use('/auth', authRoutes);
router.use('/regions', regionsRoutes);
router.use('/stations', stationsRoutes);
router.use('/users', usersRoutes);
router.use('/proxies', proxiesRoutes);
router.use('/telegram', telegramRoutes);
router.use('/station-matching', stationMatchingRoutes);

module.exports = router;
