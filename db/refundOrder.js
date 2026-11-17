const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const RefundOrderSchema = new mongoose.Schema({
  payment_id: { type: ObjectId, required: true, ref: "ConsultationPayment" },

  razorpay_order_id: String,
  razorpay_payment_id: String,

  amount: Number,
  currency: String,

  therapy_id: ObjectId,
  patient_id: ObjectId,
  tenant_id: { type: String, required: true },
doctor_id: { type: ObjectId,  required: true },
  reason: String,

  status: {
    type: String,
    enum: ["approved", "processed"],
    default: "approved"
  },

  created_at: { type: Date, default: Date.now },
});

RefundOrderSchema.index({ therapy_id: 1 });
RefundOrderSchema.index({ created_at: -1 });

const paymentsDb = mongoose.connection.useDb("payments");
module.exports = paymentsDb.model("RefundOrder", RefundOrderSchema, "refundorders");
