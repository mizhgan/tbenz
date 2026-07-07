require('dotenv').config();

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

module.exports = {
  port: Number(process.env.PORT || 4000),
  mongoUri: required('MONGO_URI', 'mongodb://localhost:27017/gas-station-tracker'),
  jwtSecret: required('JWT_SECRET', 'dev-secret-change-me'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
  tbankApiBaseUrl: process.env.TBANK_API_BASE_URL || 'https://toplivo.tbank.ru/api/v1/stations',
  minPollIntervalMinutes: Number(process.env.MIN_POLL_INTERVAL_MINUTES || 1),
  corsOrigin: process.env.CORS_ORIGIN || '*',
};
