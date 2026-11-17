const moment = require("moment-timezone");
const { getLectureSessionModel } = require("../db/LectureSessionSchema");
const { getPatientModel } = require("../db/patientSchema"); // adjust path as needed

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: resolve absent patients array from raw request input
// Validates IDs against DB and maps to the AbsentPatientSchema shape
// ─────────────────────────────────────────────────────────────────────────────
const resolveAbsentPatients = async (absentInput = [], Patient) => {
  if (!absentInput.length) return [];

  const absentIds = absentInput.map((p) => p.contactId);

  // Catch duplicates early
  if (new Set(absentIds).size !== absentIds.length) {
    throw {
      status: 400,
      msg: "Duplicate patient IDs found in absent_patients.",
    };
  }

  const foundPatients = await Patient.find({ _id: { $in: absentIds } });
  const foundMap = new Map(foundPatients.map((p) => [p._id.toString(), p]));

  const missingIds = absentIds.filter((id) => !foundMap.has(id));
  if (missingIds.length) {
    throw {
      status: 404,
      msg: "Some absent patients were not found.",
      missing_ids: missingIds,
    };
  }

  return absentInput.map((p) => {
    const doc = foundMap.get(p.contactId);
    return {
      patient_id: p.contactId,
      patient_name: `${doc.patient_first_name} ${doc.patient_last_name}`,
      reason: p.reason || "Not provided",
    };
  });
};
// ─────────────────────────────────────────────────────────────────────────────
// GET ALL + SEARCH  GET /lecture-sessions
// All params are optional — omitting all returns the full paginated list
//
// Query params:
//   q              → global search (topic_name, description, counselor_name, counselor_notes)
//   topic          → partial match on topic_name
//   counselor_name → partial match on counselor_name
//   counselor_id   → exact match
//   absent_patient → search by absent patient name inside subdocument array
//   status         → exact match
//   date           → exact date YYYY-MM-DD
//   from_date      → range start YYYY-MM-DD
//   to_date        → range end YYYY-MM-DD
//   min_attendance → minimum attendance_count
//   max_absent     → maximum absent patients count
//   page           → default 1
//   limit          → default 20
// ─────────────────────────────────────────────────────────────────────────────
const getLectureSessions = async (req, res) => {
  try {
    const { orgDb, query } = req;
    const LectureSession = getLectureSessionModel(orgDb);

    const {
      q,
      topic,
      counselor_name,
      counselor_id,
      absent_patient,
      status,
      date,
      from_date,
      to_date,
      min_attendance,
      max_absent,
      page = 1,
      limit = 20,
    } = query;

    const filter = {};

    // Global search across key text fields
    if (q) {
      filter.$or = [
        { topic_name: { $regex: q, $options: "i" } },
        { description: { $regex: q, $options: "i" } },
        { counselor_name: { $regex: q, $options: "i" } },
        { counselor_notes: { $regex: q, $options: "i" } },
      ];
    }

    // Field-specific filters
    if (topic) filter.topic_name = { $regex: topic, $options: "i" };
    if (counselor_name)
      filter.counselor_name = { $regex: counselor_name, $options: "i" };
    if (counselor_id) filter.counselor_id = counselor_id;
    if (status) filter.status = status;

    // Search inside absent_patients subdocument array
    if (absent_patient) {
      filter["absent_patients.patient_name"] = {
        $regex: absent_patient,
        $options: "i",
      };
    }

    // Date: exact takes priority over range
    if (date) {
      filter.lecture_date = date;
    } else if (from_date || to_date) {
      filter.lecture_date = {};
      if (from_date) filter.lecture_date.$gte = from_date;
      if (to_date) filter.lecture_date.$lte = to_date;
    }

    // Attendance filters
    if (min_attendance)
      filter.attendance_count = { $gte: parseInt(min_attendance) };
    if (max_absent) {
      filter.$expr = {
        $lte: [{ $size: "$absent_patients" }, parseInt(max_absent)],
      };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [lectures, total] = await Promise.all([
      LectureSession.find(filter)
        .sort({ lecture_date: -1, lecture_start_time: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      LectureSession.countDocuments(filter),
    ]);

    return res.status(200).json({
      msg: "Lecture sessions fetched successfully.",
      total,
      page: parseInt(page),
      pages: Math.ceil(total / parseInt(limit)),
      lectures,
    });
  } catch (error) {
    console.error("Error fetching lecture sessions:", error);
    return res
      .status(500)
      .json({ msg: "Internal server error", details: error.message });
  }
};
// ─────────────────────────────────────────────────────────────────────────────
// CREATE  POST /lecture-sessions
// ─────────────────────────────────────────────────────────────────────────────
const createLectureSession = async (req, res) => {
  try {
    const { body: data, orgDb } = req;
    const LectureSession = getLectureSessionModel(orgDb);
    const Patient = getPatientModel(orgDb);

    const {
      lecture_number,
      topic_name,
      description,
      total_patients,
      absent_patients = [],
      location_id,
      location_name,
      location_address,
      counselor_notes,
      status,
    } = data;

    // ── Validation ──────────────────────────────────────────────────────────
    if (!lecture_number || !topic_name || !total_patients) {
      return res.status(400).json({
        msg: "lecture_number, topic_name, and total_patients are required.",
      });
    }

    if (absent_patients.length > total_patients) {
      return res.status(400).json({
        msg: "Absent patients count cannot exceed total patients.",
      });
    }

    // ── Resolve & validate absent patients ──────────────────────────────────
    let resolvedAbsentPatients;
    try {
      resolvedAbsentPatients = await resolveAbsentPatients(
        absent_patients,
        Patient,
      );
    } catch (err) {
      return res
        .status(err.status || 400)
        .json({ msg: err.msg, missing_ids: err.missing_ids });
    }

    // ── Auto-stamp IST timestamp ─────────────────────────────────────────────
    const now = moment().tz("Asia/Kolkata");

    // ── Build & save ─────────────────────────────────────────────────────────
    const newLecture = new LectureSession({
      lecture_number,
      topic_name,
      description: description || "",
      counselor_id: req.user.doctor_id,
      counselor_name: `${req.user.doctor_first_name} ${req.user.doctor_last_name}`,
      counselor_notes: counselor_notes || "",
      total_patients,
      absent_patients: resolvedAbsentPatients,
      lecture_date: now.format("YYYY-MM-DD"),
      lecture_start_time: now.format("HH:mm"),
      location_id: location_id || null,
      location_name: location_name || null,
      location_address: location_address || null,
      status: status || "Completed",
      source: "doctor",
      created_by: req.user.doctor_id,
    });

    const saved = await newLecture.save();

    return res.status(201).json({
      msg: "Lecture session recorded successfully.",
      lecture: saved,
    });
  } catch (error) {
    console.error("Error creating lecture session:", error);
    return res
      .status(500)
      .json({ msg: "Internal server error", details: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET ALL  GET /lecture-sessions
// Supports optional query filters: status, counselor_id, date, topic
// ─────────────────────────────────────────────────────────────────────────────
const getAllLectureSessions = async (req, res) => {
  try {
    const { orgDb, query } = req;
    const LectureSession = getLectureSessionModel(orgDb);

    const {
      status,
      counselor_id,
      date, // exact date YYYY-MM-DD
      from_date, // range start
      to_date, // range end
      topic, // partial match on topic_name
      page = 1,
      limit = 20,
    } = query;

    const filter = {};
    if (status) filter.status = status;
    if (counselor_id) filter.counselor_id = counselor_id;
    if (topic) filter.topic_name = { $regex: topic, $options: "i" };

    // Date filtering
    if (date) {
      filter.lecture_date = date;
    } else if (from_date || to_date) {
      filter.lecture_date = {};
      if (from_date) filter.lecture_date.$gte = from_date;
      if (to_date) filter.lecture_date.$lte = to_date;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [lectures, total] = await Promise.all([
      LectureSession.find(filter)
        .sort({ lecture_date: -1, lecture_start_time: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      LectureSession.countDocuments(filter),
    ]);

    return res.status(200).json({
      msg: "Lecture sessions fetched successfully.",
      total,
      page: parseInt(page),
      pages: Math.ceil(total / parseInt(limit)),
      lectures,
    });
  } catch (error) {
    console.error("Error fetching lecture sessions:", error);
    return res
      .status(500)
      .json({ msg: "Internal server error", details: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET ONE  GET /lecture-sessions/:id
// ─────────────────────────────────────────────────────────────────────────────
const getLectureSessionById = async (req, res) => {
  try {
    const { orgDb, params } = req;
    const LectureSession = getLectureSessionModel(orgDb);

    const lecture = await LectureSession.findById(params.id);
    if (!lecture) {
      return res.status(404).json({ msg: "Lecture session not found." });
    }

    return res.status(200).json({ lecture });
  } catch (error) {
    console.error("Error fetching lecture session:", error);
    return res
      .status(500)
      .json({ msg: "Internal server error", details: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SEARCH  GET /lecture-sessions/search
// Full-text + field-level search with pagination
// ─────────────────────────────────────────────────────────────────────────────
const searchLectureSessions = async (req, res) => {
  try {
    const { orgDb, query } = req;
    const LectureSession = getLectureSessionModel(orgDb);

    const {
      q, // global search term: matches topic_name, counselor_name, description
      topic, // specific topic match
      counselor_name, // specific counselor name match
      absent_patient, // search by absent patient name
      status,
      from_date,
      to_date,
      min_attendance, // minimum attendance count
      max_absent, // maximum absent count
      page = 1,
      limit = 20,
    } = query;

    const filter = {};

    // Global search across key text fields
    if (q) {
      filter.$or = [
        { topic_name: { $regex: q, $options: "i" } },
        { description: { $regex: q, $options: "i" } },
        { counselor_name: { $regex: q, $options: "i" } },
        { counselor_notes: { $regex: q, $options: "i" } },
      ];
    }

    // Field-specific filters
    if (topic) filter.topic_name = { $regex: topic, $options: "i" };
    if (counselor_name)
      filter.counselor_name = { $regex: counselor_name, $options: "i" };
    if (status) filter.status = status;

    // Search by an absent patient's name inside the subdocument array
    if (absent_patient) {
      filter["absent_patients.patient_name"] = {
        $regex: absent_patient,
        $options: "i",
      };
    }

    // Date range
    if (from_date || to_date) {
      filter.lecture_date = {};
      if (from_date) filter.lecture_date.$gte = from_date;
      if (to_date) filter.lecture_date.$lte = to_date;
    }

    // Attendance filters
    if (min_attendance)
      filter.attendance_count = { $gte: parseInt(min_attendance) };
    if (max_absent) {
      // Use $expr to compare array length against a value
      filter.$expr = {
        $lte: [{ $size: "$absent_patients" }, parseInt(max_absent)],
      };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [results, total] = await Promise.all([
      LectureSession.find(filter)
        .sort({ lecture_date: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      LectureSession.countDocuments(filter),
    ]);

    return res.status(200).json({
      msg: "Search completed.",
      total,
      page: parseInt(page),
      pages: Math.ceil(total / parseInt(limit)),
      results,
    });
  } catch (error) {
    console.error("Error searching lecture sessions:", error);
    return res
      .status(500)
      .json({ msg: "Internal server error", details: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// EDIT  PATCH /lecture-sessions/:id
// Supports partial updates. absent_patients is fully replaced if provided.
// ─────────────────────────────────────────────────────────────────────────────
const updateLectureSession = async (req, res) => {
  try {
    const { body: data, orgDb, params } = req;
    const LectureSession = getLectureSessionModel(orgDb);
    const Patient = getPatientModel(orgDb);

    const lecture = await LectureSession.findById(params.id);
    if (!lecture) {
      return res.status(404).json({ msg: "Lecture session not found." });
    }

    // Prevent editing cancelled sessions
    if (lecture.status === "Cancelled") {
      return res
        .status(400)
        .json({ msg: "Cannot edit a cancelled lecture session." });
    }

    const {
      topic_name,
      description,
      counselor_notes,
      total_patients,
      absent_patients, // if sent, fully replaces the existing array
      lecture_end_time, // can be set after lecture ends
      location_id,
      location_name,
      location_address,
      status,
    } = data;

    // Apply simple scalar updates
    if (topic_name !== undefined) lecture.topic_name = topic_name;
    if (description !== undefined) lecture.description = description;
    if (counselor_notes !== undefined)
      lecture.counselor_notes = counselor_notes;
    if (lecture_end_time !== undefined)
      lecture.lecture_end_time = lecture_end_time;
    if (location_id !== undefined) lecture.location_id = location_id;
    if (location_name !== undefined) lecture.location_name = location_name;
    if (location_address !== undefined)
      lecture.location_address = location_address;
    if (status !== undefined) lecture.status = status;

    // Update total_patients and re-validate absent count
    if (total_patients !== undefined) {
      lecture.total_patients = total_patients;
    }

    // Replace absent_patients array if provided
    if (absent_patients !== undefined) {
      const effectiveTotalPatients = total_patients ?? lecture.total_patients;

      if (absent_patients.length > effectiveTotalPatients) {
        return res.status(400).json({
          msg: "Absent patients count cannot exceed total patients.",
        });
      }

      try {
        lecture.absent_patients = await resolveAbsentPatients(
          absent_patients,
          Patient,
        );
      } catch (err) {
        return res
          .status(err.status || 400)
          .json({ msg: err.msg, missing_ids: err.missing_ids });
      }
    }

    // pre-save hook will recompute attendance_count automatically
    const updated = await lecture.save();

    return res.status(200).json({
      msg: "Lecture session updated successfully.",
      lecture: updated,
    });
  } catch (error) {
    console.error("Error updating lecture session:", error);
    return res
      .status(500)
      .json({ msg: "Internal server error", details: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// ADD ABSENT PATIENT  PATCH /lecture-sessions/:id/absent
// Add a single patient to absent list without replacing the whole array
// ─────────────────────────────────────────────────────────────────────────────
const addAbsentPatient = async (req, res) => {
  try {
    const { body: data, orgDb, params } = req;
    const LectureSession = getLectureSessionModel(orgDb);
    const Patient = getPatientModel(orgDb);

    const lecture = await LectureSession.findById(params.id);
    if (!lecture)
      return res.status(404).json({ msg: "Lecture session not found." });

    if (lecture.status === "Cancelled") {
      return res
        .status(400)
        .json({ msg: "Cannot modify a cancelled lecture session." });
    }

    const { contactId, reason } = data;
    if (!contactId)
      return res.status(400).json({ msg: "contactId is required." });

    // Prevent duplicates
    const alreadyAbsent = lecture.absent_patients.some(
      (p) => p.patient_id.toString() === contactId,
    );
    if (alreadyAbsent) {
      return res.status(409).json({ msg: "Patient is already marked absent." });
    }

    // Validate patient exists
    const patient = await Patient.findById(contactId);
    if (!patient) return res.status(404).json({ msg: "Patient not found." });

    // Guard: can't have more absences than total
    if (lecture.absent_patients.length + 1 > lecture.total_patients) {
      return res.status(400).json({
        msg: "Absent patients count would exceed total patients.",
      });
    }

    lecture.absent_patients.push({
      patient_id: contactId,
      patient_name: `${patient.patient_first_name} ${patient.patient_last_name}`,
      reason: reason || "Not provided",
    });

    // pre-save hook recomputes attendance_count
    const updated = await lecture.save();

    return res.status(200).json({
      msg: "Absent patient added successfully.",
      lecture: updated,
    });
  } catch (error) {
    console.error("Error adding absent patient:", error);
    return res
      .status(500)
      .json({ msg: "Internal server error", details: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// REMOVE ABSENT PATIENT  DELETE /lecture-sessions/:id/absent/:patientId
// Mark a previously absent patient as present (remove from absent array)
// ─────────────────────────────────────────────────────────────────────────────
const removeAbsentPatient = async (req, res) => {
  try {
    const { orgDb, params } = req;
    const LectureSession = getLectureSessionModel(orgDb);

    const lecture = await LectureSession.findById(params.id);
    if (!lecture)
      return res.status(404).json({ msg: "Lecture session not found." });

    if (lecture.status === "Cancelled") {
      return res
        .status(400)
        .json({ msg: "Cannot modify a cancelled lecture session." });
    }

    const beforeCount = lecture.absent_patients.length;
    lecture.absent_patients = lecture.absent_patients.filter(
      (p) => p.patient_id.toString() !== params.patientId,
    );

    if (lecture.absent_patients.length === beforeCount) {
      return res
        .status(404)
        .json({ msg: "Patient not found in the absent list." });
    }

    const updated = await lecture.save();

    return res.status(200).json({
      msg: "Patient marked as present successfully.",
      lecture: updated,
    });
  } catch (error) {
    console.error("Error removing absent patient:", error);
    return res
      .status(500)
      .json({ msg: "Internal server error", details: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// CANCEL  PATCH /lecture-sessions/:id/cancel
// Soft-cancel instead of hard delete to preserve attendance history
// ─────────────────────────────────────────────────────────────────────────────
const cancelLectureSession = async (req, res) => {
  try {
    const { orgDb, params } = req;
    const LectureSession = getLectureSessionModel(orgDb);

    const lecture = await LectureSession.findById(params.id);
    if (!lecture)
      return res.status(404).json({ msg: "Lecture session not found." });

    if (lecture.status === "Cancelled") {
      return res
        .status(409)
        .json({ msg: "Lecture session is already cancelled." });
    }

    lecture.status = "Cancelled";
    const updated = await lecture.save();

    return res.status(200).json({
      msg: "Lecture session cancelled successfully.",
      lecture: updated,
    });
  } catch (error) {
    console.error("Error cancelling lecture session:", error);
    return res
      .status(500)
      .json({ msg: "Internal server error", details: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE  DELETE /lecture-sessions/:id
// Hard delete — use only for erroneous records; prefer cancel for audit trail
// ─────────────────────────────────────────────────────────────────────────────
const deleteLectureSession = async (req, res) => {
  try {
    const { orgDb, params } = req;
    const LectureSession = getLectureSessionModel(orgDb);

    const lecture = await LectureSession.findByIdAndDelete(params.id);
    if (!lecture)
      return res.status(404).json({ msg: "Lecture session not found." });

    return res.status(200).json({
      msg: "Lecture session permanently deleted.",
      deleted_id: params.id,
    });
  } catch (error) {
    console.error("Error deleting lecture session:", error);
    return res
      .status(500)
      .json({ msg: "Internal server error", details: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  createLectureSession,
  getLectureSessions,
  getLectureSessionById,
  updateLectureSession,
  addAbsentPatient,
  removeAbsentPatient,
  cancelLectureSession,
  deleteLectureSession,
};
