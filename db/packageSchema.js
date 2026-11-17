const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const PACKAGE_STATUSES = ["ACTIVE", "CANCELLED"];

const itemSchema = {
  _id: false,
  name: { type: String, required: true, trim: true, maxlength: 100 },
  amount: { type: Number, required: true, min: 0 },
};

/**
 * Reusable price list entries, e.g. "30-day Residential Programme".
 * Staff pick one when assigning a package so they do not retype the charges.
 * Deleting a template never affects patients: a patient package keeps its own copy.
 */
const packageTemplateSchema = new mongoose.Schema(
  {
    tenant_id: { type: String },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    name_key: { type: String, required: true }, // lower-cased name, used for the uniqueness check
    description: { type: String, maxlength: 500 },
    duration_days: { type: Number, min: 1 },
    items: { type: [itemSchema], default: [] },
    total_amount: { type: Number, required: true, min: 0 }, // computed server-side
    is_active: { type: Boolean, default: true },
    created_by_id: { type: ObjectId },
    created_by_name: { type: String },
  },
  { timestamps: true },
);

packageTemplateSchema.index({ tenant_id: 1, name_key: 1 }, { unique: true });
packageTemplateSchema.index({ is_active: 1, name_key: 1 });

/**
 * What ONE patient (admission) is being charged. A patient has at most one ACTIVE package.
 * - `items` is a snapshot copy; gross/net are always recomputed on the server.
 * - Money received lives in the payments collection; paid/balance are computed, never stored.
 * - Price changes are recorded in `revision_history`; packages are cancelled, never deleted.
 */
const patientPackageSchema = new mongoose.Schema(
  {
    tenant_id: { type: String },
    patient_id: { type: ObjectId, ref: "Patient", required: true },

    template_id: { type: ObjectId, ref: "PackageTemplate" },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    items: { type: [itemSchema], default: [] },

    gross_amount: { type: Number, required: true, min: 0 },
    discount_amount: { type: Number, default: 0, min: 0 },
    discount_reason: { type: String, maxlength: 300 },
    net_amount: { type: Number, required: true, min: 0 }, // gross - discount: what the patient owes

    duration_days: { type: Number, min: 1 },
    start_date: { type: Date, default: Date.now },
    notes: { type: String, maxlength: 1000 },

    status: { type: String, enum: PACKAGE_STATUSES, default: "ACTIVE" },
    cancelled_at: { type: Date },
    cancelled_by_id: { type: ObjectId },
    cancelled_by_name: { type: String },
    cancel_reason: { type: String },

    created_by_id: { type: ObjectId },
    created_by_name: { type: String },

    revision_history: [
      {
        _id: false,
        revised_at: { type: Date, default: Date.now },
        by_id: { type: ObjectId },
        by_name: { type: String },
        note: { type: String },
        changes: [
          {
            _id: false,
            field: String,
            from: mongoose.Schema.Types.Mixed,
            to: mongoose.Schema.Types.Mixed,
          },
        ],
      },
    ],
  },
  { timestamps: true },
);

patientPackageSchema.index({ patient_id: 1, status: 1 });
patientPackageSchema.index({ status: 1, createdAt: -1 });
// One live package per patient; enforced by the database, not just by the controller.
patientPackageSchema.index(
  { patient_id: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "ACTIVE" },
    name: "one_active_package_per_patient",
  },
);

module.exports = {
  getPackageTemplateModel: (connection) =>
    connection.model(
      "PackageTemplate",
      packageTemplateSchema,
      "package_templates",
    ),
  getPatientPackageModel: (connection) =>
    connection.model(
      "PatientPackage",
      patientPackageSchema,
      "patient_packages",
    ),
  packageTemplateSchema,
  patientPackageSchema,
  PACKAGE_STATUSES,
};
