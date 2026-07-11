const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const compression = require('compression');

const { port, corsOrigin } = require('./config/env');
const { connectDb } = require('./db/mongoose');
const routes = require('./routes');
const { errorHandler } = require('./middleware/errorHandler');
const { ensureSeedAdmin } = require('./services/authService');
const scheduler = require('./services/scheduler');
const telegramBot = require('./services/telegramBot');
const telegramDigestScheduler = require('./services/telegramDigestScheduler');
const telegramPredictiveScheduler = require('./services/telegramPredictiveScheduler');
const browserFetchService = require('./services/browserFetchService');
const logger = require('./utils/logger');

async function main() {
  await connectDb();
  await ensureSeedAdmin();
  await scheduler.start();
  await telegramBot.start();
  telegramDigestScheduler.start();
  telegramPredictiveScheduler.start();

  const app = express();
  // Traffic arrives via nginx (see frontend/nginx.conf's proxy_set_header
  // X-Forwarded-For), not directly - without this, express-rate-limit (and
  // anything else reading req.ip) sees every request as coming from the
  // nginx container itself, one shared IP for all visitors.
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(compression());
  app.use(cors({ origin: corsOrigin }));
  app.use(express.json({ limit: '2mb' }));
  app.use(morgan('tiny'));

  // General abuse guard for the whole public API - generous enough for the
  // map's live-mode polling (see MapView.vue) plus normal browsing; the
  // stricter per-route login limiter (auth.routes.js) is what actually
  // matters for brute-force protection.
  app.use(
    '/api',
    rateLimit({
      windowMs: 60 * 1000,
      max: 120,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Слишком много запросов, попробуйте позже' },
    })
  );

  app.use('/api', routes);

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(errorHandler);

  app.listen(port, () => {
    logger.info(`Backend listening on port ${port}`);
  });
}

main().catch((err) => {
  logger.error('Fatal startup error:', err);
  process.exit(1);
});

process.on('SIGTERM', () => {
  scheduler.stopAll();
  telegramDigestScheduler.stop();
  telegramPredictiveScheduler.stop();
  telegramBot.stop();
  browserFetchService.closeBrowser().finally(() => process.exit(0));
});
