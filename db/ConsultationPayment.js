const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const ConsultationPaymentSchema = new mongoose.Schema({
  razorpay_order_id: { type: String, required: true },
  razorpay_payment_id: { type: String },
  amount: { type: Number, required: true },
  currency: { type: String, default: "INR" },

  status: {
    type: String,
    enum: ["created", "captured", "failed", "refunded", "Cancelled"],
    default: "created",
  },
  tenant_id: { type: String, required: true },
doctor_id: { type: ObjectId,  required: true },
  therapy_id: { type: ObjectId, default: null },
  patient_id: { type: ObjectId, required: true },

  refund_status: {
    type: String,
    enum: ["none", "pending", "approved", "rejected", "processed", "refunded"],
    default: "none",
  },

  refund_reason: { type: String },
  refund_id: { type: String },

  created_at: { type: Date, default: Date.now },
});
ConsultationPaymentSchema.index({ therapy_id: 1 });
ConsultationPaymentSchema.index({ refund_status: 1 });

const paymentsDb = mongoose.connection.useDb("payments");
module.exports = paymentsDb.model("ConsultationPayment", ConsultationPaymentSchema);
