const mongoose = require("mongoose");
const { getPatientModel } = require("../db/patientSchema");
const { getDoctorModel } = require("../db/doctorschema");
const Organization = require("../db/OrganizationSchema");
const {
  uploadImageToAzure,
  generatepatientImageSasToken,
  deleteBlobFromAzure,
} = require("../utils/azureutils");
// Modified AllPatients controller using the patient schema
const VALID_SORT_FIELDS = [
  "patient_registration_date",
  "patient_first_name",
  "patient_last_name",
  "patient_email",
  "patient_phone",
];

const EXCLUDED_FIELDS = "-medical_history -notes -documents -consultations";

function buildTimeFilter(filterByTime) {
  if (filterByTime === "all") return {};
  const MS_PER_DAY = 86_400_000;
  const daysMap = { oneWeek: 7, oneMonth: 30, oneYear: 365 };
  const days = daysMap[filterByTime];
  if (!days) return {};
  return {
    patient_registration_date: {
      $gte: new Date(Date.now() - days * MS_PER_DAY),
    },
  };
}

function buildStatusFilter(status) {
  if (status === "active") return { status: { $ne: "Archived" } };
  if (status === "archived") return { status: "Archived" };
  return {}; // "all" → no filter
}

function buildSortObj(sortBy, sortOrder) {
  if (VALID_SORT_FIELDS.includes(sortBy)) {
    return { [sortBy]: sortOrder === "asc" ? 1 : -1 };
  }
  return { patient_registration_date: -1 };
}

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function phoneRegexFromDigits(digits) {
  if (!digits) return null;
  const pattern = digits.split("").join("[\\s\\-()+]*");
  return new RegExp(`${pattern}$`);
}

function identityRegexFromValue(value) {
  if (!value) return null;
  const escaped = String(value)
    .trim()
    .split("")
    .map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s\\-]*");
  return escaped ? new RegExp(`^${escaped}$`, "i") : null;
}

/**
 * Attaches SAS tokens only to patients that actually have an image.
 * Runs all Azure calls concurrently — no serial waiting.
 */
async function attachSasTokens(patients) {
  return Promise.all(
    patients.map(async (patient) => {
      if (!patient.patient_image) return patient;
      try {
        const url = await generatepatientImageSasToken(patient.patient_image);
        return { ...patient, patient_image: url };
      } catch {
        // Don't blow up the whole response if one SAS call fails
        return { ...patient, patient_image: null };
      }
    }),
  );
}

/**
 * Parses and validates common pagination/filter query params.
 * Returns null + sends a 400 if params are invalid.
 */
function parsePaginationParams(req, res) {
  const {
    page = 1,
    limit = 20,
    sortBy = "patient_registration_date",
    sortOrder = "desc",
    filterByTime = "all",
    status = "active",
  } = req.query;

  const pageNum = Number(page);
  const limitNum = Number(limit);
  const skip = (pageNum - 1) * limitNum;

  if (
    isNaN(skip) ||
    isNaN(limitNum) ||
    skip < 0 ||
    limitNum <= 0 ||
    limitNum > 100
  ) {
    res.status(400).json({
      message:
        "Invalid pagination parameters. Limit must be between 1 and 100.",
    });
    return null;
  }

  return { pageNum, limitNum, skip, sortBy, sortOrder, filterByTime, status };
}

// ─────────────────────────────────────────────
// Controllers
// ─────────────────────────────────────────────

