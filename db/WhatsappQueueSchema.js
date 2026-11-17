const mongoose = require("mongoose");
const { Schema } = mongoose;

const whatsappQueueSchema = new Schema(
  {
    tenant_id: { type: String, required: true },
    jobType: {
      type: String,
      enum: ["plan_creation", "appointment_scheduled"],
      default: "plan_creation",
    },
    patient: { type: Object, required: true },
    organization: { type: Object, required: true },

    // Fields for Plan Creation
    plan: { type: Object },

    // Fields for Appointment Scheduling
    session: { type: Object },
    doctor: { type: Object },

    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed"],
      default: "pending",
    },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    lastError: { type: String },
    nextRunAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

whatsappQueueSchema.index({ status: 1, nextRunAt: 1 });
whatsappQueueSchema.index({ status: 1, jobType: 1, nextRunAt: 1 });
whatsappQueueSchema.index({ tenant_id: 1 });

const queueDb = mongoose.connection.useDb("system_queues");
const WhatsAppQueue = queueDb.model(
  "WhatsAppQueue",
  whatsappQueueSchema,
  "whatsapp_queue",
);

module.exports = WhatsAppQueue;
