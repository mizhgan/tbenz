const { Schema, model } = require('mongoose');

const adminUserSchema = new Schema(
  {
    username: { type: String, required: true, unique: true, trim: true },
    passwordHash: { type: String, required: true },
  },
  { timestamps: true }
);

module.exports = model('AdminUser', adminUserSchema);
