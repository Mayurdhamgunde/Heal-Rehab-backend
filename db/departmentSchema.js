const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const departmentSchema = new mongoose.Schema(
  {
    department_name: {
      type: String,
      required: true,
      trim: true,
      unique: true, // Optional: ensures no duplicate global departments
    },
    department_code: {
      type: String,
      trim: true,
      uppercase: true,
    },
    description: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: ["Active", "active", "Inactive", "inactive", "Suspended"],
      default: "Active",
    },
    // In departmentSchema, add this field:
    is_admin_department: {
      type: Boolean,
      default: false, // Only one department should have this true
    },
    privileges: {
      can_register_patients: { type: Boolean, default: false },
      can_update_patients: { type: Boolean, default: false },
      can_create_treatment_plans: { type: Boolean, default: false },
      can_access_all_assessments: { type: Boolean, default: false }, // ← ADD THIS
      can_give_prescription: { type: Boolean, default: false },
      can_create_sessions: { type: Boolean, default: false },
      can_delete_patients: { type: Boolean, default: false }, // New field
    },
    head_of_department: {
      type: ObjectId,
      ref: "Doctor",
    },
    // Location assignments
    assigned_locations: [
      {
        location_id: {
          type: String,
          required: true,
        },
        location_name: {
          type: String,
          required: true,
        },
        assigned_at: {
          type: Date,
          default: Date.now,
        },
        is_active: {
          type: Boolean,
          default: true,
        },
      },
    ],
  },
  {
    timestamps: true,
  },
);

// Create indexes for frequently queried fields
departmentSchema.index({ department_name: 1 });
departmentSchema.index({ "assigned_locations.location_id": 1 });

// Assign a location to the department
departmentSchema.methods.assignLocation = function (locationData) {
  const existingIndex = this.assigned_locations.findIndex(
    (loc) => loc.location_id === locationData.location_id,
  );

  if (existingIndex > -1) {
    this.assigned_locations[existingIndex] = {
      ...this.assigned_locations[existingIndex].toObject(),
      ...locationData,
    };
  } else {
    this.assigned_locations.push(locationData);
  }

  return this.save();
};

module.exports = {
  getDepartmentModel: function (connection) {
    return connection.model("Department", departmentSchema, "departments");
  },
  departmentSchema,
};
