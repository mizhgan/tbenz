const bcrypt = require('bcryptjs');
const asyncHandler = require('../utils/asyncHandler');
const { HttpError } = require('../middleware/errorHandler');
const User = require('../models/User');

function serializeUser(u) {
  return { id: u._id, username: u.username, role: u.role, createdAt: u.createdAt };
}

async function countAdmins(excludeId) {
  const query = { role: 'admin' };
  if (excludeId) query._id = { $ne: excludeId };
  return User.countDocuments(query);
}

const listUsers = asyncHandler(async (req, res) => {
  const users = await User.find().sort({ createdAt: 1 });
  res.json(users.map(serializeUser));
});

const createUser = asyncHandler(async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !String(username).trim()) {
    throw new HttpError(400, 'username is required');
  }
  if (!password || String(password).length < 6) {
    throw new HttpError(400, 'password must be at least 6 characters');
  }
  if (!User.ROLES.includes(role)) {
    throw new HttpError(400, `role must be one of: ${User.ROLES.join(', ')}`);
  }

  const trimmedUsername = String(username).trim();
  const existing = await User.findOne({ username: trimmedUsername });
  if (existing) {
    throw new HttpError(409, 'A user with this username already exists');
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ username: trimmedUsername, passwordHash, role });
  res.status(201).json(serializeUser(user));
});

const updateUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw new HttpError(404, 'User not found');

  const { role, password } = req.body || {};

  if (role !== undefined) {
    if (!User.ROLES.includes(role)) {
      throw new HttpError(400, `role must be one of: ${User.ROLES.join(', ')}`);
    }
    if (user.role === 'admin' && role !== 'admin') {
      const remainingAdmins = await countAdmins(user._id);
      if (remainingAdmins === 0) {
        throw new HttpError(400, 'Cannot demote the last remaining admin');
      }
    }
    user.role = role;
  }

  if (password !== undefined && password !== '') {
    if (String(password).length < 6) {
      throw new HttpError(400, 'password must be at least 6 characters');
    }
    user.passwordHash = await bcrypt.hash(password, 10);
  }

  await user.save();
  res.json(serializeUser(user));
});

const deleteUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw new HttpError(404, 'User not found');

  if (String(user._id) === String(req.user.sub)) {
    throw new HttpError(400, 'Cannot delete your own account');
  }
  if (user.role === 'admin') {
    const remainingAdmins = await countAdmins(user._id);
    if (remainingAdmins === 0) {
      throw new HttpError(400, 'Cannot delete the last remaining admin');
    }
  }

  await user.deleteOne();
  res.status(204).end();
});

module.exports = { listUsers, createUser, updateUser, deleteUser };
