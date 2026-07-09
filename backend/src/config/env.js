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
  proxyFailureThreshold: Number(process.env.PROXY_FAILURE_THRESHOLD || 3),
  proxyRequestTimeoutMs: Number(process.env.PROXY_REQUEST_TIMEOUT_MS || 20000),
  proxyCheckUrl: process.env.PROXY_CHECK_URL || 'https://toplivo.tbank.ru/api/v1/stations',
  // Telegram bot is entirely optional - if unset, the feature is inert (no
  // bot process starts, admin panel just shows it as "not configured").
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || null,
  // gdebenz.ru is a second, independent fuel-availability source, ingested
  // alongside tbank per region (same bbox). No API key in its URL - it's a
  // public endpoint - so this is "off" only if explicitly disabled, unlike
  // the other optional integrations above which are off by default.
  gdebenzApiBaseUrl: process.env.GDEBENZ_API_BASE_URL || 'https://gdebenz.ru/api/stations',
  gdebenzEnabled: process.env.GDEBENZ_ENABLED !== 'false',
};
