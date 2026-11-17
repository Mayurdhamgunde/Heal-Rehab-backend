const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const prescriptionSchema = new mongoose.Schema({
  prescription_number: {
    type: String,
    required: true,
    unique: true,
  },
  patient_id: {
    type: ObjectId,
    ref: "Patient",
    required: true,
  },
  patient_name: {
    type: String,
    required: true,
  },
  doctor_id: {
    type: ObjectId,
    ref: "Doctor",
    required: true,
  },
  doctor_name: {
    type: String,
    required: true,
  },
  prescription_date: {
    type: Date,
    default: Date.now,
    required: true,
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
      // ── NEW FIELD: Array of schedules for phased/tapering doses ──
      schedules: [
        {
          frequency: {
            type: String,
            required: true, // e.g., "1-1-1-2"
          },
          duration: {
            type: String,
            required: true,
          },
          start_date: {
            type: Date,
          },
          end_date: {
            type: Date,
          },
          quantity: {
            type: String,
          },
        },
      ],
      // ── LEGACY FIELDS (Kept for backward compatibility with old prescriptions) ──
      // Removed 'required: true' so new prescriptions don't fail validation
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
      start_date: {
        type: Date,
      },
      end_date: {
        type: Date,
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
  status: {
    type: String,
    enum: ["Active", "Completed", "Cancelled"],
    default: "Active",
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

prescriptionSchema.index({ patient_id: 1, prescription_date: -1 });
prescriptionSchema.index({ doctor_id: 1, prescription_date: -1 });
prescriptionSchema.index({ prescription_number: 1 });
prescriptionSchema.index({ status: 1, prescription_date: -1 });

prescriptionSchema.pre("save", function (next) {
  this.updated_at = Date.now();
  next();
});

module.exports = {
  getPrescriptionModel: function (connection) {
    return connection.model(
      "Prescription",
      prescriptionSchema,
      "prescriptions",
    );
  },
  prescriptionSchema,
};