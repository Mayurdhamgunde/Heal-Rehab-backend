const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const patientAssessmentSchema = new mongoose.Schema(
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
    template_id: {
      type: ObjectId,
      ref: "FormTemplate",
      required: true,
    },
    assessment_name: {
      type: String,
      required: true,
    },
    date_taken: {
      type: Date,
      default: Date.now,
    },
    status: {
      type: String,
      enum: ["Draft", "Completed"],
      default: "Completed",
    },
    // The exact state of the template at the time the assessment was taken.
    // This prevents historical records from breaking if the template is edited later.
    template_snapshot: {
      type: mongoose.Schema.Types.Mixed,
    },
    // The responses array holds the dynamic answers based on the template
    responses: [
      {
        question_id: { type: String, required: true },
        question_title: { type: String },
        question_type: { type: String },
        // Mixed type handles Strings (text), Arrays (checkboxes), and Nested Objects (tables/inline blanks)
        answer: { type: mongoose.Schema.Types.Mixed, default: null },
      },
    ],
    general_notes: {
      type: String,
    },
  },
  {
    timestamps: true,
  },
);

// Indexes for faster lookups when loading a patient's profile
patientAssessmentSchema.index({ patient_id: 1, date_taken: -1 });

module.exports = {
  getPatientAssessmentModel: function (connection) {
    return connection.model(
      "PatientAssessment",
      patientAssessmentSchema,
      "patient_assessments",
    );
  },
  patientAssessmentSchema,
};