const AllPatients = async (req, res) => {
  try {
    const params = parsePaginationParams(req, res);
    if (!params) return; // 400 already sent

    const { pageNum, limitNum, skip, sortBy, sortOrder, filterByTime, status } =
      params;

    const Patient = getPatientModel(req.orgDb);

    const query = {
      ...buildStatusFilter(status),
      ...buildTimeFilter(filterByTime),
    };

    const sortObj = buildSortObj(sortBy, sortOrder);

    // Skip the expensive countDocuments on pages beyond page 1 — the caller
    // already received totalCount on the first request.
    // Pass ?includeCount=true to force a recount (e.g. after a filter change).
    const needsCount = pageNum === 1 || req.query.includeCount === "true";

    const [patients, totalCount] = await Promise.all([
      Patient.find(query)
        .select(EXCLUDED_FIELDS)
        .sort(sortObj)
        .skip(skip)
        .limit(limitNum)
        .lean()
        .exec(),

      needsCount ? Patient.countDocuments(query).exec() : Promise.resolve(null),
    ]);

    if (patients.length === 0 && pageNum > 1) {
      return res
        .status(404)
        .json({ message: "No patients found for the specified page." });
    }

    const patientsWithSas = await attachSasTokens(patients);

    const totalPages =
      totalCount !== null ? Math.ceil(totalCount / limitNum) : null;

    return res.status(200).json({
      patients: patientsWithSas,
      currentPage: pageNum,
      totalPages,
      totalCount,
      pageSize: limitNum,
      hasNextPage: totalPages !== null ? pageNum < totalPages : null,
      hasPrevPage: pageNum > 1,
      filters: { sortBy, sortOrder, filterByTime, status },
    });
  } catch (error) {
    console.error("Error retrieving patients:", error);
    return res.status(500).json({
      message: "Internal server error",
      error:
        process.env.NODE_ENV === "production"
          ? "An error occurred"
          : error.message,
    });
  }
};

