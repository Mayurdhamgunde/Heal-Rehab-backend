const mongoose = require("mongoose");
const { Schema } = mongoose;
const { ObjectId } = mongoose.Types;

const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    tenant_id: {
      type: String,
      required: true,
      index: true,
    },
    doctor_id: {
      type: ObjectId,
      required: true,
    },
    refresh_token: {
      type: String,
    },
    last_login: {
      type: Date,
      default: Date.now,
    },
    auth_provider: {
      type: String,
      enum: ["jwt", "google", "other"],
      default: "jwt",
    },
    password: String,
    superAdmin: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: ["active", "inactive", "suspended"],
      default: "active",
    },
  },
  { timestamps: true }
);

// Create indexes for frequently queried fields
userSchema.index({ email: 1 });
userSchema.index({ tenant_id: 1 });

const usersDb = mongoose.connection.useDb("users");
const User = usersDb.model("User", userSchema, "users");

module.exports = User;
