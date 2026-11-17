const mongoose = require("mongoose");

// Define notification schema
const notificationSchema = new mongoose.Schema(
  {
    tenant_id: {
      type: String,
      required: true,
      index: true,
    },
    organization_id: {
      type: String,
    },
    type: {
      type: String,
      required: true,
      enum: [
        "subscription_expiry_warning",
        "subscription_expired",
        "subscription_renewed",
        "payment_failed",
        "general",
      ],
      default: "general",
    },
    title: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high", "critical"],
      default: "medium",
    },
    status: {
      type: String,
      enum: ["unread", "read", "archived"],
      default: "unread",
    },
    category: {
      type: String,
      enum: ["subscription", "payment", "system", "general"],
      default: "general",
    },
    metadata: {
      subscription_plan: String,
      days_remaining: Number,
      expiry_date: Date,
      auto_renew: Boolean,
      billing_cycle: String,
    },
    recipient: {
      type: String, // email or user_id
      required: true,
    },
    is_global: {
      type: Boolean,
      default: false, // true for organization-wide notifications
    },
    action_required: {
      type: Boolean,
      default: false,
    },
    action_url: {
      type: String, // URL for action like "Renew Subscription"
    },
    expires_at: {
      type: Date, // When the notification should be automatically archived
    },
    read_at: {
      type: Date,
    },
    archived_at: {
      type: Date,
    },
    created_at: {
      type: Date,
      default: Date.now,
    },
    updated_at: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Create indexes for efficient queries
notificationSchema.index({ tenant_id: 1, status: 1 });
notificationSchema.index({ tenant_id: 1, type: 1 });
notificationSchema.index({ tenant_id: 1, created_at: -1 });
notificationSchema.index({ recipient: 1, status: 1 });
notificationSchema.index({ expires_at: 1 });

// Pre-save middleware to update timestamps
notificationSchema.pre("save", function (next) {
  this.updated_at = new Date();
  next();
});

// Method to mark notification as read
notificationSchema.methods.markAsRead = function () {
  this.status = "read";
  this.read_at = new Date();
  this.updated_at = new Date();
  return this.save();
};

// Method to archive notification
notificationSchema.methods.archive = function () {
  this.status = "archived";
  this.archived_at = new Date();
  this.updated_at = new Date();
  return this.save();
};

// Static method to create subscription expiry notification
// Static method to create subscription expiry notification
notificationSchema.statics.createExpiryNotification = function (
  tenant_id,
  organization_id,
  subscription,
  daysRemaining
) {
  const isExpired = daysRemaining <= 0;
  const isCritical = daysRemaining <= 1;
  const isWarning = daysRemaining <= 3;
  const isEarlyWarning = daysRemaining <= 30; // Add early warning for 30 days
  const isVeryEarlyWarning = daysRemaining <= 125; // Add very early warning

  let title, message, priority, type;

  if (isExpired) {
    title = "Subscription Expired";
    message = `Your ${subscription.plan} subscription has expired. Please renew to continue using our services.`;
    priority = "critical";
    type = "subscription_expired";
  } else if (isCritical) {
    title = "Subscription Expiring Soon";
    message = `Your ${
      subscription.plan
    } subscription expires in ${daysRemaining} day${
      daysRemaining === 1 ? "" : "s"
    }. Renew now to avoid service interruption.`;
    priority = "critical";
    type = "subscription_expiry_warning";
  } else if (isWarning) {
    title = "Subscription Expiry Reminder";
    message = `Your ${subscription.plan} subscription expires in ${daysRemaining} days. Consider renewing to ensure uninterrupted service.`;
    priority = "high";
    type = "subscription_expiry_warning";
  } else if (isEarlyWarning) {
    title = "Subscription Renewal Notice";
    message = `Your ${subscription.plan} subscription expires in ${daysRemaining} days. Plan ahead for renewal.`;
    priority = "medium";
    type = "subscription_expiry_warning";
  } else if (isVeryEarlyWarning) {
    title = "Subscription Status Update";
    message = `Your ${subscription.plan} subscription expires in ${daysRemaining} days. Keep this in mind for future planning.`;
    priority = "low";
    type = "subscription_expiry_warning";
  } else {
    // Return null for subscriptions that don't need notifications
    // This prevents the validation error
    return null;
  }

  return new this({
    tenant_id,
    organization_id,
    type,
    title,
    message,
    priority,
    category: "subscription",
    metadata: {
      subscription_plan: subscription.plan,
      days_remaining: daysRemaining,
      expiry_date: subscription.end_date,
      auto_renew: subscription.auto_renew,
      billing_cycle: subscription.billing_cycle,
    },
    recipient: "admin", // Can be modified based on your user system
    is_global: true,
    action_required: true,
    action_url: "https://doctor.healtrackai.com/payment",
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // Expire in 30 days
  });
};

// Export the model factory function
module.exports = {
  getNotificationModel: function (connection) {
    return connection.model(
      "Notification",
      notificationSchema,
      "notifications"
    );
  },
  notificationSchema,
};
