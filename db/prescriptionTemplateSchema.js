// db/prescriptionTemplateSchema.js
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const prescriptionTemplateSchema = new mongoose.Schema({
  template_name: {
    type: String,
    required: true,
    trim: true,
    unique: true, // Unique across the entire organization's database
  },
  // Kept for auditing purposes to know who originally made the template
  created_by_doctor_id: {
    type: ObjectId,
    ref: "Doctor",
  },
  created_by_doctor_name: {
    type: String,
  },
  vitals: {
    weight: {
      type: String,
      trim: true,
    },
    bp: {
      type: String,
      trim: true,
    },
  },
  medications: [
    {
      drug_id: {
        type: ObjectId,
        ref: "Drug",
      },
      drug_name: {
        type: String,
        required: true,
      },
      generic_name: {
        type: String,
      },
      drug_type: {
        type: String,
      },
      strength: {
        type: String,
      },
      route: {
        type: String,
        default: "Oral",
      },
      instructions: {
        type: String,
      },
      // Array of schedules for phased/tapering doses
      schedules: [
        {
          frequency: {
            type: String,
            required: true,
          },
          duration: {
            type: String,
            required: true,
          },
          quantity: {
            type: String,
          },
        },
      ],
      // Legacy Fields for backward compatibility
      dose_amount: {
        type: String,
        default: "1",
      },
      dosage: {
        type: String,
      },
      frequency: {
        type: String,
      },
      duration: {
        type: String,
      },
      quantity: {
        type: String,
      },
    },
  ],
  diagnosis: {
    type: String,
  },
  notes: {
    type: String,
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

// Update the timestamp on save
prescriptionTemplateSchema.pre("save", function (next) {
  this.updated_at = Date.now();
  next();
});

module.exports = {
  getPrescriptionTemplateModel: function (connection) {
    return connection.model(
      "PrescriptionTemplate",
      prescriptionTemplateSchema,
      "prescription_templates",
    );
  },
  prescriptionTemplateSchema,
};