const getDoctorPatients = async (req, res) => {
  try {
    const params = parsePaginationParams(req, res);
    if (!params) return; // 400 already sent

    const { pageNum, limitNum, skip, sortBy, sortOrder, filterByTime, status } =
      params;

    const { doctorId } = req.query;
    const targetDoctorId = doctorId || req.doctor_id;

    if (!targetDoctorId) {
      return res
        .status(400)
        .json({ message: "Doctor ID is required to fetch patients." });
    }

    const Patient = getPatientModel(req.orgDb);

    const statusFilter = buildStatusFilter(status);
    const timeFilter = buildTimeFilter(filterByTime);
    const sortObj = buildSortObj(sortBy, sortOrder);

    // ── Optimised: two targeted index-friendly queries instead of one $or ──
    // MongoDB's $or forces a union of two index scans and can't use a single
    // compound index efficiently. Running two separate queries lets each one
    // hit its own compound index directly, then we deduplicate in JS.
    const sharedFilter = { ...statusFilter, ...timeFilter };

    const [primaryPatients, careTeamPatients, primaryCount, careTeamCount] =
      await Promise.all([
        Patient.find({ doctor_id: targetDoctorId, ...sharedFilter })
          .select(EXCLUDED_FIELDS)
          .sort(sortObj)
          .lean()
          .exec(),

        Patient.find({ "care_team.doctor_id": targetDoctorId, ...sharedFilter })
          .select(EXCLUDED_FIELDS)
          .sort(sortObj)
          .lean()
          .exec(),

        // Counts run in parallel too
        Patient.countDocuments({
          doctor_id: targetDoctorId,
          ...sharedFilter,
        }).exec(),
        Patient.countDocuments({
          "care_team.doctor_id": targetDoctorId,
          ...sharedFilter,
        }).exec(),
      ]);

    // Deduplicate by _id (a patient can appear in both result sets)
    const seen = new Set();
    const allPatients = [...primaryPatients, ...careTeamPatients].filter(
      (p) => {
        const id = p._id.toString();
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      },
    );

    // Re-apply sort after merge (both sub-lists are sorted; a proper merge sort
    // would be O(n) but for typical page sizes this is fast enough)
    const sortField = VALID_SORT_FIELDS.includes(sortBy)
      ? sortBy
      : "patient_registration_date";
    const sortDir = sortOrder === "asc" ? 1 : -1;
    allPatients.sort((a, b) => {
      if (a[sortField] < b[sortField]) return -sortDir;
      if (a[sortField] > b[sortField]) return sortDir;
      return 0;
    });

    // Manual pagination after merge
    const totalCount = allPatients.length; // deduplicated total
    const paginated = allPatients.slice(skip, skip + limitNum);
    const totalPages = Math.ceil(totalCount / limitNum);

    const patientsWithSas = await attachSasTokens(paginated);

    return res.status(200).json({
      patients: patientsWithSas,
      currentPage: pageNum,
      totalPages,
      totalCount,
      pageSize: limitNum,
      hasNextPage: pageNum < totalPages,
      hasPrevPage: pageNum > 1,
      filters: { sortBy, sortOrder, filterByTime, status },
    });
  } catch (error) {
    console.error("Error retrieving doctor's patients:", error);
    return res.status(500).json({
      message: "Internal server error",
      error:
        process.env.NODE_ENV === "production"
          ? "An error occurred"
          : error.message,
    });
  }
};
const getDoctorPatientCount = async (req, res) => {
  try {
    const Patient = getPatientModel(req.orgDb);
    const Doctor = getDoctorModel(req.orgDb);

    const doctor = await Doctor.findOne(
      { doctor_email: req.user.email },
      { _id: 1 },
    ).lean();

    if (!doctor) {
      return res.status(404).json({ message: "Doctor not found" });
    }

    const totalPatients = await Patient.countDocuments({
      doctor_id: doctor._id,
    });

    res.status(200).json({
      totalPatients,
    });
  } catch (error) {
    console.error("Error retrieving doctor's patient count:", error);
    res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};

const createReg = async (req, res) => {
  try {
    const {
      patient_first_name,
      patient_last_name,
      patient_email,
      patient_phone,
      referral_source,
      referral_details,
      location_name,
      location_id,
      patient_registration_date, // ← ADD THIS
    } = req.body;
    const { tenant_id, organization_name } = req.user;

    // Validate required fields
    const requiredFields = [
      "patient_first_name",
      "patient_last_name",
      "patient_phone",
      "referral_source",
    ];
    const missingFields = requiredFields.filter((field) => !req.body[field]);
    if (missingFields.length > 0) {
      return res.status(400).json({
        msg: "The following fields are required: " + missingFields.join(", "),
      });
    }

    // ==========================================
    // PATIENT IMAGE UPLOAD LOGIC (OPTIONAL)
    // ==========================================
    let patientImageUrl = null;
    if (req.file) {
      patientImageUrl = await uploadImageToAzure(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
      );
    }

    // Get Patient model for this organization
    const Patient = getPatientModel(req.orgDb);

    // Find the doctor in the organization's database
    const doctor = await req.orgDb.collection("doctors").findOne({
      doctor_email: req.user.email,
    });

    if (!doctor) {
      return res
        .status(404)
        .json({ msg: "Doctor not found in this organization" });
    }

    // ==========================================
    // UHID GENERATION LOGIC
    // ==========================================
    let generatedUHID = undefined;
    const organization = await Organization.findOne({ tenant_id });

    if (
      organization &&
      organization.organization_industry &&
      organization.organization_industry.toLowerCase() === "rehab"
    ) {
      const currentYear = new Date().getFullYear();
      const startOfYear = new Date(currentYear, 0, 1);

      // --- 1. Calculate All-Time Sequence ---
      const lastPatientAllTime = await Patient.findOne({
        UHID: { $exists: true, $ne: null },
      }).sort({ patient_registration_date: -1 });

      let nextAllTimeSequence = 1;

      if (lastPatientAllTime && lastPatientAllTime.UHID) {
        const lastUhidStr = lastPatientAllTime.UHID.toString();

        if (lastUhidStr.includes("/")) {
          const allTimeSeq = parseInt(lastUhidStr.split("/")[0], 10);
          if (!isNaN(allTimeSeq)) nextAllTimeSequence = allTimeSeq + 1;
        } else {
          const oldSeqStr = lastUhidStr.slice(0, -4);
          const oldSeq = parseInt(oldSeqStr, 10);
          if (!isNaN(oldSeq)) nextAllTimeSequence = oldSeq + 1;
        }
      }

      // --- 2. Calculate Current Year Sequence ---
      const lastPatientThisYear = await Patient.findOne({
        patient_registration_date: { $gte: startOfYear },
        UHID: { $exists: true, $ne: null },
      }).sort({ patient_registration_date: -1 });

      let nextYearlySequence = 1;

      if (lastPatientThisYear && lastPatientThisYear.UHID) {
        const lastYearlyUhidStr = lastPatientThisYear.UHID.toString();

        if (lastYearlyUhidStr.includes("/")) {
          const yearlySeq = parseInt(lastYearlyUhidStr.split("/")[1], 10);
          if (!isNaN(yearlySeq)) nextYearlySequence = yearlySeq + 1;
        } else {
          const countThisYear = await Patient.countDocuments({
            patient_registration_date: { $gte: startOfYear },
            UHID: { $exists: true, $ne: null },
          });
          nextYearlySequence = countThisYear + 1;
        }
      }

      const paddedAllTime = nextAllTimeSequence.toString().padStart(4, "0");
      const paddedYearly = nextYearlySequence.toString().padStart(4, "0");
      generatedUHID = `${paddedAllTime}/${paddedYearly}`;
    }

    // Create new patient document
    const newPatient = new Patient({
      patient_first_name,
      patient_last_name,
      patient_email,
      patient_phone,
      patient_registration_date: patient_registration_date
        ? new Date(patient_registration_date)
        : new Date(),
      doctor_id: doctor._id,
      doctor_name: `${doctor.doctor_first_name} ${doctor.doctor_last_name}`,
      referral_source,
      referral_details,
      location_name, // Adding location name
      location_id, // Adding location ID
      patient_image: patientImageUrl,
      ...(generatedUHID && { UHID: generatedUHID }),
    });

    const savedPatient = await newPatient.save();
    await Patient.findByIdAndUpdate(savedPatient._id, {
      $push: {
        patient_journey: {
          stage: "Registration",
          performed_by_id: doctor._id,
          performed_by_name: `${doctor.doctor_first_name} ${doctor.doctor_last_name}`,
          performed_at: new Date(),
        },
      },
    });
    return res.status(200).json({
      success: true,
      msg: "Patient registered successfully",
      patient: savedPatient,
    });
  } catch (error) {
    console.error("Error registering patient:", error);
    res
      .status(500)
      .json({ msg: "Internal server error", error: error.message });
  }
};

const exportAllPatients = async (req, res) => {
  try {
    const {
      sortBy = "patient_registration_date",
      sortOrder = "desc",
      filterByTime = "all",
      status = "active",
    } = req.query;

    const Patient = getPatientModel(req.orgDb);

    const query = {
      ...buildStatusFilter(status),
      ...buildTimeFilter(filterByTime),
    };

    const sortObj = buildSortObj(sortBy, sortOrder);

    const patients = await Patient.find(query)
      .select(EXCLUDED_FIELDS) // still strips medical_history / notes / documents / consultations
      .sort(sortObj)
      .lean()
      .exec();

    return res.status(200).json({
      patients,
      totalCount: patients.length,
      filters: { sortBy, sortOrder, filterByTime, status },
    });
  } catch (error) {
    console.error("Error exporting patients:", error);
    return res.status(500).json({
      message: "Internal server error",
      error:
        process.env.NODE_ENV === "production"
          ? "An error occurred"
          : error.message,
    });
  }
};

const UpdatePatient = async (req, res) => {
  try {
    const patientId = req.params.id;
    const Patient = getPatientModel(req.orgDb);

    const fieldMapping = {
      patient_first_name: "Name",
      patient_last_name: "Name",
      patient_email: "email",
      patient_phone: "phoneNumber",
    };

    const updateData = {};
    const liveSwitchData = {};

    const nestedConsentFields = ["is_agreed", "consent_date", "form_type"];

    Object.keys(req.body).forEach((key) => {
      if (
        req.body[key] !== null &&
        req.body[key] !== undefined &&
        req.body[key] !== ""
      ) {
        if (nestedConsentFields.includes(key)) {
          updateData[`consent_details.${key}`] = req.body[key];
        } else if (key === "consent_status") {
          updateData[`consent_details.status`] = req.body[key];
        } else {
          // Captures guardian_relation, treatment_days, etc.
          updateData[key] = req.body[key];
        }

        if (fieldMapping[key]) {
          if (key === "patient_first_name" || key === "patient_last_name") {
            liveSwitchData["Name"] = `${req.body.patient_first_name || ""} ${
              req.body.patient_last_name || ""
            }`.trim();
          } else {
            liveSwitchData[fieldMapping[key]] = req.body[key];
          }
        }
      }
    });

    try {
      if (req.files) {
        if (req.files.patient_image && req.files.patient_image[0]) {
          updateData.patient_image = await uploadImageToAzure(
            req.files.patient_image[0].buffer,
            req.files.patient_image[0].originalname,
            req.files.patient_image[0].mimetype,
          );
        }
        if (req.files.witness_photo && req.files.witness_photo[0]) {
          updateData.witness_photo_url = await uploadImageToAzure(
            req.files.witness_photo[0].buffer,
            req.files.witness_photo[0].originalname,
            req.files.witness_photo[0].mimetype,
          );
        }
      } else if (req.file) {
        if (req.file.fieldname === "witness_photo") {
          updateData.witness_photo_url = await uploadImageToAzure(
            req.file.buffer,
            req.file.originalname,
            req.file.mimetype,
          );
        } else {
          updateData.patient_image = await uploadImageToAzure(
            req.file.buffer,
            req.file.originalname,
            req.file.mimetype,
          );
        }
      }
    } catch (uploadError) {
      console.error("Failed to upload image(s):", uploadError);
      return res.status(500).json({
        message: "Failed to upload image(s)",
        error: uploadError.message,
      });
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ message: "No fields to update" });
    }

    const updatedPatient = await Patient.findByIdAndUpdate(
      patientId,
      { $set: updateData },
      { new: true, runValidators: true },
    ).lean();

    if (!updatedPatient) {
      return res.status(404).json({ message: "Patient not found in database" });
    }

    if (updatedPatient.patient_image) {
      updatedPatient.patient_image = await generatepatientImageSasToken(
        updatedPatient.patient_image,
      );
    }

    if (updatedPatient.witness_photo_url) {
      updatedPatient.witness_photo_url = await generatepatientImageSasToken(
        updatedPatient.witness_photo_url,
      );
    }

    return res.status(200).json({
      message: "Patient updated successfully",
      updatedPatient,
    });
  } catch (error) {
    console.error("Error updating patient:", error);
    return res
      .status(500)
      .json({ message: "Internal server error", error: error.message });
  }
};
/**
 * Links a patient record to an earlier patient record, marking the current
 * record as a relapse / re-admission tied to that prior episode of care.
 *
 * Route example: PATCH /patients/:id/link-relapse
 * Body: { previous_patient_id: "<ObjectId of the earlier patient record>", force?: boolean }
 *
 * `previous_patient_id` has a partial unique index on the Patient schema
 * (unique among ObjectId values, ignoring null), so a single prior record
 * can only ever be claimed as the "previous" record by one relapse record.
 */
