const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const consentFormSchema = new mongoose.Schema(
  {
    patient_id: {
      type: ObjectId,
      ref: "Patient",
      required: true,
      index: true,
    },
    doctor_id: {
      type: ObjectId,
      ref: "Doctor",
      required: true,
    },
    form_type: {
      type: String,
      default: "High Risk Consent",
      required: true,
    },

    // The actual date written on the physical form
    consent_date: {
      type: Date,
      required: true,
    },
    marital_status: {
      type: String,
      required: true,
    },
    guardian_phone: {
      type: String,
      required: true,
    },
    guardian_phone_2: {
      type: String,
      required: false,
    },
    // Consent specific details
    is_agreed: {
      type: Boolean,
      required: true,
    },
    witness_name: {
      type: String,
    },

    // System audit timestamp (when it was entered into the database)
    created_at: {
      type: Date,
      default: Date.now,
    },
    // 1. Live photos taken at the time of form creation
    patient_photo_url: { type: String },
    witness_photo_url: { type: String },

    // 2. The final scanned copy of the physically signed document
    signed_document_url: { type: String },
    status: {
      type: String,
      enum: ["Active", "Revoked", "Archived"],
      default: "Active",
    },
  },
  { timestamps: true },
);

module.exports = {
  getConsentModel: function (connection) {
    return connection.model("ConsentForm", consentFormSchema, "consent_forms");
  },
};
