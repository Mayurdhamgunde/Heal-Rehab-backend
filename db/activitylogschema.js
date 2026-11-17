// db/userActivityLogSchema.js
const mongoose = require("mongoose");

const userActivityLogSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    doctor_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    email: {
      type: String,
      required: true,
      index: true,
    },
    doctor_name: String,
    action: {
      type: String,
      required: true,
      enum: [
        "LOGIN",
        "LOGOUT",
        "CREATE",
        "UPDATE",
        "DELETE",
        "VIEW",
        "SEARCH",
        "UPLOAD",
        "DOWNLOAD",
        "PAYMENT",
        "APPOINTMENT",
        "THERAPY_SESSION",
        "NOTIFICATION",
        "REPORT_GENERATION",
        "PLAN_MANAGEMENT",
        "PATIENT_MANAGEMENT",
        "DOCTOR_MANAGEMENT",
        "ORGANIZATION_MANAGEMENT",
        "BLOG_MANAGEMENT",
        "SUBSCRIPTION",
        "WHATSAPP_REMINDER",
        "PDF_GENERATION",
        "IMAGE_UPLOAD",
        "CONSULTATION",
        "DASHBOARD_VIEW",
        "OTHER",
        "CONSENT_FORM", // Added
        "ASSESSMENT", // Added
        "DEPARTMENT", // Added
        "DRUG_MANAGEMENT", // Added
        "EXPENSE_MANAGEMENT", // Added
        "INVOICE", // Added
        "PARTNER_MANAGEMENT", // Added
        "FORM_BUILDER", // Added
        "SESSION_MANAGEMENT", // Added
      ],
    },
    action_message: {
      type: String,
      required: true,
      index: true, // Add index for searching by action message
    },
    resource: {
      type: String,
      required: true, // e.g., 'patient', 'therapy', 'appointment', 'payment'
    },
    resource_id: {
      type: String, // ID of the specific resource being acted upon
      index: true,
    },
    method: {
      type: String,
      required: true,
      enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    },
    endpoint: {
      type: String,
      required: true,
      index: true,
    },
    ip_address: {
      type: String,
      required: true,
    },
    user_agent: {
      type: String,
      required: true,
    },
    request_body: {
      type: mongoose.Schema.Types.Mixed, // Store sanitized request data
      default: null,
    },
    response_status: {
      type: Number,
      required: true,
    },
    response_time: {
      type: Number, // Time taken to process request in milliseconds
      required: true,
    },
    error_message: {
      type: String,
      default: null,
    },
    session_id: {
      type: String,
      index: true,
    },
    metadata: {
      organization_name: String,
      is_admin: Boolean,
      subscription_plan: String,
      query_params: mongoose.Schema.Types.Mixed,
      file_uploaded: String,
      files_uploaded: Number,
      tenant_id: String,
      success: Boolean, // Whether the operation was successful (status < 400)
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
    collection: "user_activity_logs",
  },
);

// Create indexes for better query performance
userActivityLogSchema.index({ timestamp: -1 });
userActivityLogSchema.index({ user_id: 1, timestamp: -1 });
userActivityLogSchema.index({ action: 1, timestamp: -1 });
userActivityLogSchema.index({ endpoint: 1, timestamp: -1 });
userActivityLogSchema.index({ action_message: "text" }); // Text index for searching messages
userActivityLogSchema.index({ "metadata.success": 1, timestamp: -1 });

// Export the model in a way that supports tenant isolation
module.exports = {
  getUserActivityLogModel: function (connection) {
    // This allows you to create activity log models specific to each organization's database
    return connection.model(
      "UserActivityLog",
      userActivityLogSchema,
      "user_activity_logs",
    );
  },
  userActivityLogSchema,
};