/**
 * Links a patient record to an earlier patient record, marking the current
 * record as a relapse / re-admission tied to that prior episode of care.
 * Ensures a strict linear progression (no branching).
 */
const linkRelapsedPatient = async (req, res) => {
  try {
    const { id: patientId } = req.params;
    const { previous_patient_id, force } = req.body;

    // ── Basic validation ─────────────────────────────
    if (!previous_patient_id) {
      return res
        .status(400)
        .json({ message: "previous_patient_id is required" });
    }

    if (
      !mongoose.Types.ObjectId.isValid(patientId) ||
      !mongoose.Types.ObjectId.isValid(previous_patient_id)
    ) {
      return res
        .status(400)
        .json({ message: "Invalid patient ID(s) supplied" });
    }

    if (patientId === previous_patient_id) {
      return res
        .status(400)
        .json({ message: "A patient record cannot be linked to itself" });
    }

    const Patient = getPatientModel(req.orgDb);

    // ── Fetch both records concurrently ──────────────
    const [currentPatient, previousPatient] = await Promise.all([
      Patient.findById(patientId).select(
        "previous_patient_id patient_first_name patient_last_name",
      ),
      Patient.findById(previous_patient_id).select(
        "previous_patient_id patient_first_name patient_last_name",
      ),
    ]);

    if (!currentPatient) {
      return res.status(404).json({ message: "Patient not found" });
    }
    if (!previousPatient) {
      return res
        .status(404)
        .json({ message: "Previous patient record not found" });
    }

    // ── Don't silently overwrite an existing link ────
    if (currentPatient.previous_patient_id && !force) {
      return res.status(409).json({
        message:
          "This patient is already linked to a previous record. Pass force: true to overwrite.",
        existing_previous_patient_id: currentPatient.previous_patient_id,
      });
    }

    // ── NEW: Strict Linear Check (Prevent Branching) ─
    // Check if any *other* patient already claims this previous record.
    const existingSuccessor = await Patient.findOne({
      previous_patient_id: previous_patient_id,
      _id: { $ne: patientId }, // Ignore the current patient if they are just re-saving
    }).select("patient_first_name patient_last_name");

    if (existingSuccessor) {
      return res.status(409).json({
        message:
          "This previous patient record is already linked to another relapse record. A strict linear history is required.",
        existing_successor: `${existingSuccessor.patient_first_name} ${existingSuccessor.patient_last_name}`,
      });
    }

    // ── Guard against forming a cycle in the chain ───
    let cursor = previousPatient;
    let hops = 0;
    const MAX_HOPS = 50;
    while (cursor && cursor.previous_patient_id && hops < MAX_HOPS) {
      if (cursor.previous_patient_id.toString() === patientId) {
        return res.status(409).json({
          message:
            "Linking these records would create a circular relapse chain",
        });
      }
      cursor = await Patient.findById(cursor.previous_patient_id).select(
        "previous_patient_id",
      );
      hops += 1;
    }

    // ── Persist the link ──────────────────────────────
    let updatedPatient;
    try {
      updatedPatient = await Patient.findByIdAndUpdate(
        patientId,
        { $set: { previous_patient_id } },
        { new: true, runValidators: true },
      ).lean();
    } catch (err) {
      if (err.code === 11000) {
        return res.status(409).json({
          message:
            "This previous patient record is already linked to another relapse record",
        });
      }
      throw err;
    }

    return res.status(200).json({
      success: true,
      message: `${updatedPatient.patient_first_name} ${updatedPatient.patient_last_name} marked as a relapsed/re-admitted patient`,
      patient: updatedPatient,
    });
  } catch (error) {
    console.error("Error linking relapsed patient:", error);
    return res
      .status(500)
      .json({ message: "Internal server error", error: error.message });
  }
};

