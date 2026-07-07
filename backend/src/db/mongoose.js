const mongoose = require('mongoose');
const { mongoUri } = require('../config/env');
const logger = require('../utils/logger');

async function connectDb() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(mongoUri);
  logger.info('Connected to MongoDB:', mongoUri.replace(/\/\/[^@]+@/, '//***@'));
  return mongoose.connection;
}

module.exports = { connectDb, mongoose };
