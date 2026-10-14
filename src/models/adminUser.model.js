'use strict';
/**
 * src/models/adminUser.model.js
 * A single store admin. No roles, no permissions — the spec calls for exactly
 * one login, created by `node seedAdmin.js` from .env values. There is
 * deliberately NO public register endpoint: a jewellery storefront has no
 * reason to expose admin signup to the internet.
 *
 * `passwordHash` is `select: false`, so it is never loaded by an ordinary query
 * and cannot be serialised into a response by accident. Login explicitly asks
 * for it with .select('+passwordHash').
 */
const mongoose = require('mongoose');
const { Schema } = mongoose;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const adminUserSchema = new Schema(
  {
    email: {
      type: String,
      required: [true, 'Admin email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [EMAIL_PATTERN, 'Enter a valid email address'],
    },
    passwordHash: { type: String, required: true, select: false },
    name: { type: String, trim: true, default: 'Store Admin' },
    lastLoginAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform(doc, ret) {
        delete ret.passwordHash;
        return ret;
      },
    },
  }
);
module.exports = mongoose.model('AdminUser', adminUserSchema);
module.exports.EMAIL_PATTERN = EMAIL_PATTERN;