const PHONE_FIELDS = [
  "patient_phone",
  "guardian_phone",
  "guardian_phone_2",
  "patient_alternate_number",
];

/**
 * Finds patients who could be a "preceding" / earlier entry for the same
 * person — i.e. relapse/re-admission candidates — by matching on phone
 * number(s) or identity card number.
 *
 * Two ways to call it, and they can be combined:
 *
 *  1. By patient_id: GET /patients/potential-previous?patient_id=<id>
 *     Pulls that patient's own phone numbers + identity card and searches
 *     every OTHER patient record for an overlap.
 *
 *  2. Direct search (no patient_id needed): GET /patients/potential-previous?patient_phone=...&identity_card_number=...
 *     Same as a normal "check before you register" search — useful on the
 *     registration form, before a patient record even exists yet.
 */
const searchPotentialPreviousPatients = async (req, res) => {
  try {
    const Patient = getPatientModel(req.orgDb);
    const { patient_id, patient_phone, identity_card_number, limit } =
      req.query;

    let phoneInputs = [];
    let identityInputs = [];
    let excludeId = null;

    // ── Mode 1: derive search terms from an existing patient ──
    if (patient_id) {
      if (!mongoose.Types.ObjectId.isValid(patient_id)) {
        return res.status(400).json({ message: "Invalid patient_id" });
      }

      const sourcePatient = await Patient.findById(patient_id)
        .select(
          "patient_phone guardian_phone guardian_phone_2 patient_alternate_number identity_card",
        )
        .lean();

      if (!sourcePatient) {
        return res.status(404).json({ message: "Patient not found" });
      }

      excludeId = patient_id;
      phoneInputs.push(
        sourcePatient.patient_phone,
        sourcePatient.guardian_phone,
        sourcePatient.guardian_phone_2,
        sourcePatient.patient_alternate_number,
      );
      if (sourcePatient.identity_card?.number) {
        identityInputs.push(sourcePatient.identity_card.number);
      }
    }

    // ── Mode 2: direct search terms, usable standalone or to widen Mode 1 ──
    if (patient_phone) phoneInputs.push(patient_phone);
    if (identity_card_number) identityInputs.push(identity_card_number);

    phoneInputs = [...new Set(phoneInputs.filter(Boolean))];
    identityInputs = [...new Set(identityInputs.filter(Boolean))];

    if (phoneInputs.length === 0 && identityInputs.length === 0) {
      return res.status(400).json({
        message:
          "Provide a patient_id, patient_phone, or identity_card_number to search with",
      });
    }

    // ── Build the $or query ──
    const orConditions = [];

    phoneInputs.forEach((rawPhone) => {
      const regex = phoneRegexFromDigits(normalizePhone(rawPhone));
      if (!regex) return;
      PHONE_FIELDS.forEach((field) => {
        orConditions.push({ [field]: { $regex: regex } });
      });
    });

    identityInputs.forEach((rawId) => {
      const regex = identityRegexFromValue(rawId);
      if (!regex) return;
      orConditions.push({ "identity_card.number": { $regex: regex } });
    });

    if (orConditions.length === 0) {
      return res.status(400).json({
        message: "None of the supplied search values were usable",
      });
    }

    const query = { $or: orConditions };
    if (excludeId) {
      query._id = { $ne: excludeId };
    }

    const resultLimit = Math.min(Number(limit) || 10, 50);

    const matches = await Patient.find(query)
      .select(
        "patient_first_name patient_last_name patient_phone guardian_phone guardian_phone_2 patient_alternate_number identity_card patient_registration_date status previous_patient_id UHID patient_image doctor_name",
      )
      .sort({ patient_registration_date: -1 })
      .limit(resultLimit)
      .lean();

    const matchesWithSas = await attachSasTokens(matches);

    // ── Annotate *why* each candidate matched, for the UI ──
    const normalizedPhoneInputs = phoneInputs
      .map(normalizePhone)
      .filter(Boolean);
    const identityInputsCleaned = identityInputs.map((v) =>
      String(v).replace(/[\s-]/g, "").toLowerCase(),
    );

    const annotated = matchesWithSas.map((patient) => {
      const matched_on = [];

      PHONE_FIELDS.forEach((field) => {
        const fieldDigits = normalizePhone(patient[field]);
        if (fieldDigits && normalizedPhoneInputs.includes(fieldDigits)) {
          matched_on.push(field);
        }
      });

      const idNumber = patient.identity_card?.number;
      if (idNumber) {
        const cleanedId = String(idNumber).replace(/[\s-]/g, "").toLowerCase();
        if (identityInputsCleaned.includes(cleanedId)) {
          matched_on.push("identity_card");
        }
      }

      return { ...patient, matched_on };
    });

    return res.status(200).json({
      success: true,
      count: annotated.length,
      searched_with: {
        patient_id: patient_id || null,
        phone: phoneInputs,
        identity_card_number: identityInputs,
      },
      patients: annotated,
    });
  } catch (error) {
    console.error("Error searching potential previous patients:", error);
    return res
      .status(500)
      .json({ message: "Internal server error", error: error.message });
  }
};
// Add these imports at the top of your registrationController.js file[cite: 1]
const { getTherapySession } = require("../db/therepy"); // Adjust path to therepy.js[cite: 5]
const { getPatientAssessmentModel } = require("../db/patientAssessmentSchema"); // Adjust path[cite: 6]

