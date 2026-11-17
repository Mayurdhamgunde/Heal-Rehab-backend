const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

/**
 * Report Parameter Schema
 * One row of a lab report — e.g. "Haemoglobin: 12.2 g/dl (11.5-17.5)"
 * Kept generic on purpose: every panel (CBC, KFT, Thyroid, HbA1c,
 * Electrolytes, HIV screening, Biochemistry...) is just a list of these,
 * so a brand-new lab/report type never needs a schema change —
 * exactly how `medications` lets prescriptionSchema absorb any drug.
 */
const ReportParameterSchema = new mongoose.Schema(
  {
    label: {
      // e.g. "Haemoglobin", "Serum Free T3", "Neutrophils"
      type: String,
      required: true,
      trim: true,
    },
    value: {
      // Kept as String so "Negative", "8.9", "Below 6.3" all fit
      type: String,
      required: true,
      trim: true,
    },
    unit: {
      // e.g. "g/dl", "%", "mmol/L" — optional, some rows have none
      type: String,
      trim: true,
    },
    reference_range: {
      // e.g. "11.5 - 17.5", "Below 6.3 %"
      type: String,
      trim: true,
    },
    flag: {
      // Doctor/editor can mark a value as out-of-range without
      // needing to recompute it from reference_range every render
      type: String,
      enum: ["Normal", "Low", "High", "Critical", null],
      default: null,
    },
    // For grouped rows like "Differential Count" (Neutrophils, Lymphocytes,
    // Eosinophils, Monocytes, Basophils all sitting under one heading)
    group: {
      type: String,
      trim: true,
    },
  },
  { _id: false },
);

/**
 * Medical Report Schema
 * One uploaded/entered lab report. Lives in an array on the plan,
 * the same relationship prescriptions[] has to the plan — full
 * history preserved, nothing overwritten.
 */
const medicalReportSchema = new mongoose.Schema({
  report_number: {
    type: String,
    required: true,
    unique: true,
  },
  patient_id: {
    type: ObjectId,
    ref: "Patient",
    required: true,
  },
  patient_name: {
    type: String,
    required: true,
  },
  doctor_id: {
    // Referring/ordering doctor, kept consistent with prescriptionSchema's
    // doctor_id naming even though on the lab slips this is "Reffered By"
    type: ObjectId,
    ref: "Doctor",
  },
  doctor_name: {
    type: String,
  },
  plan_id: {
    type: ObjectId,
    ref: "TherapyPlan",
  },
  lab_name: {
    // e.g. "AYUSH DIAGNOSTICS"
    type: String,
    trim: true,
  },
  report_type: {
    // e.g. "Complete Blood Count", "Thyroid Function Tests", "KFT Examination"
    type: String,
    required: true,
    trim: true,
  },
  report_date: {
    type: Date,
    default: Date.now,
    required: true,
  },
  parameters: [ReportParameterSchema],
  method: {
    // e.g. "Fully Automated Immunofluorescence Assay", "By Nyco Card Reader"
    type: String,
    trim: true,
  },
  interpretation: {
    // Free text for narrative interpretation blocks (HIV screening report
    // has a full paragraph here rather than a single value)
    type: String,
  },
  attachment_url: {
    // Azure Blob URL if the original scanned report image/PDF is kept
    type: String,
  },
  notes: {
    type: String,
  },
  status: {
    type: String,
    enum: ["Active", "Reviewed", "Archived"],
    default: "Active",
  },
  created_at: {
    type: Date,
    default: Date.now,
  },
  updated_at: {
    type: Date,
    default: Date.now,
  },
});

medicalReportSchema.index({ patient_id: 1, report_date: -1 });
medicalReportSchema.index({ plan_id: 1, report_date: -1 });
medicalReportSchema.index({ report_number: 1 });
medicalReportSchema.index({ report_type: 1, report_date: -1 });

medicalReportSchema.pre("save", function (next) {
  this.updated_at = Date.now();
  next();
});

module.exports = {
  getMedicalReportModel: function (connection) {
    return connection.model(
      "MedicalReport",
      medicalReportSchema,
      "medical_reports",
    );
  },
  medicalReportSchema,
  ReportParameterSchema,
};
