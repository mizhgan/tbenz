const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const parseObjectIdParam = require('../src/utils/parseObjectIdParam');

test('parseObjectIdParam: a valid 24-char hex id parses to an ObjectId equal to the input', () => {
  const id = new mongoose.Types.ObjectId().toString();
  const result = parseObjectIdParam({ params: { id } }, 'id');
  assert.equal(result.toString(), id);
});

test('parseObjectIdParam: a malformed id throws an HttpError(400), not a raw BSONError', () => {
  assert.throws(
    () => parseObjectIdParam({ params: { id: 'not-an-id' } }, 'id'),
    (err) => err.status === 400
  );
});

test('parseObjectIdParam: a missing param throws an HttpError(400) instead of constructing a garbage ObjectId', () => {
  assert.throws(
    () => parseObjectIdParam({ params: {} }, 'id'),
    (err) => err.status === 400
  );
});

test('parseObjectIdParam: reads whichever param name is passed, not always "id"', () => {
  const id = new mongoose.Types.ObjectId().toString();
  const result = parseObjectIdParam({ params: { regionId: id } }, 'regionId');
  assert.equal(result.toString(), id);
});
