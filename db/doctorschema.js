const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

// Define the doctor schema with location assignments
const doctorSchema = new mongoose.Schema(
  {
    doctor_first_name: {
      type: String,
      required: true,
      trim: true,
    },
    doctor_last_name: {
      type: String,
      required: true,
      trim: true,
    },
    doctor_email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      unique: true,
    },
    blogs: [
      {
        type: ObjectId,
        ref: "Blog",
      },
    ],
    doctor_phone: {
      type: String,
      required: true,
    },
    qualification: {
      type: String,
      required: true,
    },
    tenant_id: {
      type: String,
      required: true,
    },
    organization_name: {
      type: String,
      required: true,
    },
    is_admin: {
      type: Boolean,
      default: false,
    }, // Add this inside your mongoose.Schema definition
    department_id: {
      type: ObjectId,
      ref: "Department",
      required: true, // Enforces that every user must belong to a department
    },
    // If users can hold multiple designations (e.g., Doctor, Consultant) within the department
    roles: [
      {
        type: String,
        trim: true,
      },
    ],
    status: {
      type: String,
      enum: ["Active", "active", "Inactive", "inactive", "Suspended"],
      default: "Active",
    },
    patients: [
      {
        type: ObjectId,
        ref: "Patient",
      },
    ],
    doctors_photo: {
      type: String,
    },

    // LOCATION ASSIGNMENTS - NEW FEATURE
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
        // Flexible working hours - can be null if schedule is unorthodox/variable
        working_hours: {
          monday: {
            enabled: { type: Boolean, default: false },
            slots: [{ start: String, end: String }],
          },
          tuesday: {
            enabled: { type: Boolean, default: false },
            slots: [{ start: String, end: String }],
          },
          wednesday: {
            enabled: { type: Boolean, default: false },
            slots: [{ start: String, end: String }],
          },
          thursday: {
            enabled: { type: Boolean, default: false },
            slots: [{ start: String, end: String }],
          },
          friday: {
            enabled: { type: Boolean, default: false },
            slots: [{ start: String, end: String }],
          },
          saturday: {
            enabled: { type: Boolean, default: false },
            slots: [{ start: String, end: String }],
          },
          sunday: {
            enabled: { type: Boolean, default: false },
            slots: [{ start: String, end: String }],
          },
        },
        // Flag for flexible/unorthodox schedules
        has_fixed_schedule: {
          type: Boolean,
          default: true, // false means schedule varies and isn't fixed
        },
        // Optional notes for flexible schedules
        schedule_notes: {
          type: String,
          trim: true,
        },
        // When doctor was assigned to this location
        assigned_at: {
          type: Date,
          default: Date.now,
        },
        // Is this location currently active for the doctor
        is_active: {
          type: Boolean,
          default: true,
        },
      },
    ],

    // Legacy working hours field (kept for backward compatibility)
    working_hours: {
      monday: { start: String, end: String },
      tuesday: { start: String, end: String },
      wednesday: { start: String, end: String },
      thursday: { start: String, end: String },
      friday: { start: String, end: String },
      saturday: { start: String, end: String },
      sunday: { start: String, end: String },
    },

    specialization: {
      type: String,
    },
    address: {
      street: String,
      city: String,
      state: String,
      zip: String,
      country: String,
    },
    therapy_fee: {
      type: Number,
    },
    consultation_fee: {
      type: Number,
    },
    doctor_description: {
      type: String,
    },
    online_available: {
      type: Boolean,
      default: false,
    },
    youtube_videos: [
      {
        id: String,
        title: String,
        url: String,
        description: String,
      },
    ],
    languages_spoken: [String],
    biography: String,
    certifications: [String],
    experience_years: Number,

    // ACTIVE HOURS - controls when this doctor is allowed to use the app
    active_hours: {
      // "24h" = always available, "fixed" = restricted to start/end window
      type: {
        type: String,
        enum: ["24h", "fixed"],
        default: "24h",
      },
      // Only used when type === "fixed" — 24-hour format strings, e.g. "09:00", "18:00"
      start: {
        type: String,
        default: "09:00",
      },
      end: {
        type: String,
        default: "18:00",
      },
      // Master switch — set to false to block the doctor outside their window
      enabled: {
        type: Boolean,
        default: false, // false = no restriction enforced (backward-compatible default)
      },
    },
  },
  {
    timestamps: true,
  },
);

