const mongoose = require("mongoose");
const { Schema } = mongoose;

const educationSchema = new Schema({
  degree: { type: String, required: true },
  speciality: { type: String, required: true },
  super_speciality: { type: String },
  pass_out_year: { type: Number },
  university: { type: String },
  location: { type: String },
});

const experienceSchema = new Schema({
  years_of_experience: { type: Number },
  clinic_hospital_name: { type: String },
  designation: { type: String },
  start_date: Date,
  end_date: Date,
  is_current: { type: Boolean, default: false },
});

const referenceSchema = new Schema({
  ref_name: { type: String },
  ref_email: { type: String },
  ref_contact_no: { type: String },
  ref_profession: { type: String },
});

const professionalProfileSchema = new Schema({
  // Link to your auth user if they already exist
  user_id: { type: Schema.Types.ObjectId, ref: "User" },

  // --- Personal Information ---
  prefix: { type: String, enum: ["Dr.", "Mr.", "Ms.", "Mrs."] },
  first_name: { type: String, required: true },
  middle_name: { type: String },
  last_name: { type: String, required: true },
  mobile_number: { type: String, required: true, index: true },
  alternate_mobile_number: { type: String },
  email: { type: String, required: true, lowercase: true, index: true },
  date_of_birth: { type: Date },
  gender: { type: String, enum: ["Male", "Female", "Other"] },

  // --- Location Details ---
  current_location_pincode: { type: String, required: true, index: true },
  post: { type: String },
  mandal_taluka: { type: String },
  address_line1: { type: String },
  address_line2: { type: String },
  city_district: { type: String, index: true },
  state: { type: String },

  // --- Professional Availability (For Hiring) ---
  open_for_consultation: { type: Boolean, default: false },
  open_for_duty_doctorship: { type: Boolean, default: false, index: true },
  open_for_shift: { type: Boolean, default: false },
  // ADD THIS LINE:
  shift_preference: { type: String, enum: ["Day", "Night", "Both"], default: null },
  available_days: [
    {
      type: String,
      enum: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    },
  ],

  // --- Licensing & Current Work ---
  doctor_license_no: { type: String, required: true, unique: true },
  current_clinic_hospital_name: { type: String },

  // --- Education & Experience ---
  is_fresher: { type: Boolean, default: false }, // <--- ADDED FIELD
  education: [educationSchema],
  experience: [experienceSchema],

  // --- References ---
  references: [referenceSchema],

  // --- Documents (Azure Blob URLs) ---
  profile_pic_url: { type: String, required: true },
  resume_url: { type: String, required: true },

  // --- Approval/Review Fields ---
  approval_status: {
    type: String,
    enum: ["pending", "approved", "rejected"],
    default: "pending",
    index: true,
  },
  reviewed_by: { type: Schema.Types.ObjectId },
  reviewed_at: { type: Date },
  review_remarks: { type: String },

  // --- Meta ---
  is_verified: { type: Boolean, default: false },
  status: {
    type: String,
    enum: ["Active", "Hired", "Inactive"],
    default: "Active",
  },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

// Create text index for search functionality
professionalProfileSchema.index({
  first_name: "text",
  last_name: "text",
  "education.speciality": "text",
  city_district: "text",
});

// Pre-save middleware to update timestamps
professionalProfileSchema.pre("save", function (next) {
  this.updated_at = Date.now();
  next();
});

// Export model
module.exports = {
  getProfessionalProfileModel: function (connection) {
    return connection.model(
      "ProfessionalProfile",
      professionalProfileSchema,
      "professional_profiles"
    );
  },
  professionalProfileSchema,
};