const mongoose = require("mongoose");
const { Schema } = mongoose;
const { ObjectId } = mongoose.Types;

const patientUserSchema = new Schema(
  {
    Hospital_Clinic: [
      {
        patientId: {
          type: ObjectId,
          required: true,
          ref: "Patient", // Reference to the Patient model
        },
        tenantId: {
          type: String,
          required: true,
        },
        organizationName: {
          type: String,
          required: true,
        },
      },
    ],
    email: {
      type: String,
      unique: true,
      trim: true,
      lowercase: true,
    },
    phoneNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    Name: {
      type: String,
      required: true,
      trim: true,
    },
    age: {
      type: Number,
      required: false,
    },
    gender: {
      type: String,
      required: false,
    },
    bloodGroup: {
      type: String,
      required: false,
    },
    userImage: {
      type: String,
      required: false,
    },
    address: {
      type: String,
      required: false,
    },
    medicalConditions: {
      type: String,
      required: false,
    },
    tenant_id: {
      type: String,
      required: true,
      index: true,
    },
    doctor_id: {
      type: ObjectId,
      ref: "Doctor",
    },
    doctor_name: {
      type: String,
      required: false,
    },
    updatablebyDoctor: { type: Boolean },
    // Therapy Plans (long-term therapy tracking)
    therapy_plans: [
      {
        therapyId: {
          type: ObjectId,
        },
        therapy_name: String,
        patient_diagnosis: String,
        patient_symptoms: String,
        patient_therapy_category: String,
        therapy_duration: String,
        therapy_start: Date,
        therapy_end: Date,
        total_amount: String,
        received_amount: String,
        balance: String,
        tenant_id: String,
        estimated_sessions: Number,
      },
    ],

    therapies: [
      {
        therapy_id: {
          type: ObjectId,
        },
        start_time: {
          type: String,
        },
        tenant_id: {
          type: String,
        },
        date: {
          type: Date,
        },
        doctor_name: {
          type: String,
        },
        doctor_phone: {
          type: String,
        },
        therapy_type: {
          type: String,
        },
      },
    ],
    // Add consultations array to store multiple consultations
    consultations: [
      {
        organizationName: {
          type: String,
          required: true,
        },
        organizationId: { type: String },
        doctorName: {
          type: String,
          required: true,
        },
        status: {
          type: String,
          enum: ["Scheduled", "Completed", "Cancelled", "Refunded", "Rescheduled"],
          default: "Scheduled",
        },
        consultationDate: {
          type: String,
          required: true,
        },
        consultationTime: {
          type: String,
          required: true,
        },
        consultationEndTime:{
          type: String,
        },
        patientSymptoms: {
          type: String,
        },
        causes: {
          type: String,
          required: false,
        },
        results: {
          type: String,
        },
        notes: {
          type: String,
        },
      },
    ],

    status: {
      type: String,
      enum: ["active", "inactive", "suspended"],
      default: "active",
    },
    password: {
      type: String,
      required: false,
    },
    refresh_token: {
      type: String,
      required: false,
    },
    last_login: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// Create indexes for frequently queried fields
patientUserSchema.index({ email: 1 });
patientUserSchema.index({ tenant_id: 1 });
patientUserSchema.index({ "CreatedBy.patientId": 1 }); // Index for linking to Patient

const patientsDb = mongoose.connection.useDb("patients");
const PatientUser = patientsDb.model(
  "PatientUser",
  patientUserSchema,
  "patients"
);

module.exports = PatientUser;
