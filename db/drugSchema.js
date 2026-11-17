const mongoose = require("mongoose");

// Define the drug schema
const drugSchema = new mongoose.Schema({
  drug_name: {
    type: String,
    required: true,
    trim: true,
  },
  meal_timing: { 
  type: String, 
  enum: ["Before Lunch", "After Lunch"], 
  default: "After Lunch" 
},
  generic_name: {
    type: String,
    trim: true,
  },
  strength: {
    type: String,
    trim: true,
  },
  drug_type: {
    type: String,
    enum: [
      "Tablet",
      "Capsule",
      "Syrup",
      "Injection",
      "Cream",
      "Drops",
      "Inhaler",
      "Other",
    ],
    required: true,
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

// Create indexes for frequently queried fields
drugSchema.index({ drug_name: 1 });
drugSchema.index({ generic_name: 1 });
drugSchema.index({ status: 1 });
drugSchema.index({ drug_type: 1 });

// Text index for search functionality
drugSchema.index({
  drug_name: "text",
  generic_name: "text",
});

// Update the updated_at timestamp before saving
drugSchema.pre("save", function (next) {
  this.updated_at = Date.now();
  next();
});

// Export the model with tenant isolation
module.exports = {
  getDrugModel: function (connection) {
    return connection.model("Drug", drugSchema, "drugs");
  },
  drugSchema,
};
