const { Router } = require('express');
const authRoutes = require('./auth.routes');
const regionsRoutes = require('./regions.routes');
const stationsRoutes = require('./stations.routes');
const usersRoutes = require('./users.routes');

const router = Router();

router.get('/health', (req, res) => res.json({ ok: true }));
router.use('/auth', authRoutes);
router.use('/regions', regionsRoutes);
router.use('/stations', stationsRoutes);
router.use('/users', usersRoutes);

module.exports = router;
