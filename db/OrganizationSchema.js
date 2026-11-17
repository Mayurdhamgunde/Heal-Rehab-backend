const mongoose = require("mongoose");
const { Schema } = mongoose;

const organizationSchema = new Schema(
  {
    tenant_id: { type: String, required: true, unique: true },
    organization_name: { type: String, required: true },
    organization_employees: String,
    organization_logo: String,
    organization_banner: String,
    organization_email: { type: String, required: true },
    organization_phone: { type: String, required: true },
    database_name: String,
    admin_email: String,

    // Address fields as an object structure
    organization_address: {
      street: String,
      city: String,
      state: String,
      zip: String,
      country: String,
    },

    // Organization locations array - Updated to match frontend interface
    organization_locations: [
      {
        id: { type: String, required: true },
        name: { type: String, required: true },
        locationId: { type: String, required: true },
        street: { type: String },
        city: { type: String },
        state: { type: String },
        pincode: { type: String },
        country: { type: String },
        addressLink: { type: String }, // Optional field for map links
        createdAt: { type: Date, default: Date.now },
        updatedAt: { type: Date, default: Date.now },
      },
    ],

    // Organization heads array — individuals who lead the org but may not be system users
    organization_heads: [
      {
        name: { type: String },
        degree: { type: String },
        reg_no: { type: String },
      },
    ],
    medicalProfessional: [
      {
        name: { type: String },
      },
    ],
    // Additional fields
    organization_website: String,
    organization_description: String,
    organization_tax_id: String,
    organization_founded_year: String,
    organization_industry: String,
    organization_size: String,
    organization_timezone: String,
    organization_operating_hours: String,

    // Social media as an object
    organization_social_media: {
      instagram: String,
      facebook: String,
      youtube: String,
      twitter: String,
      linkedin: String,
    },

    // YouTube videos array
    youtube_videos: [
      {
        id: String,
        title: String,
        url: String,
        description: String,
      },
    ],
  },
  { timestamps: true },
);

// Create indexes for frequently queried fields
organizationSchema.index({ tenant_id: 1 });
organizationSchema.index({ organization_email: 1 });
organizationSchema.index({ organization_phone: 1 });
organizationSchema.index({ "organization_locations.locationId": 1 });

const orgsDb = mongoose.connection.useDb("organizations");
const Organization = orgsDb.model("Organization", organizationSchema, "orgs");

module.exports = Organization;
