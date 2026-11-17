const mongoose = require("mongoose");

// Define subscription plan schema
const subscriptionPlanSchema = new mongoose.Schema(
  {
    plan_id: {
      type: String,
      required: true,
      enum: ["basic", "professional", "enterprise", "free_trial"],
      unique: true,
    },
    name: {
      type: String,
      required: true,
      enum: ["Basic", "Professional", "Enterprise", "Free Trial"],
    },
    price: {
      type: Number,
      required: true,
    },
    billing_cycle: {
      type: String,
      enum: ["monthly", "yearly", "trial"],
      default: "monthly",
    },
    features: {
      cloud_storage: {
        type: String,
        required: true,
      },
      database_backup: {
        type: String,
        required: true,
      },
      analytics: {
        type: String,
        required: true,
      },
      support: {
        type: String,
        required: true,
      },
      health_data: {
        type: String,
        required: true,
      },
      devices: {
        type: String,
        required: true,
      },
      api_access: {
        type: Boolean,
        default: false,
      },
      custom_branding: {
        type: Boolean,
        default: false,
      },
    },
    is_active: {
      type: Boolean,
      default: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Define the subscription schema for organization subscriptions
const subscriptionSchema = new mongoose.Schema(
  {
    organization_id: {
      type: String,
    },
    tenant_id: {
      type: String,
      required: true,
    },
    plan: {
      type: String,
      required: true,
      enum: ["basic", "professional", "enterprise", "free_trial"],
      default: "free_trial",
    },
    status: {
      type: String,
      enum: ["active", "inactive", "expired", "cancelled", "pending"],
      default: "active",
    },
    start_date: {
      type: Date,
      required: true,
      default: Date.now,
    },
    end_date: {
      type: Date,
      required: true,
    },
    is_trial: {
      type: Boolean,
      default: false,
    },
    payment_method: {
      type: String,
    },
    transaction_id: {
      type: String,
    },
    auto_renew: {
      type: Boolean,
      default: true,
    },
    billing_cycle: {
      type: String,
      enum: ["monthly", "yearly", "trial"],
      default: "monthly",
    },
    billing_information: {
      name: String,
      email: String,
      address: {
        street: String,
        city: String,
        state: String,
        zip: String,
        country: String,
      },
      gst_number: String,
    },
    price_paid: {
      type: Number,
      default: 0,
    },
    next_billing_date: {
      type: Date,
    },
    cancellation_reason: {
      type: String,
    },
    cancellation_date: {
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

// Create indexes for frequently queried fields
subscriptionSchema.index({ tenant_id: 1 });
subscriptionSchema.index({ status: 1 });
subscriptionSchema.index({ end_date: 1 });

// Pre-save middleware to update the timestamps
subscriptionSchema.pre("save", function (next) {
  this.updated_at = new Date();
  next();
});

// Export the model in a way that supports tenant isolation
module.exports = {
  getSubscriptionModel: function (connection) {
    // This allows you to create subscription models specific to each organization's database
    return connection.model("Subscription", subscriptionSchema, "subscription");
  },
  getSubscriptionPlanModel: function (connection) {
    // This is for the global subscription plans collection
    return connection.model(
      "SubscriptionPlan",
      subscriptionPlanSchema,
      "subscription_plans"
    );
  },
  subscriptionSchema,
  subscriptionPlanSchema,
};
