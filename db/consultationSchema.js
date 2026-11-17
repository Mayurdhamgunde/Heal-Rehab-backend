const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const consultationSchema = new mongoose.Schema(
  {
    patientId: {
      type: ObjectId,
      ref: "Patient",
      required: true,
      index: true, // Indexed for faster lookup
    },
    organizationName: {
      type: String,
      required: true,
    },
    organizationId: {
      type: String,
    },
    doctorName: {
      type: String,
      required: true,
    },
    consultationDate: {
      type: Date,
      required: true,
    },
    consultationTime: {
      type: String,
      required: true,
    },
    patientSymptoms: {
      type: String,
    },
    prescriptionId: {
      type: ObjectId,
      ref: "Prescription",
    },
    status: {
      type: String,
      enum: ["Scheduled", "Completed", "Cancelled"],
      default: "Scheduled",
    },
    causes: {
      type: String,
    },
    results: {
      type: String,
    },
    doctorId: {
      type: ObjectId,
      ref: "doctors",
      index: true, // Indexed for faster lookup
    },
    notes: {
      type: String,
    },
    therapyDetails: {
      type: String, // Moved here from the embedded update logic
    },
    therapy_id: {
      type: ObjectId,
      ref: "TherapySession",
    },
  },
  { timestamps: true },
);

module.exports = {
  getConsultationModel: function (connection) {
    return connection.model(
      "Consultation",
      consultationSchema,
      "consultations",
    );
  },
  consultationSchema,
};
