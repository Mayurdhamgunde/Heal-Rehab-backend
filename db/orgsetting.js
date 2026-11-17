// db/OrganizationSchema.js
const mongoose = require("mongoose");

const organizationSettingsSchema = new mongoose.Schema({
  tenant_id: {
    type: String,
    required: true,
    unique: true,
  },
  access_token: {
    type: String,
    required: true,
  },
  google_calendar_refresh_token: {
    type: String,
    required: true,
  },
  last_updated: {
    type: Date,
    default: Date.now,
  },
  updated_by: {
    type: String,
    required: true,
  },
});

// This is the function that's missing in your original code
const getOrgSettingsModel = (db) => {
  return db.model(
    "OrganizationSettings",
    organizationSettingsSchema,
    "organization_settings"
  );
};

module.exports = { getOrgSettingsModel };
