const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const { port, corsOrigin } = require('./config/env');
const { connectDb } = require('./db/mongoose');
const routes = require('./routes');
const { errorHandler } = require('./middleware/errorHandler');
const { ensureSeedAdmin } = require('./services/authService');
const scheduler = require('./services/scheduler');
const logger = require('./utils/logger');

async function main() {
  await connectDb();
  await ensureSeedAdmin();
  await scheduler.start();

  const app = express();
  app.use(helmet());
  app.use(cors({ origin: corsOrigin }));
  app.use(express.json({ limit: '2mb' }));
  app.use(morgan('tiny'));

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
  process.exit(0);
});
