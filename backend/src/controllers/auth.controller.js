const asyncHandler = require('../utils/asyncHandler');
const { login } = require('../services/authService');
const { HttpError } = require('../middleware/errorHandler');

const postLogin = asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    throw new HttpError(400, 'username and password are required');
  }
  const result = await login(username, password);
  if (!result) {
    throw new HttpError(401, 'Invalid credentials');
  }
  res.json(result);
});

const getMe = asyncHandler(async (req, res) => {
  res.json({ user: { id: req.user.sub, username: req.user.username } });
});

module.exports = { postLogin, getMe };