// Create indexes for frequently queried fields
doctorSchema.index({ doctor_email: 1 }, { unique: true });
doctorSchema.index({ tenant_id: 1 });
doctorSchema.index({ organization_name: 1 });
// NEW INDEXES for location-based queries
doctorSchema.index({ "assigned_locations.location_id": 1 });
doctorSchema.index({ "assigned_locations.is_active": 1 });
doctorSchema.index({ tenant_id: 1, "assigned_locations.location_id": 1 });

// Virtual for doctor's full name
doctorSchema.virtual("fullName").get(function () {
  return `${this.doctor_first_name} ${this.doctor_last_name}`;
});

// Pre-save middleware to ensure email is lowercase
doctorSchema.pre("save", function (next) {
  if (this.isModified("doctor_email")) {
    this.doctor_email = this.doctor_email.toLowerCase();
  }
  next();
});

// Method to add a patient to the doctor's list
doctorSchema.methods.addPatient = function (patientId) {
  if (!this.patients.includes(patientId)) {
    this.patients.push(patientId);
    return this.save();
  }
  return Promise.resolve(this);
};

// Method to remove a patient from the doctor's list
doctorSchema.methods.removePatient = function (patientId) {
  this.patients = this.patients.filter((id) => !id.equals(patientId));
  return this.save();
};

// Method to check if doctor is attending to a specific patient
doctorSchema.methods.isAttendingPatient = function (patientId) {
  return this.patients.some((id) => id.equals(patientId));
};

// NEW METHODS for location management

// Assign a location to the doctor
doctorSchema.methods.assignLocation = function (locationData) {
  const existingIndex = this.assigned_locations.findIndex(
    (loc) => loc.location_id === locationData.location_id,
  );

  if (existingIndex > -1) {
    // Update existing location
    this.assigned_locations[existingIndex] = {
      ...this.assigned_locations[existingIndex].toObject(),
      ...locationData,
    };
  } else {
    // Add new location
    this.assigned_locations.push(locationData);
  }

  return this.save();
};

// Remove a location assignment
doctorSchema.methods.removeLocation = function (locationId) {
  this.assigned_locations = this.assigned_locations.filter(
    (loc) => loc.location_id !== locationId,
  );
  return this.save();
};

// Get active locations only
doctorSchema.methods.getActiveLocations = function () {
  return this.assigned_locations.filter((loc) => loc.is_active);
};

// Check if doctor is assigned to a specific location
doctorSchema.methods.isAssignedToLocation = function (locationId) {
  return this.assigned_locations.some(
    (loc) => loc.location_id === locationId && loc.is_active,
  );
};

// Update working hours for a specific location
doctorSchema.methods.updateLocationSchedule = function (
  locationId,
  scheduleData,
) {
  const location = this.assigned_locations.find(
    (loc) => loc.location_id === locationId,
  );

  if (!location) {
    throw new Error("Location not found");
  }

  if (scheduleData.working_hours) {
    location.working_hours = scheduleData.working_hours;
  }
  if (scheduleData.has_fixed_schedule !== undefined) {
    location.has_fixed_schedule = scheduleData.has_fixed_schedule;
  }
  if (scheduleData.schedule_notes !== undefined) {
    location.schedule_notes = scheduleData.schedule_notes;
  }

  return this.save();
};

// Export the model in a way that supports tenant isolation
module.exports = {
  getDoctorModel: function (connection) {
    return connection.model("Doctor", doctorSchema, "doctors");
  },
  doctorSchema,
};
