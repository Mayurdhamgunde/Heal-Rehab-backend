const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const PAYMENT_MODES = [
  "CASH",
  "CARD",
  "UPI",
  "BANK_TRANSFER",
  "CHEQUE",
  "ONLINE",
  "OTHER",
];
const PAYMENT_PURPOSES = [
  "ADMISSION",
  "DEPOSIT",
  "MONTHLY_FEE",
  "MEDICATION",
  "LAB",
  "OTHER",
];
const ENTRY_TYPES = ["PAYMENT", "REFUND"];
const PAYMENT_STATUSES = ["ACTIVE", "VOIDED"];

const paymentSchema = new mongoose.Schema(
  {
    tenant_id: { type: String },

    patient_id: { type: ObjectId, ref: "Patient", required: true },

    location_id: { type: String },
    location_name: { type: String },
    location_address: { type: String },

    amount: { type: Number, required: true, min: 0.01 },
    entry_type: { type: String, enum: ENTRY_TYPES, default: "PAYMENT" },
    refund_of: { type: ObjectId, ref: "Payment" },

    mode: { type: String, enum: PAYMENT_MODES, required: true },
    purpose: { type: String, enum: PAYMENT_PURPOSES, default: "OTHER" },
    line_items: [
      {
        _id: false,
        name: { type: String, required: true },
        amount: { type: Number, required: true, min: 0 },
      },
    ],

    date: { type: Date, default: Date.now },
    receipt_number: { type: String },
    transaction_ref: { type: String },
    notes: { type: String },

    // The payments-desk user who recorded it (not a doctor).
    recorded_by_id: { type: ObjectId },
    recorded_by_name: { type: String },

    invoice_id: { type: ObjectId, ref: "Invoice" },
    isViaHealtrack: { type: Boolean, default: false },

    status: { type: String, enum: PAYMENT_STATUSES, default: "ACTIVE" },
    voided_at: { type: Date },
    voided_by_id: { type: ObjectId },
    voided_by_name: { type: String },
    void_reason: { type: String },

    edit_history: [
      {
        _id: false,
        edited_at: { type: Date, default: Date.now },
        edited_by_id: { type: ObjectId },
        edited_by_name: { type: String },
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

    // Kept only for migrated rows; never read by the app.
    legacy_type: { type: String },
    legacy_doctor_id: { type: ObjectId },
  },
  { timestamps: true },
);

paymentSchema.pre("validate", function (next) {
  if (this.entry_type === "REFUND" && !this.refund_of) {
    return next(new Error("refund_of is required for REFUND entries"));
  }
  if (this.entry_type === "PAYMENT" && this.refund_of) {
    return next(new Error("refund_of is only valid for REFUND entries"));
  }
  next();
});

paymentSchema.index({ tenant_id: 1, patient_id: 1, date: -1 });
paymentSchema.index({ patient_id: 1, date: -1 });
paymentSchema.index({ date: -1 });
paymentSchema.index({ location_id: 1, date: -1 });
paymentSchema.index({ status: 1, date: -1 });
paymentSchema.index(
  { refund_of: 1 },
  { partialFilterExpression: { refund_of: { $type: "objectId" } } },
);
paymentSchema.index(
  { tenant_id: 1, receipt_number: 1 },
  {
    unique: true,
    partialFilterExpression: { receipt_number: { $type: "string" } },
  },
);

module.exports = {
  getPaymentModel: function (connection) {
    return connection.model("Payment", paymentSchema, "payments");
  },
  paymentSchema,
  PAYMENT_MODES,
  PAYMENT_PURPOSES,
  ENTRY_TYPES,
  PAYMENT_STATUSES,
};
