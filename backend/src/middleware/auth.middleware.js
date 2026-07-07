const { verifyToken } = require('../services/authService');
const { HttpError } = require('./errorHandler');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return next(new HttpError(401, 'Missing or invalid Authorization header'));
  }
  try {
    req.user = verifyToken(token);
    return next();
  } catch (err) {
    return next(new HttpError(401, 'Invalid or expired token'));
  }
}

// Must run after requireAuth (relies on req.user being set).
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return next(new HttpError(403, 'Admin role required'));
  }
  return next();
}

module.exports = { requireAuth, requireAdmin };
