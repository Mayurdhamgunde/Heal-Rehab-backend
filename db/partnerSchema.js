const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

// Define the partner (customer/party) schema
const partnerSchema = new mongoose.Schema(
  {
    // BASIC INFO
    partner_name: {
      type: String,
      required: true,
      trim: true,
      index: true, // Indexed for quick search by name
    },
    phone_number: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      lowercase: true,
      trim: true,
    },

    // GST & TAX DETAILS
    gstin: {
      type: String,
      trim: true,
      uppercase: true,
    },
    gst_type: {
      type: String,
      enum: [
        "Unregistered/Consumer",
        "Registered Business - Regular",
        "Registered Business - Composition",
        "Overseas",
        "SEZ",
      ],
      default: "Unregistered/Consumer",
    },

    // ADDRESS DETAILS
    billing_address: {
      street: String,
      city: String,
      state: String,
      zip: String,
      country: { type: String, default: "India" },
    },

    is_shipping_same_as_billing: {
      type: Boolean,
      default: true,
    },

    shipping_address: {
      street: String,
      city: String,
      state: String,
      zip: String,
      country: String,
    },

    // STATUS & META
    status: {
      type: String,
      enum: ["Active", "Inactive", "Blacklisted"],
      default: "Active",
    },
    notes: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

// --- INDEXES ---
// Updated to remove tenant_id dependencies

// Ensure global uniqueness for GSTIN (if it exists)
partnerSchema.index(
  { gstin: 1 },
  { unique: true, partialFilterExpression: { gstin: { $type: "string" } } }
);

// Index phone number for lookup
partnerSchema.index({ phone_number: 1 });

// Text index for fuzzy search on partner name
partnerSchema.index({ partner_name: "text" });

// --- MIDDLEWARE ---
partnerSchema.pre("save", function (next) {
  // Auto-fill shipping address if it's the same as billing
  if (this.is_shipping_same_as_billing && this.billing_address) {
    this.shipping_address = this.billing_address;
  }
  next();
});

// --- EXPORT ---
module.exports = {
  getPartnerModel: function (connection) {
    return connection.model("Partner", partnerSchema, "partners");
  },
  partnerSchema,
};