const deletePatient = async (req, res) => {
  try {
    const patientId = req.params.id;
    const Patient = getPatientModel(req.orgDb);
    const TherapySession = getTherapySession(req.orgDb);
    const PatientAssessment = getPatientAssessmentModel(req.orgDb);

    // 1. Fetch the patient first to check for embedded references
    const patient = await Patient.findById(patientId).lean();

    if (!patient) {
      return res.status(404).json({ message: "Patient not found in database" });
    }

    // 2. Check if the patient has therapy plans or sessions stored in their arrays
    const hasPlans = patient.therapy_plans && patient.therapy_plans.length > 0;
    const hasSessionsInArray = patient.therepys && patient.therepys.length > 0;

    // 3. Double-check TherapySession and PatientAssessment collections directly
    const [sessionCount, assessmentCount] = await Promise.all([
      TherapySession.countDocuments({ patient_id: patientId.toString() }),
      PatientAssessment.countDocuments({ patient_id: patientId }),
    ]);

    // 4. Block deletion if any related records exist
    if (
      hasPlans ||
      hasSessionsInArray ||
      sessionCount > 0 ||
      assessmentCount > 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Cannot delete patient. They have active or historical treatment plans, sessions, or assessments attached.",
      });
    }

    // 5. Delete the patient's image from Azure if it exists
    if (patient.patient_image) {
      await deleteBlobFromAzure(patient.patient_image);
    }

    // 6. Safely delete the patient
    const deletedPatient = await Patient.findByIdAndDelete(patientId).lean();

    return res.status(200).json({
      success: true,
      message: "Patient deleted successfully",
      patient: deletedPatient,
    });
  } catch (error) {
    console.error("Error deleting patient:", error);
    return res.status(500).json({
      message: "Internal server error",
      error:
        process.env.NODE_ENV === "production"
          ? "An error occurred"
          : error.message,
    });
  }
};
module.exports = {
  createReg,
  UpdatePatient,
  AllPatients,
  getDoctorPatients,
  getDoctorPatientCount,
  exportAllPatients,
  linkRelapsedPatient,
  searchPotentialPreviousPatients,
  deletePatient,
};
