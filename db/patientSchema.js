const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const patientSchema = new mongoose.Schema({
  patient_first_name: { type: String, required: true },
  patient_middle_name: { type: String },
  patient_image: { type: String },
  patient_last_name: { type: String, required: true },
  patient_email: { type: String, trim: true, lowercase: true },
  patient_phone: { type: String, required: true },

  guardian_relation: { type: String },
  guardian_phone: { type: String },

  guardian_relation_2: { type: String },
  guardian_phone_2: { type: String },

  patient_id: { type: String },
  patient_registration_date: { type: Date, default: Date.now },
  patient_address1: { type: String },
  patient_address2: { type: String },
  patient_age: { type: String },
  patient_alternate_number: { type: String },
  doctor_id: { type: ObjectId, ref: "Doctor", required: true },
  doctor_name: { type: String },
  referral_source: {
    type: String,
    enum: [
      "Social Media",
      "Ex Client",
      "Self",
      "Family",
      "Awareness Program",
      "Social Media",
      "walkin",
      "Doctor Reference",
      "Patient Reference",
      "Hospital Reference",
      "Other",
    ],
  },
  previous_patient_id: {
    type: ObjectId,
    ref: "Patient",
    default: null,
    index: true,
  },
  education: { type: String },
  caste: { type: String },
  occupation: { type: String },
  marital_status: { type: String },
  identity_card: {
    type: { type: String, enum: ["AADHAR", "PAN", "OTHER"] },
    number: { type: String },
  },
  annual_income: { type: String },
  treatment_days: { type: Number }, // <--- ADDED HERE
  prior_treatment: { type: String },
  referral_details: { type: String },
  date_of_birth: Date,
  gender: String,
  address: {
    street: String,
    city: String,
    state: String,
    zip: String,
    country: String,
  },
  emergency_contact: { name: String, relationship: String, phone: String },
  UHID: { type: String, index: true },
  insurance_information: {
    provider: String,
    policy_number: String,
    group_number: String,
  },
  location_name: { type: String },
  location_id: { type: String },
  therapy_plans: [{ type: ObjectId, ref: "TherapyPlan" }],
  therepys: [{ type: ObjectId, ref: "TherapySession" }],
  medical_history: [String],
  allergies: [String],
  medications: [String],
  notes: [String],
  appointments: [{ type: ObjectId, ref: "Appointment" }],
  status: {
    type: String,
    enum: ["Active", "Inactive", "Archived"],
    default: "Active",
  },
  documents: [
    {
      document_name: { type: String, required: true },
      document_url: { type: String, required: true },
      document_upload_date: { type: Date, default: Date.now },
      document_type: {
        type: String,
        enum: [
          "Medical Report",
          "Test Results",
          "Prescription",
          "Insurance",
          "Identity",
          "Other",
        ],
        default: "Other",
      },
      uploaded_by: { type: String },
      file_size: { type: Number },
      file_extension: { type: String },
    },
  ],
  witness_name: { type: String },
  witness_relationship: { type: String },
  witness_photo_url: { type: String },
  consent_details: {
    is_agreed: { type: Boolean, default: false },
    consent_date: { type: Date },
    form_type: { type: String, default: "High Risk Consent" },
    status: {
      type: String,
      enum: ["Active", "Revoked", "Archived"],
      default: "Active",
    },
  },
  consent_history: [
    {
      document_url: { type: String, required: true },
      uploaded_at: { type: Date, default: Date.now },
      uploaded_by_id: { type: ObjectId, ref: "Doctor" },
      uploaded_by_name: { type: String },
      notes: String,
    },
  ],
  care_team: [
    {
      department_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Department",
        required: true,
      },
      department_name: { type: String },
      doctor_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Doctor",
        required: true,
      },
      doctor_name: { type: String },
      role: {
        type: String,
        enum: ["Head Counselor", "Specialist"],
        default: "Specialist",
      },
    },
  ],
  patient_journey: [
    {
      stage: {
        type: String,
        enum: [
          "Registration",
          "Orientation",
          "Welcome",
          "Medical File",
          "Facilitation",
          "Counseling File",
          "Discharge Order",
          "Termination",
          "Medical Advise",
          "MRD",
          "Discharge Family",
          "Congratulation",
          "Assigned Care Team",
          "Completed First Assessment",
          "Treatment Plan Created",
          "Counselling Started",
          "Treatment Plan Completed",
          "Discharged",
        ],
        required: true,
      },
      performed_by_id: { type: mongoose.Schema.Types.ObjectId, ref: "Doctor" },
      performed_by_name: { type: String, required: true },
      performed_at: { type: Date, default: Date.now },
      notes: { type: String },
      status: {
        type: String,
        enum: ["Pending", "Completed"],
        default: "Completed",
      },
    },
  ],
  follow_Up_Date: { type: Date },
  archived_at: { type: Date },
  archived_by: { type: String },
  archived_reason: { type: String },

  relapse_risk_assessment: {
    risk_level: {
      type: String,
      enum: ["Low", "Moderate", "High", "Critical", "Insufficient Data"],
    },
    risk_score: { type: Number },
    confidence: { type: String, enum: ["Low", "Medium", "High"] },
    contributing_factors: [String],
    protective_factors: [String],
    recommended_actions: [String],
    rationale: { type: String },
    assessed_at: { type: Date },
  },
});

// Indexes
patientSchema.index({ patient_phone: 1 });
patientSchema.index({ patient_email: 1 });
patientSchema.index({ doctor_id: 1 });
patientSchema.index({ patient_registration_date: -1 });
patientSchema.index({ status: 1, patient_registration_date: -1 });
patientSchema.index({ status: 1, doctor_id: 1, patient_registration_date: -1 });
patientSchema.index({ "care_team.doctor_id": 1 });
patientSchema.index({
  "care_team.doctor_id": 1,
  status: 1,
  patient_registration_date: -1,
});
patientSchema.index({ status: 1, archived_at: -1 });
patientSchema.index(
  { previous_patient_id: 1 },
  {
    unique: true,
    partialFilterExpression: { previous_patient_id: { $type: "objectId" } },
  },
);
patientSchema.index({ patient_first_name: "text", patient_last_name: "text" });
patientSchema.index(
  { patient_registration_date: -1 },
  {
    partialFilterExpression: { status: "Active" },
    name: "active_patients_by_date",
  },
);
patientSchema.virtual("fullName").get(function () {
  return `${this.patient_first_name} ${this.patient_last_name}`;
});

patientSchema.pre("save", function (next) {
  next();
});

module.exports = {
  getPatientModel: function (connection) {
    return connection.model("Patient", patientSchema, "patients");
  },
  patientSchema,
};
