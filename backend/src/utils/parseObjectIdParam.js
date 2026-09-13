const mongoose = require('mongoose');
const { HttpError } = require('../middleware/errorHandler');

// `new mongoose.Types.ObjectId(req.params.id)` on a malformed id throws a
// raw BSONError with no `.status`, so errorHandler.js's default (500 +
// logged stack) fires for what's actually bad client input, not a server
// fault. One shared helper instead of a try/catch at each of the 8 call
// sites that used to do this inline.
function parseObjectIdParam(req, paramName) {
  const value = req.params[paramName];
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new HttpError(400, `Invalid "${paramName}" id`);
  }
  return new mongoose.Types.ObjectId(value);
}

module.exports = parseObjectIdParam;
