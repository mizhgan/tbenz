const { verifyToken } = require('../services/authService');
const { HttpError } = require('./errorHandler');
const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');

// Re-checks the token's subject against the DB on every request rather than
// trusting the role embedded in the JWT payload. This keeps role changes
// (and account deletions) effective immediately instead of only at the next
// login, and it also means tokens minted before the role field existed
// (payload has no `role`, or `sub` refers to an id from the pre-rename
// `adminusers` collection) are rejected as invalid rather than silently
// treated as a non-admin.
const requireAuth = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return next(new HttpError(401, 'Missing or invalid Authorization header'));
  }
  let payload;
  try {
    payload = verifyToken(token);
  } catch (err) {
    return next(new HttpError(401, 'Invalid or expired token'));
  }
  const user = await User.findById(payload.sub).select('username role');
  if (!user) {
    return next(new HttpError(401, 'Invalid or expired token'));
  }
  req.user = { sub: user._id.toString(), username: user.username, role: user.role };
  return next();
});

// For routes public visitors can reach but that show more to a logged-in
// caller (see regions.controller.js's listRegions/getRegion, which return
// fewer fields when req.user is unset) - same token verification as
// requireAuth, but a missing/invalid/expired token means "anonymous", not
// a rejected request. Never rejects on its own; a route that actually needs
// a specific role still adds requireAdmin (or requireAuth) after it.
const optionalAuth = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return next();

  try {
    const payload = verifyToken(token);
    const user = await User.findById(payload.sub).select('username role');
    if (user) req.user = { sub: user._id.toString(), username: user.username, role: user.role };
  } catch (err) {
    // Invalid/expired token on an optional-auth route - treat as anonymous
    // rather than erroring, unlike requireAuth.
  }
  return next();
});

// Must run after requireAuth (relies on req.user being set).
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return next(new HttpError(403, 'Admin role required'));
  }
  return next();
}

module.exports = { requireAuth, requireAdmin, optionalAuth };
