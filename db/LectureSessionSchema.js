const mongoose = require("mongoose");
const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;

/**
 * Absent Patient Sub-Schema
 * Embedded subdocument for tracking absentees in a lecture
 */
const AbsentPatientSchema = new Schema({
  patient_id: { type: String, required: true },
  patient_name: { type: String, required: true },
  reason: { type: String, default: "Not provided" },
});

/**
 * Lecture Session Schema
 * Represents large group sessions (lectures) where all patients are expected to attend
 */
const LectureSessionSchema = new Schema(
  {
    // ─── Core Info ───────────────────────────────────────────────────
    lecture_number: { type: Number, required: true },

    topic_name: { type: String, required: true, trim: true },

    description: { type: String, trim: true, default: "" },

    // ─── Counselor Info ──────────────────────────────────────────────
    counselor_id: { type: ObjectId, required: true, ref: "Doctor" },

    counselor_name: { type: String, required: true },

    counselor_notes: { type: String, default: "" },

    // ─── Attendance ──────────────────────────────────────────────────
    total_patients: { type: Number, required: true },

    absent_patients: [AbsentPatientSchema],

    // Auto-computed via pre-save hook (total_patients - absent_patients.length)
    attendance_count: { type: Number, default: 0 },

    // ─── Date & Time (IST auto-stamped) ─────────────────────────────
    lecture_date: { type: String, required: true }, // Format: YYYY-MM-DD
    lecture_start_time: { type: String, required: true }, // Format: HH:mm
    lecture_end_time: { type: String, default: null }, // Format: HH:mm

    // ─── Location ────────────────────────────────────────────────────
    location_id: { type: String, default: null },
    location_name: { type: String, default: null },
    location_address: { type: String, default: null },

    // ─── Meta ────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ["Scheduled", "in_progress", "Completed", "Cancelled"],
      default: "Completed",
    },

    source: {
      type: String,
      enum: ["patient", "doctor"],
      default: "doctor",
    },

    created_by: { type: ObjectId, ref: "Doctor" },
  },
  {
    timestamps: true, // createdAt + updatedAt
  },
);

// ─── Pre-save Hook: auto-compute attendance_count ─────────────────────────
LectureSessionSchema.pre("save", function (next) {
  this.attendance_count =
    this.total_patients - (this.absent_patients?.length || 0);
  next();
});

// ─── Virtual: absent count ────────────────────────────────────────────────
LectureSessionSchema.virtual("absent_count").get(function () {
  return this.absent_patients?.length || 0;
});

// ─── Virtual: attendance percentage ──────────────────────────────────────
LectureSessionSchema.virtual("attendance_percentage").get(function () {
  if (!this.total_patients) return 0;
  return ((this.attendance_count / this.total_patients) * 100).toFixed(2);
});

LectureSessionSchema.set("toJSON", { virtuals: true });
LectureSessionSchema.set("toObject", { virtuals: true });

// ─── Indexes ──────────────────────────────────────────────────────────────
LectureSessionSchema.index({ counselor_id: 1, lecture_date: -1 });
LectureSessionSchema.index({ status: 1, lecture_date: -1 });
LectureSessionSchema.index({ topic_name: 1 });

// ─── Export (matches exact pattern from therepy.js) ───────────────────────
module.exports = {
  getLectureSessionModel: function (connection) {
    return connection.model(
      "LectureSession",
      LectureSessionSchema,
      "lecture_sessions", // explicit collection name, same as "therepys" pattern
    );
  },
};
