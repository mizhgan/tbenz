const { Schema, model } = require('mongoose');

const ROLES = ['admin', 'viewer'];

const userSchema = new Schema(
  {
    username: { type: String, required: true, unique: true, trim: true },
    passwordHash: { type: String, required: true },
    // admin: full access, including managing regions and users.
    // viewer: read-only access to data/analytics (map, reports, stations).
    role: { type: String, enum: ROLES, default: 'viewer', required: true },
  },
  { timestamps: true }
);

const User = model('User', userSchema);
User.ROLES = ROLES;

module.exports = User;
