const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { jwtSecret, jwtExpiresIn, adminUsername, adminPassword } = require('../config/env');
const logger = require('../utils/logger');

async function ensureSeedAdmin() {
  const existing = await User.findOne({ username: adminUsername });
  if (existing) return;
  const passwordHash = await bcrypt.hash(adminPassword, 10);
  await User.create({ username: adminUsername, passwordHash, role: 'admin' });
  logger.info(`Seeded admin user "${adminUsername}" (set ADMIN_USERNAME/ADMIN_PASSWORD to change)`);
}

async function login(username, password) {
  const user = await User.findOne({ username });
  if (!user) return null;
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return null;
  const token = jwt.sign(
    { sub: user._id.toString(), username: user.username, role: user.role },
    jwtSecret,
    { expiresIn: jwtExpiresIn }
  );
  return { token, user: { id: user._id, username: user.username, role: user.role } };
}

function verifyToken(token) {
  return jwt.verify(token, jwtSecret);
}

module.exports = { ensureSeedAdmin, login, verifyToken };
