const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const AdminUser = require('../models/AdminUser');
const { jwtSecret, jwtExpiresIn, adminUsername, adminPassword } = require('../config/env');
const logger = require('../utils/logger');

async function ensureSeedAdmin() {
  const existing = await AdminUser.findOne({ username: adminUsername });
  if (existing) return;
  const passwordHash = await bcrypt.hash(adminPassword, 10);
  await AdminUser.create({ username: adminUsername, passwordHash });
  logger.info(`Seeded admin user "${adminUsername}" (set ADMIN_USERNAME/ADMIN_PASSWORD to change)`);
}

async function login(username, password) {
  const user = await AdminUser.findOne({ username });
  if (!user) return null;
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return null;
  const token = jwt.sign({ sub: user._id.toString(), username: user.username }, jwtSecret, {
    expiresIn: jwtExpiresIn,
  });
  return { token, user: { id: user._id, username: user.username } };
}

function verifyToken(token) {
  return jwt.verify(token, jwtSecret);
}

module.exports = { ensureSeedAdmin, login, verifyToken };
