const mongoose = require("mongoose");
const ObjectId = mongoose.Types.ObjectId;
const {
  TherapyPlan,
  getTherapyPlanModel,
  getTherapySession,
} = require("../db/therepy");
const { getPatientModel } = require("../db/patientSchema");
const { getPaymentModel } = require("../db/paymentSchema");
const { getDoctorModel } = require("../db/doctorschema"); // Adjust path as needed
const moment = require("moment-timezone");

const getPatientTherapyPlans = async (req, res) => {
  try {
    const { patientId } = req.params;

    // Validate ObjectId format
    if (!ObjectId.isValid(patientId)) {
      return res.status(400).json({ message: "Invalid Patient ID format" });
    }

    const _id = new ObjectId(patientId);

    // Fetch only required fields in a single lightweight call
    const patient = await req.orgDb.collection("patients").findOne(
      { _id },
      {
        projection: {
          therapy_plans: 1,
          patient_first_name: 1,
          patient_last_name: 1,
        },
      },
    );

    if (!patient) {
      return res.status(404).json({ message: "Patient not found" });
    }

    const patient_name = `${patient.patient_first_name} ${patient.patient_last_name}`;

    // Directly handle empty or non-array values without nesting
    const therapyPlanIds = Array.isArray(patient.therapy_plans)
      ? patient.therapy_plans
          .filter((id) => ObjectId.isValid(id))
          .map((id) => new ObjectId(id))
      : [];

    // No valid ids — send empty response (same)
    if (therapyPlanIds.length === 0) {
      return res.status(200).json({ patient_name, therapy_plans: [] });
    }

    // Fetch all therapy plans in one query
    const therapy_plans = await req.orgDb
      .collection("plans")
      .find({ _id: { $in: therapyPlanIds } })
      .toArray();

    return res.status(200).json({ patient_name, therapy_plans });
  } catch (error) {
    console.error("Error in getPatientTherapyPlans:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

const getPlanTherapies = async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid Plan ID format" });
    }

    const plan = await req.orgDb
      .collection("plans")
      .findOne({ _id: new ObjectId(id) });

    if (!plan) {
      return res.status(404).json({ message: "Therapy plan not found" });
    }

    if (
      !plan.therapy_sessions ||
      !Array.isArray(plan.therapy_sessions) ||
      plan.therapy_sessions.length === 0
    ) {
      return res.status(200).json({
        therapy_name: plan.therapy_name,
        sessions: [],
      });
    }

    const sessionIds = plan.therapy_sessions.map((session) =>
      session._id instanceof ObjectId
        ? session._id
        : new ObjectId(session._id.$oid || session._id),
    );

    const therapySessions = await req.orgDb
      .collection("therepys") // Confirm this is the correct name
      .find({ _id: { $in: sessionIds } })
      .toArray();

    const sessions = therapySessions.map((therapy) => {
      const planSession = plan.therapy_sessions.find((session) =>
        session._id.equals(therapy._id),
      );

      return {
        _id: { $oid: therapy._id.toString() },
        ...therapy,
        status: planSession?.status || "scheduled",
      };
    });

    return res.status(200).json({
      ...plan,
      sessions,
    });
  } catch (error) {
    console.error("Error in getPlanTherapies:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};
const { getPrescriptionModel } = require("../db/prescriptionSchema");
const editTherapyPlan = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const Patient = getPatientModel(req.orgDb);
    const TherapyPlan = getTherapyPlanModel(req.orgDb);
    const Prescription = getPrescriptionModel(req.orgDb);

    // Check for empty updates
    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({ msg: "No updates provided" });
    }

    // Allowed fields based on schema (added discount_percentage just in case)
    const allowedFields = [
      "therapy_name",
      "patient_diagnosis",
      "patient_symptoms",
      "therapy_duration",
      "therapy_end",
      "therapy_start",
      "patient_therapy_category",
      "total_amount",
      "received_amount",
      "payment_type",
      "estimated_sessions",
      "per_session_amount",
      "status",
      "notes",
    ];

    // Filter updates
    const sanitizedUpdates = Object.keys(updates)
      .filter((key) => allowedFields.includes(key))
      .reduce((obj, key) => {
        obj[key] = updates[key];
        return obj;
      }, {});

    // Parse Prescription Data (if provided)
    let prescriptionUpdateData = null;
    if (req.body.prescription) {
      try {
        prescriptionUpdateData =
          typeof req.body.prescription === "string"
            ? JSON.parse(req.body.prescription)
            : req.body.prescription;
      } catch (error) {
        return res
          .status(400)
          .json({ error: "Invalid prescription data format" });
      }
    }

    if (Object.keys(sanitizedUpdates).length === 0 && !prescriptionUpdateData) {
      return res.status(400).json({ msg: "No valid fields to update" });
    }

    // Find the existing plan using Mongoose model
    const existingPlan = await TherapyPlan.findById(id);
    if (!existingPlan) {
      return res.status(404).json({ msg: "Therapy plan not found" });
    }

    // Get patient information
    const patient = await Patient.findOne({
      therapy_plans: new mongoose.Types.ObjectId(id),
    });

    if (!patient) {
      return res
        .status(404)
        .json({ msg: "Patient not found for this therapy plan" });
    }

    // --- PRESCRIPTION HANDLING LOGIC ---
    let prescriptionAction = "none";
    if (prescriptionUpdateData) {
      if (existingPlan.prescription_id) {
        // Update Existing Prescription
        const existingPrescription = await Prescription.findById(
          existingPlan.prescription_id,
        );
        if (existingPrescription) {
          existingPrescription.medications =
            prescriptionUpdateData.medications ||
            existingPrescription.medications;
          existingPrescription.vitals =
            prescriptionUpdateData.vitals || existingPrescription.vitals;
          existingPrescription.diagnosis =
            prescriptionUpdateData.diagnosis || existingPrescription.diagnosis;
          existingPrescription.notes =
            prescriptionUpdateData.notes !== undefined
              ? prescriptionUpdateData.notes
              : existingPrescription.notes;

          await existingPrescription.save();
          prescriptionAction = "updated";
        }
      } else {
        // Create New Prescription if none exists but medications are provided
        if (
          prescriptionUpdateData.medications &&
          prescriptionUpdateData.medications.length > 0
        ) {
          const prescriptionNumber =
            prescriptionUpdateData.prescription_number ||
            `PRE-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

          const newPrescription = new Prescription({
            prescription_number: prescriptionNumber,
            patient_id: patient._id,
            patient_name: `${patient.patient_first_name} ${patient.patient_last_name}`,
            doctor_id: req.user.doctor_id,
            doctor_name:
              req.user.doctor_name ||
              `${req.user.doctor_first_name || ""} ${req.user.doctor_last_name || ""}`.trim(),
            prescription_date: new Date(),
            vitals: prescriptionUpdateData.vitals || {},
            medications: prescriptionUpdateData.medications,
            diagnosis:
              prescriptionUpdateData.diagnosis ||
              existingPlan.patient_diagnosis ||
              "Therapy Plan Prescription",
            notes: prescriptionUpdateData.notes || "",
            status: "Active",
          });

          const savedPrescription = await newPrescription.save();
          existingPlan.prescription_id = savedPrescription._id; // Link to plan
          prescriptionAction = "created";
        }
      }
    }

    // Apply standard updates
    Object.keys(sanitizedUpdates).forEach((key) => {
      existingPlan[key] = sanitizedUpdates[key];
    });

    // Save the updated plan
    const updatedPlan = await existingPlan.save();

    // Calculate balance
    const balance = (
      parseFloat(updatedPlan.total_amount || "0") -
      parseFloat(updatedPlan.received_amount || "0")
    ).toFixed(2);

    return res.status(200).json({
      message: "Therapy plan updated successfully",
      prescriptionStatus: prescriptionAction,
      updatedPlan: {
        ...updatedPlan.toObject(),
        balance: balance, // Append calculated balance to response
      },
    });
  } catch (error) {
    console.error("Error updating therapy plan:", error);

    // Handle specific error types
    if (error.name === "ValidationError") {
      return res.status(400).json({
        msg: "Validation error",
        errors: Object.values(error.errors).map((e) => e.message),
      });
    }
    if (error.name === "CastError") {
      return res.status(400).json({ msg: "Invalid ID format" });
    }

    return res.status(500).json({
      msg: "Internal server error",
      error: error.message,
    });
  }
};

const closeTherapyPlan = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      closure_reason,
      closure_details,
      final_remarks,
      goal_achievement_percentage,
      treatment_outcome,
      follow_up_recommendations,
      closure_date,
      next_visit_date,
      prescription,
    } = req.body;
    const { user, orgDb } = req;

    if (!closure_reason) {
      return res.status(400).json({
        msg: "Closure reason is required to complete therapy plan",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ msg: "Invalid therapy plan ID format" });
    }

    const planObjectId = new mongoose.Types.ObjectId(id);
    const TherapyPlan = getTherapyPlanModel(orgDb);
    const Patient = getPatientModel(orgDb);

    const therapyPlan = await TherapyPlan.findById(planObjectId);
    if (!therapyPlan) {
      return res.status(404).json({ msg: "Therapy plan not found" });
    }

    if (
      therapyPlan.status === "Completed" ||
      therapyPlan.status === "completed"
    ) {
      return res.status(400).json({
        msg: "Therapy plan is already completed",
        completed_at: therapyPlan.closure_date || therapyPlan.updatedAt,
      });
    }

    const closureDate = closure_date ? new Date(closure_date) : new Date();
    const therapyStartDate = new Date(therapyPlan.therapy_start);

    if (closureDate < therapyStartDate) {
      return res.status(400).json({
        msg: "Closure date cannot be before therapy start date",
      });
    }

    const totalSessions = therapyPlan.therapy_sessions
      ? therapyPlan.therapy_sessions.length
      : 0;
    const completedSessions = therapyPlan.completed_sessions || 0;
    const totalAmount = parseFloat(therapyPlan.total_amount || 0);
    const receivedAmount = parseFloat(therapyPlan.received_amount || 0);
    const balance = parseFloat(therapyPlan.balance || 0);

    const doctorName =
      user.doctor_name ||
      `${user.doctor_first_name || ""} ${user.doctor_last_name || ""}`.trim() ||
      user.name;

    const closureData = {
      status: "Completed",
      closure_date: closureDate,
      closure_reason,
      closure_details: closure_details || "",
      final_remarks: final_remarks || "",
      treatment_outcome: treatment_outcome || "",
      follow_up_recommendations: follow_up_recommendations || "",
      next_visit_date: next_visit_date ? new Date(next_visit_date) : undefined,
      closed_by: user.doctor_id,
      closed_by_name: doctorName,

      goal_achievement:
        goal_achievement_percentage !== undefined
          ? Math.min(100, Math.max(0, goal_achievement_percentage))
          : therapyPlan.goal_achievement,

      final_completed_sessions: completedSessions,
      final_total_sessions: totalSessions,
      final_total_amount: totalAmount.toFixed(2),
      final_received_amount: receivedAmount.toFixed(2),
      final_balance: balance.toFixed(2),
      final_addons_amount: therapyPlan.addons_amount || 0,
      final_discount_percentage: therapyPlan.discount_percentage || 0,
      final_discount_amount: therapyPlan.discount_amount || "0",
      final_original_amount:
        therapyPlan.original_amount || therapyPlan.total_amount,
    };

    // --- POST-PLAN CARE PRESCRIPTION ---
    if (
      prescription &&
      prescription.medications &&
      prescription.medications.length > 0
    ) {
      const Prescription = getPrescriptionModel(orgDb);
      const patient = await Patient.findOne({
        therapy_plans: planObjectId,
      }).select("patient_first_name patient_last_name");

      if (patient) {
        const prescriptionNumber =
          prescription.prescription_number ||
          `PRE-CLOSURE-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

        const newPrescription = new Prescription({
          prescription_number: prescriptionNumber,
          patient_id: patient._id,
          patient_name: `${patient.patient_first_name} ${patient.patient_last_name}`,
          doctor_id: user.doctor_id,
          doctor_name: doctorName,
          prescription_date: new Date(),
          vitals: prescription.vitals || {},
          medications: prescription.medications,
          diagnosis:
            prescription.diagnosis ||
            therapyPlan.patient_diagnosis ||
            "Post-Plan Care Prescription",
          notes: prescription.notes || "",
          status: "Active",
        });

        const savedPrescription = await newPrescription.save();
        closureData.post_care_prescription_id = savedPrescription._id;
      }
    }

    // Apply closure data to plan document
    Object.keys(closureData).forEach((key) => {
      therapyPlan[key] = closureData[key];
    });

    therapyPlan.notes.push({
      note: `Therapy completed: ${closure_reason}${
        closure_details ? ` - ${closure_details}` : ""
      }`,
      doctor_name: doctorName,
      date: closureDate,
    });

    const updatedPlan = await therapyPlan.save();

    // ── SYNC PATIENT JOURNEY & NEXT VISIT DATE ──
    const journeyEntry = {
      stage: "Treatment Plan Completed",
      performed_by_id: user.doctor_id,
      performed_by_name: doctorName,
      performed_at: closureDate,
      notes: `Plan closed: ${therapyPlan.therapy_name || "Treatment Plan"} (${closure_reason})`,
      status: "Completed",
    };

    const patientSetFields = {};
    if (closureData.next_visit_date) {
      patientSetFields.follow_Up_Date = closureData.next_visit_date;
    }

    // Single-roundtrip atomic update with deduplication ($ne)
    const updateResult = await Patient.updateOne(
      {
        therapy_plans: planObjectId,
        "patient_journey.stage": { $ne: "Treatment Plan Completed" },
      },
      {
        ...(Object.keys(patientSetFields).length > 0 && {
          $set: patientSetFields,
        }),
        $push: { patient_journey: journeyEntry },
      },
    );

    // If journey marker already existed, update only follow_Up_Date if specified
    if (
      updateResult.matchedCount === 0 &&
      Object.keys(patientSetFields).length > 0
    ) {
      await Patient.updateOne(
        { therapy_plans: planObjectId },
        { $set: patientSetFields },
      );
    }

    const response = {
      message: "Therapy plan completed successfully",
      therapyPlan: {
        id: updatedPlan._id,
        therapy_name: updatedPlan.therapy_name,
        status: updatedPlan.status,
        closure_date: updatedPlan.closure_date,
        closure_reason: updatedPlan.closure_reason,
        closure_details: updatedPlan.closure_details,
        closed_by: updatedPlan.closed_by_name,
        next_visit_date: updatedPlan.next_visit_date || null,
        post_care_prescription_id:
          updatedPlan.post_care_prescription_id || null,
      },
      statistics: {
        total_sessions: totalSessions,
        completed_sessions: completedSessions,
        completion_rate:
          totalSessions > 0
            ? `${Math.round((completedSessions / totalSessions) * 100)}%`
            : "0%",
        goal_achievement: `${closureData.goal_achievement}%`,
      },
      financial_summary: {
        original_amount: closureData.final_original_amount,
        discount_applied: closureData.final_discount_amount,
        discount_percentage: `${closureData.final_discount_percentage}%`,
        final_amount: closureData.final_total_amount,
        received_amount: closureData.final_received_amount,
        balance: closureData.final_balance,
        payment_completion:
          totalAmount > 0
            ? `${Math.round((receivedAmount / totalAmount) * 100)}%`
            : "100%",
      },
      therapy_duration: {
        start_date: updatedPlan.therapy_start,
        end_date: updatedPlan.therapy_end,
        actual_closure_date: closureDate,
      },
    };

    if (balance > 0) {
      response.warning = `Outstanding balance of ₹${balance.toFixed(2)} remains`;
    }

    return res.status(200).json(response);
  } catch (error) {
    console.error("Error closing therapy plan:", {
      message: error.message,
      stack: error.stack,
    });

    if (error.name === "ValidationError") {
      return res.status(400).json({
        msg: "Validation error",
        errors: Object.values(error.errors).map((e) => e.message),
      });
    }

    if (error.name === "CastError") {
      return res.status(400).json({ msg: "Invalid therapy plan ID format" });
    }

    return res.status(500).json({
      msg: "Server error while closing therapy plan",
      error: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
};

const revertTherapyPlan = async (req, res) => {
  try {
    const { id } = req.params;
    const { user, orgDb } = req;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ msg: "Invalid therapy plan ID format" });
    }

    const planObjectId = new mongoose.Types.ObjectId(id);
    const TherapyPlan = getTherapyPlanModel(orgDb);
    const Prescription = getPrescriptionModel(orgDb);
    const Patient = getPatientModel(orgDb);

    const therapyPlan = await TherapyPlan.findById(planObjectId);

    if (!therapyPlan) {
      return res.status(404).json({ msg: "Therapy plan not found" });
    }

    if (
      therapyPlan.status !== "Completed" &&
      therapyPlan.status !== "completed"
    ) {
      return res
        .status(400)
        .json({ msg: "Only completed plans can be reverted." });
    }

    // 1. Delete post-care prescription if it exists
    if (therapyPlan.post_care_prescription_id) {
      await Prescription.findByIdAndDelete(
        therapyPlan.post_care_prescription_id,
      );
      therapyPlan.post_care_prescription_id = undefined;
    }

    // 2. Reset status and clear closure-specific fields
    therapyPlan.status = "Active";
    therapyPlan.closure_date = undefined;
    therapyPlan.closure_reason = undefined;
    therapyPlan.closure_details = undefined;
    therapyPlan.final_remarks = undefined;
    therapyPlan.treatment_outcome = undefined;
    therapyPlan.follow_up_recommendations = undefined;
    therapyPlan.next_visit_date = undefined;
    therapyPlan.closed_by = undefined;
    therapyPlan.closed_by_name = undefined;

    // 3. Clear final statistical snapshots
    therapyPlan.final_completed_sessions = undefined;
    therapyPlan.final_total_sessions = undefined;
    therapyPlan.final_total_amount = undefined;
    therapyPlan.final_received_amount = undefined;
    therapyPlan.final_balance = undefined;
    therapyPlan.final_addons_amount = undefined;
    therapyPlan.final_discount_percentage = undefined;
    therapyPlan.final_discount_amount = undefined;
    therapyPlan.final_original_amount = undefined;

    const doctorName =
      user.doctor_name ||
      `${user.doctor_first_name || ""} ${user.doctor_last_name || ""}`.trim() ||
      user.name;

    // 4. Add tracking note for the audit trail
    therapyPlan.notes.push({
      note: "Therapy plan reopened. Post-care prescription deleted and status reverted to Active.",
      doctor_name: doctorName,
      date: new Date(),
    });

    await therapyPlan.save();
    // 5. Atomic Patient Update: unset follow_Up_Date AND remove "Treatment Plan Completed" marker
    await Patient.updateOne(
      { therapy_plans: planObjectId },
      {
        $unset: { follow_Up_Date: 1 },
        $pull: { patient_journey: { stage: "Treatment Plan Completed" } },
      },
    );

    return res.status(200).json({
      message: "Therapy plan reverted to Active successfully",
      therapyPlan,
    });
  } catch (error) {
    console.error("Error while reverting plan:", error);
    return res.status(500).json({
      msg: "Server error while reverting plan",
      error: error.message,
    });
  }
};
const getGlobalAftercareReport = async (req, res) => {
  try {
    // ── 1. Boot models ────────────────────────────────────────────────────────
    const TherapySessionModel = getTherapySession(req.orgDb);
    const TherapyPlanModel = getTherapyPlanModel(req.orgDb);
    const PatientModel = getPatientModel(req.orgDb);

    // ── 2. Extract query filters ──────────────────────────────────────────────
    // Note: 'status' here applies to the *session* status (e.g., Scheduled, Completed)
    const { from, to, status } = req.query;

    // ── 3. Build Session Query & Fetch Aftercare Sessions ─────────────────────
    // Sessions are standalone now — query directly by type, no plan dependency
    const sessionQuery = { therepy_type: "Aftercare" };

    if (from || to) {
      sessionQuery.therepy_date = {};
      if (from) sessionQuery.therepy_date.$gte = from; // "YYYY-MM-DD"
      if (to) sessionQuery.therepy_date.$lte = to;
    }

    if (status) {
      const statusList = status.split(",").map((s) => s.trim());
      sessionQuery.status = { $in: statusList };
    }

    // Query sessions while strictly excluding attachments (session images)
    const aftercareSessions = await TherapySessionModel.find(sessionQuery)
      .select("-attachments")
      .sort({ therepy_date: 1 })
      .lean();

    if (!aftercareSessions.length) {
      return res.status(200).json({
        report_type: "Patient-Based Aftercare Report",
        applied_filters: {
          from: from || null,
          to: to || null,
          session_status: status || null,
        },
        global_statistics: {
          total_patients_reported: 0,
          total_aftercare_sessions_matched: 0,
        },
        patients: [],
      });
    }

    // ── 4. Group matching aftercare sessions by patient_id ────────────────────
    const sessionsByPatientMap = aftercareSessions.reduce((acc, s) => {
      if (s.patient_id) {
        const patientKey = s.patient_id.toString();
        if (!acc[patientKey]) acc[patientKey] = [];
        acc[patientKey].push(s);
      }
      return acc;
    }, {});

    const patientIds = Object.keys(sessionsByPatientMap);

    // ── 5. Fetch only patients who have matching aftercare sessions ───────────
    const patients = await PatientModel.find(
      { _id: { $in: patientIds } },
      {
        patient_first_name: 1,
        patient_last_name: 1,
        UHID: 1,
        therapy_plans: 1,
        patient_image: 1,
      },
    ).lean();

    // ── 6. Fetch reference plan info for context (status only, no gating) ────
    const allPlanIds = patients.reduce((acc, p) => {
      if (Array.isArray(p.therapy_plans)) {
        acc.push(
          ...p.therapy_plans.filter((id) =>
            mongoose.Types.ObjectId.isValid(id),
          ),
        );
      }
      return acc;
    }, []);

    const referencePlans = allPlanIds.length
      ? await TherapyPlanModel.find(
          { _id: { $in: allPlanIds } },
          {
            therapy_name: 1,
            status: 1,
            closure_date: 1,
            closure_reason: 1,
          },
        ).lean()
      : [];

    const plansById = referencePlans.reduce((acc, plan) => {
      acc[plan._id.toString()] = {
        plan_id: plan._id,
        therapy_name: plan.therapy_name,
        status: plan.status,
        closure_date: plan.closure_date || null,
        closure_reason: plan.closure_reason || null,
      };
      return acc;
    }, {});

    // ── 7. Assemble Report Grouped By Patient ─────────────────────────────────
    let dynamicGlobalSessionCount = 0;

    const reportPatients = await Promise.all(
      patients.map(async (p) => {
        const patientKey = p._id.toString();
        const patientSessions = sessionsByPatientMap[patientKey] || [];

        // Generate SAS token for patient image
        let patient_image_url = null;
        if (p.patient_image) {
          try {
            patient_image_url = await generatepatientImageSasToken(
              p.patient_image,
            );
          } catch (err) {
            console.warn(
              "Failed to generate patient image SAS token:",
              err.message,
            );
          }
        }

        // Calculate session milestones for this patient
        const conductedSessions = patientSessions.filter(
          (s) => s.status === "Completed" || s.status === "completed",
        );
        const scheduledSessions = patientSessions.filter(
          (s) => s.status === "Scheduled" || s.status === "scheduled",
        );

        const conductedDates = conductedSessions.map((s) => ({
          session_id: s._id,
          date: s.therepy_date,
          conducted_by: s.doctor_name || null,
          label: s.issue_dealt_with || null,
        }));

        const upcomingDates = scheduledSessions.map((s) => ({
          session_id: s._id,
          date: s.therepy_date,
          assigned_doctor: s.doctor_name || null,
          label: s.issue_dealt_with || null,
        }));

        dynamicGlobalSessionCount += patientSessions.length;

        // Reference plans — contextual only, not used for gating/filtering
        const patientPlans = Array.isArray(p.therapy_plans)
          ? p.therapy_plans
              .map((id) => plansById[id.toString()])
              .filter(Boolean)
          : [];

        return {
          patient_id: p._id,
          uhid: p.UHID || null,
          name: `${p.patient_first_name} ${p.patient_last_name}`,
          patient_image: patient_image_url,

          // Reference only — does not affect inclusion in this report
          therapy_plans: patientPlans,

          // Aftercare Statistics for this Patient
          aftercare_stats: {
            total_aftercare_sessions: patientSessions.length,
            conducted_count: conductedSessions.length,
            scheduled_count: scheduledSessions.length,
            other_status_count:
              patientSessions.length -
              (conductedSessions.length + scheduledSessions.length),
          },

          // Conducted timeline details
          conducted_sessions: conductedDates,
          // Scheduled timeline details
          upcoming_sessions: upcomingDates,
        };
      }),
    );

    // ── 8. Send Response ──────────────────────────────────────────────────────
    // Strictly formatted as JSON to avoid exporting to Excel
    return res.status(200).json({
      report_type: "Patient-Based Aftercare Report",
      applied_filters: {
        from: from || null,
        to: to || null,
        session_status: status || null,
      },
      global_statistics: {
        total_patients_reported: reportPatients.length,
        total_aftercare_sessions_matched: dynamicGlobalSessionCount,
      },
      patients: reportPatients,
    });
  } catch (error) {
    console.error("Error generating patient-based aftercare report:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};

const deleteTherapyPlan = async (req, res) => {
  try {
    const { id } = req.params;
    const { tenant_id } = req.user;
    const { orgDb } = req;

    // Get models
    const TherapyPlan = getTherapyPlanModel(orgDb);
    const Patient = getPatientModel(orgDb);
    const Payment = getPaymentModel(orgDb);

    // Find the therapy plan
    const therapyPlan = await TherapyPlan.findById(id);

    if (!therapyPlan) {
      console.log("Therapy plan not found for ID:", id);
      return res.status(404).json({
        msg: "Therapy plan not found",
      });
    }

    // Check if the plan has associated therapy sessions
    if (
      therapyPlan.therapy_sessions &&
      therapyPlan.therapy_sessions.length > 0
    ) {
      return res.status(400).json({
        msg: "Cannot delete therapy plan with associated therapy sessions",
        sessionCount: therapyPlan.therapy_sessions.length,
        details:
          "Please remove or reassign all therapy sessions before deleting the plan",
      });
    }

    // Check if there are any payments associated with this plan
    const hasPayments =
      therapyPlan.payment_history && therapyPlan.payment_history.length > 0;

    if (hasPayments) {
      return res.status(400).json({
        msg: "Cannot delete therapy plan with payment history",
        paymentCount: therapyPlan.payment_history.length,
        details:
          "This plan has associated payment records and cannot be deleted",
      });
    }

    // Find the patient who has this therapy plan
    const patient = await Patient.findOne({
      therapy_plans: new mongoose.Types.ObjectId(id),
    });

    if (!patient) {
      return res.status(404).json({
        msg: "Patient not found for this therapy plan",
      });
    }

    // Remove the therapy plan from the patient's therapy_plans array
    await Patient.findByIdAndUpdate(
      patient._id,
      {
        $pull: { therapy_plans: new mongoose.Types.ObjectId(id) },
      },
      { new: true },
    );

    // Delete any payment records associated with this plan (if they exist)
    await Payment.deleteMany({
      therapy_plan_id: new mongoose.Types.ObjectId(id),
    });

    // Finally, delete the therapy plan
    await TherapyPlan.findByIdAndDelete(id);

    return res.status(200).json({
      message: "Therapy plan deleted successfully",
      deletedPlanId: id,
      patientId: patient._id,
    });
  } catch (error) {
    console.error("Error deleting therapy plan:", {
      message: error.message,
      stack: error.stack,
    });

    // Handle specific error types
    if (error.name === "CastError") {
      return res.status(400).json({
        msg: "Invalid therapy plan ID format",
      });
    }

    return res.status(500).json({
      msg: "Server error while deleting therapy plan",
      error: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
};

const addNoteInTherapy = async (req, res) => {
  try {
    const { id } = req.params;
    const { note } = req.body;
    const TherapyPlan = getTherapyPlanModel(req.orgDb);
    console.log(note);
    // Check if note is provided
    if (!note) {
      return res.status(400).json({ msg: "Note is required" });
    }

    // Get doctor's full name from the authenticated user info
    const doctor_name = `${req.user.doctor_first_name} ${req.user.doctor_last_name}`;

    // Find the existing therapy plan
    const existingPlan = await TherapyPlan.findById(id);
    if (!existingPlan) {
      return res.status(404).json({ msg: "Therapy plan not found" });
    }

    // Ensure the notes field is an array; if not, initialize it.
    if (!Array.isArray(existingPlan.notes)) {
      existingPlan.notes = [];
    }

    // Push the new note object into the notes array
    existingPlan.notes.push({
      note,
      doctor_name,
      date: new Date(),
    });

    // Save the updated plan with the new note
    const updatedPlan = await existingPlan.save();

    return res.status(200).json({
      message: "Note added successfully",
      updatedPlan: updatedPlan.toObject(),
    });
  } catch (error) {
    console.error("Error adding note to therapy plan:", error);

    // Handle specific error types
    if (error.name === "ValidationError") {
      return res.status(400).json({
        msg: "Validation error",
        errors: Object.values(error.errors).map((e) => e.message),
      });
    }
    if (error.name === "CastError") {
      return res.status(400).json({ msg: "Invalid ID format" });
    }

    return res.status(500).json({
      msg: "Internal server error",
      error: error.message,
    });
  }
};

const getTherapyPlan = async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Validate planId format
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res
        .status(400)
        .json({ message: "Invalid therapy plan ID format" });
    }

    // 2. Grab your models
    const TherapyPlanModel = getTherapyPlanModel(req.orgDb);
    const TherapySessionModel = getTherapySession(req.orgDb);
    const PatientModel = getPatientModel(req.orgDb);
    const PrescriptionModel = getPrescriptionModel(req.orgDb);

    // 3. Load the plan
    const therapyPlan = await TherapyPlanModel.findById(id).lean();
    if (!therapyPlan) {
      return res.status(404).json({ message: "Therapy plan not found" });
    }

    // 4. Load patient basic info AND patient_image in a single optimized projection
    const patient = await PatientModel.findOne(
      { therapy_plans: new mongoose.Types.ObjectId(id) },
      {
        patient_first_name: 1,
        patient_last_name: 1,
        patient_image: 1,
        patient_phone: 1,
        guardian_phone: 1,
        guardian_phone_2: 1,
      },
    ).lean();

    // 4.5 Generate SAS Token for Patient Image
    let patient_image_url = null;
    if (patient && patient.patient_image) {
      try {
        patient_image_url = await generatepatientImageSasToken(
          patient.patient_image,
        );
      } catch (err) {
        console.warn(
          "Failed to generate patient image SAS token:",
          err.message,
        );
      }
    }

    // 5. Fetch Doctor info for created_by_name
    let created_by_name = "Unknown Doctor";
    if (therapyPlan.created_by) {
      try {
        const doctorId = new mongoose.Types.ObjectId(therapyPlan.created_by);
        const doctor = await req.orgDb
          .collection("doctors")
          .findOne(
            { _id: doctorId },
            { projection: { doctor_first_name: 1, doctor_last_name: 1 } },
          );

        if (doctor?.doctor_first_name && doctor?.doctor_last_name) {
          created_by_name =
            `${doctor.doctor_first_name} ${doctor.doctor_last_name}`.trim();
        }
      } catch (e) {
        console.warn("Could not fetch doctor for created_by_name", e);
      }
    }

    // 6. Fetch ALL associated prescriptions (active and historical)
    let prescriptionData = null;
    let allPrescriptions = [];

    // Fetch the full history if the array exists
    if (therapyPlan.prescriptions && therapyPlan.prescriptions.length > 0) {
      allPrescriptions = await PrescriptionModel.find({
        _id: { $in: therapyPlan.prescriptions },
      })
        .sort({ prescription_date: -1 }) // Sort newest to oldest
        .lean();
    }

    // Keep identifying the active prescription for backwards compatibility
    if (therapyPlan.prescription_id) {
      prescriptionData = await PrescriptionModel.findById(
        therapyPlan.prescription_id,
      ).lean();

      // Safety catch: if there's an active one that somehow missed the array, add it to the list
      if (
        prescriptionData &&
        !allPrescriptions.some(
          (p) => p._id.toString() === prescriptionData._id.toString(),
        )
      ) {
        allPrescriptions.unshift(prescriptionData);
      }
    }

    // 7. Fetch ALL therapy images with fresh SAS tokens
    // Note: getImagesWithSasTokens() requires a Mongoose document (not .lean()),
    // so we call it on a separate non-lean fetch.
    const therapyPlanDoc = await TherapyPlanModel.findById(id);
    const images = await therapyPlanDoc.getImagesWithSasTokens();

    // 8. Hydrate full therapy sessions from the `therepys` collection
    // ─────────────────────────────────────────────────────────────────────────
    // therapyPlan.therapy_sessions contains lightweight SessionReference stubs
    // (_id, status, session_number only). We fetch the complete TherapySession
    // documents here so all clinical fields are available.
    let sessions = [];
    if (
      Array.isArray(therapyPlan.therapy_sessions) &&
      therapyPlan.therapy_sessions.length > 0
    ) {
      const sessionIds = therapyPlan.therapy_sessions.map((s) => s._id);

      const fullSessions = await TherapySessionModel.find({
        _id: { $in: sessionIds },
      })
        .populate("prescription_id") // attach session-level prescription inline
        .lean();

      sessions = fullSessions.map((session) => {
        // planRef gives us the plan-level status override and session_number
        const planRef = therapyPlan.therapy_sessions.find((s) =>
          s._id.equals(session._id),
        );

        // Resolve session-level prescription if populated
        let sessionPrescription = null;
        if (
          session.prescription_id &&
          typeof session.prescription_id === "object"
        ) {
          const rx = session.prescription_id;
          sessionPrescription = {
            prescription_number: rx.prescription_number || null,
            prescription_date: rx.prescription_date || null,
            doctor_name: rx.doctor_name || null,
            diagnosis: rx.diagnosis || null,
            notes: rx.notes || null,
            vitals: rx.vitals || {},
            medications: (rx.medications || []).map((med) => ({
              drug_name: med.drug_name,
              generic_name: med.generic_name || null,
              strength: med.strength || null,
              route: med.route || null,
              frequency: med.frequency || null,
              morning: med.morning ?? null,
              afternoon: med.afternoon ?? null,
              night: med.night ?? null,
              duration: med.duration || null,
              instructions: med.instructions || null,
            })),
          };
        }

        return {
          session_id: session._id,
          session_number: planRef?.session_number || null,

          // ── Scheduling ────────────────────────────────────────────────
          date: session.therepy_date || null,
          start_time: session.therepy_start_time || null,
          end_time: session.therepy_end_time || null,
          session_duration: session.session_duration || null, // in minutes

          // ── Type & location ───────────────────────────────────────────
          type: session.therepy_type || null,
          location_name: session.location_name || null,
          location_address: session.location_address || null,

          // ── Status ────────────────────────────────────────────────────
          // Plan-level status takes precedence over session's own status
          status: planRef?.status || session.status || "Scheduled",

          // ── Treating doctor ───────────────────────────────────────────
          doctor_id: session.doctor_id || null,
          doctor_name: session.doctor_name || "N/A",

          // ── Clinical notes ────────────────────────────────────────────
          issue_dealt_with: session.issue_dealt_with || null,
          counselor_impression: session.counselor_impression || null,
          presession_remarks: session.presession_remarks || null,
          postsession_remarks: session.postsession_remarks || null,
          notes: session.notes || null,

          // ── Actual session timestamps ─────────────────────────────────
          session_start_time: session.session_start_time || null,
          session_end_time: session.session_end_time || null,

          // ── Attachments ───────────────────────────────────────────────
          attachments: (session.attachments || []).map((a) => ({
            name: a.name,
            url: a.url,
            type: a.type,
            uploaded_at: a.uploaded_at,
          })),

          // ── Session-level prescription ────────────────────────────────
          prescription: sessionPrescription,
        };
      });

      // Sort ascending by session_number for consistent ordering
      sessions.sort(
        (a, b) => (a.session_number || 0) - (b.session_number || 0),
      );
    }

    // 9. Build response
    const response = {
      patient_id: patient?._id || null,
      patient_name: patient
        ? `${patient.patient_first_name} ${patient.patient_last_name}`
        : "Unknown Patient",
      patient_image: patient_image_url,
      patient_phone: patient?.patient_phone || null,
      guardian_phone: patient?.guardian_phone || null,
      guardian_phone_2: patient?.guardian_phone_2 || null,
      created_by_name,
      therapy_plan: {
        ...therapyPlan,
        therapy_sessions: sessions,
        prescriptions: allPrescriptions,
      },
      prescription: prescriptionData,
      images,
    };

    // 10. If plan is completed, attach full closure summary
    const isCompleted =
      therapyPlan.status === "Completed" || therapyPlan.status === "completed";

    if (isCompleted) {
      const totalSessions = therapyPlan.therapy_sessions
        ? therapyPlan.therapy_sessions.length
        : 0;
      const completedSessions =
        therapyPlan.final_completed_sessions ||
        therapyPlan.completed_sessions ||
        0;
      const estimatedSessions = therapyPlan.estimated_sessions || 0;

      // Fetch doctor who closed the plan
      let closed_by_name = therapyPlan.closed_by_name || "Unknown Doctor";
      if (therapyPlan.closed_by) {
        try {
          const closedByDoctorId = new mongoose.Types.ObjectId(
            therapyPlan.closed_by,
          );
          const closedByDoctor = await req.orgDb
            .collection("doctors")
            .findOne(
              { _id: closedByDoctorId },
              { projection: { doctor_first_name: 1, doctor_last_name: 1 } },
            );

          if (
            closedByDoctor?.doctor_first_name &&
            closedByDoctor?.doctor_last_name
          ) {
            closed_by_name =
              `${closedByDoctor.doctor_first_name} ${closedByDoctor.doctor_last_name}`.trim();
          }
        } catch (e) {
          console.warn("Could not fetch doctor for closed_by_name", e);
        }
      }

      // Fetch post-care prescription (created at closure, separate from plan prescription)
      let postCarePrescriptionData = null;
      if (therapyPlan.post_care_prescription_id) {
        postCarePrescriptionData = await PrescriptionModel.findById(
          therapyPlan.post_care_prescription_id,
        ).lean();
      }

      // ── FIX: keep the Active Rx card in sync with what Print shows ─────────
      // getTherapyPlanForPrint resolves medications from post_care_prescription_id
      // (the prescription issued at closure), not from the plan's original
      // prescription_id. Once a plan is completed, mirror that same priority
      // here so `response.prescription` (used by the Active Rx card on
      // PlanDetails.tsx) shows the same medications the printed summary does.
      if (postCarePrescriptionData) {
        response.prescription = postCarePrescriptionData;

        // Also make sure it shows up in the prescriptions history list if it
        // was somehow not already included there.
        if (
          !allPrescriptions.some(
            (p) => p._id.toString() === postCarePrescriptionData._id.toString(),
          )
        ) {
          allPrescriptions.unshift(postCarePrescriptionData);
          response.therapy_plan.prescriptions = allPrescriptions;
        }
      }

      response.closure_summary = {
        closure_information: {
          closure_date: therapyPlan.closure_date,
          closure_reason: therapyPlan.closure_reason,
          closure_details: therapyPlan.closure_details,
          final_remarks: therapyPlan.final_remarks,
          treatment_outcome: therapyPlan.treatment_outcome,
          follow_up_recommendations: therapyPlan.follow_up_recommendations,
          closed_by_name,
          next_visit_date: therapyPlan.next_visit_date || null,
        },

        session_statistics: {
          estimated_sessions: estimatedSessions,
          completed_sessions: completedSessions,
          total_sessions_conducted:
            therapyPlan.final_total_sessions || totalSessions,
          completion_rate:
            estimatedSessions > 0
              ? `${Math.round((completedSessions / estimatedSessions) * 100)}%`
              : "N/A",
        },

        financial_summary: {
          original_amount: therapyPlan.final_original_amount,
          discount_percentage: therapyPlan.final_discount_percentage,
          discount_amount: therapyPlan.final_discount_amount,
          final_amount: therapyPlan.final_total_amount,
          received_amount: therapyPlan.final_received_amount,
          balance: therapyPlan.final_balance,
          addons_amount: therapyPlan.final_addons_amount,
          payment_history_count: therapyPlan.payment_history
            ? therapyPlan.payment_history.length
            : 0,
        },

        therapy_duration: {
          planned_start: therapyPlan.therapy_start,
          planned_end: therapyPlan.therapy_end,
          actual_closure: therapyPlan.closure_date,
        },

        goal_achievement: `${therapyPlan.goal_achievement || 0}%`,

        post_care_prescription_id:
          therapyPlan.post_care_prescription_id || null,
        post_care_prescription: postCarePrescriptionData,

        total_remarks: {
          presession: therapyPlan.presession_remarks
            ? therapyPlan.presession_remarks.length
            : 0,
          postsession: therapyPlan.postsession_remarks
            ? therapyPlan.postsession_remarks.length
            : 0,
        },

        total_images: therapyPlan.total_images_count || 0,
        extra_addons: therapyPlan.extra_addons
          ? therapyPlan.extra_addons.length
          : 0,
      };
    }

    return res.status(200).json(response);
  } catch (error) {
    console.error("Error in getTherapyPlan:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};
const Organization = require("../db/OrganizationSchema");
const {
  generateImageSasTokenLogo,
  generatepatientImageSasToken,
} = require("../utils/azureutils");
const printTherapyPlan = async (req, res) => {
  try {
    const { planId } = req.params;

    // Validate Plan ID
    if (!mongoose.Types.ObjectId.isValid(planId)) {
      return res.status(400).json({ error: "Invalid Plan ID format" });
    }

    const TherapyPlan = getTherapyPlanModel(req.orgDb);
    const Patient = getPatientModel(req.orgDb);

    // Fetch Plan and Patient in parallel
    const plan = await TherapyPlan.findById(planId).lean();

    if (!plan) {
      return res.status(404).json({ error: "Therapy plan not found" });
    }

    const patient = await Patient.findOne({
      therapy_plans: new mongoose.Types.ObjectId(planId),
    }).lean();

    if (!patient) {
      return res
        .status(404)
        .json({ error: "Patient record not found for this plan" });
    }

    // Fetch Organization (Using the same logic as your printConsentForm)
    // Assuming Organization model is available, or you can query the collection directly
    const organization = await Organization.findOne({
      tenant_id: req.user.tenant_id,
    }).lean();

    // Handle Organization Logo SAS Token
    let orgLogo = organization?.organization_logo || "";
    if (orgLogo) {
      try {
        orgLogo = await generateImageSasTokenLogo(orgLogo);
      } catch (err) {
        console.warn("Failed to generate SAS token for org logo:", err.message);
      }
    }

    // --- NEW: Handle Patient Image SAS Token ---
    let patientImage = patient?.patient_image || "";
    if (patientImage) {
      try {
        patientImage = await generatepatientImageSasToken(patientImage);
      } catch (err) {
        console.warn(
          "Failed to generate SAS token for patient image:",
          err.message,
        );
      }
    }
    // ------------------------------------------

    // Map address for patient
    const addressLine =
      patient.patient_address1 || patient.address?.street || "";
    const cityOrTaluka = patient.address?.city || "";
    const districtOrState = patient.address?.state || "";

    let fullAddress = addressLine;
    if (cityOrTaluka) {
      fullAddress += fullAddress ? `, ${cityOrTaluka}` : cityOrTaluka;
    }

    // Construct the Print Data Object
    const printData = {
      plan: {
        _id: plan._id,
        name: plan.therapy_name || "N/A",
        status: plan.status || "Active",
        start_date: plan.therapy_start || plan.created_at,
        end_date: plan.therapy_end || "N/A",
        diagnosis: plan.patient_diagnosis || "N/A",
        symptoms: plan.patient_symptoms || "N/A",
        category: plan.patient_therapy_category || "N/A",

        // Session Info
        estimated_sessions: plan.estimated_sessions || 0,
        completed_sessions: plan.completed_sessions || 0,

        // Financial Info
        total_amount: plan.total_amount || 0,
        received_amount: plan.received_amount || 0,
        balance: plan.balance || 0,
        payment_type: plan.payment_type || "N/A",
        per_session_amount: plan.per_session_amount || 0,
      },
      patient: {
        _id: patient._id,
        uhid: patient.UHID || "",
        name: `${patient.patient_first_name || ""} ${patient.patient_last_name || ""}`.trim(),
        image: patientImage, // <-- Included the generated SAS token here
        age: patient.patient_age || "",
        gender: patient.gender || "",
        mobile: patient.patient_phone || patient.patient_alternate_number || "",
        email: patient.patient_email || "",
        address_full: fullAddress,
        blood_group: patient.blood_group || "",
        marital_status: patient.marital_status || "",
      },
      organization: {
        name: organization?.organization_name || "Institute Name",
        address: organization?.organization_address || {},
        logo: orgLogo,
        phone: organization?.organization_phone || "",
        email: organization?.organization_email || "",
      },
      doctor: {
        // Fallbacks included in case doctor_name isn't directly on req.user
        name:
          req.user.doctor_name ||
          `${req.user.doctor_first_name || "Dr."} ${req.user.doctor_last_name || ""}`.trim(),
      },
      metadata: {
        printed_on: new Date(),
      },
    };

    return res.status(200).json(printData);
  } catch (error) {
    console.error("Get Therapy Plan Print Data Error:", error);
    return res.status(500).json({
      message: "Error fetching therapy plan print data",
      error: error.message,
    });
  }
};
const printPatientRegistration = async (req, res) => {
  try {
    const { patientId } = req.params;

    // Validate Patient ID
    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ error: "Invalid Patient ID format" });
    }

    const Patient = getPatientModel(req.orgDb);

    // Fetch Patient record
    const patient = await Patient.findById(patientId).lean();

    if (!patient) {
      return res.status(404).json({ error: "Patient record not found" });
    }

    // Fetch Organization using tenant isolation
    const organization = await Organization.findOne({
      tenant_id: req.user.tenant_id,
    }).lean();

    // Handle Organization Logo SAS Token
    let orgLogo = organization?.organization_logo || "";
    if (orgLogo) {
      try {
        orgLogo = await generateImageSasTokenLogo(orgLogo);
      } catch (err) {
        console.warn("Failed to generate SAS token for org logo:", err.message);
      }
    }

    // Handle Patient Image SAS Token
    let patientImage = patient?.patient_image || "";
    if (patientImage) {
      try {
        patientImage = await generatepatientImageSasToken(patientImage);
      } catch (err) {
        console.warn(
          "Failed to generate SAS token for patient image:",
          err.message,
        );
      }
    }

    // Map full address for patient
    const addressLine =
      patient.patient_address1 || patient.address?.street || "";
    const cityOrTaluka = patient.address?.city || "";
    const districtOrState = patient.address?.state || "";

    let fullAddress = addressLine;
    if (cityOrTaluka) {
      fullAddress += fullAddress ? `, ${cityOrTaluka}` : cityOrTaluka;
    }
    if (districtOrState) {
      fullAddress += fullAddress ? `, ${districtOrState}` : districtOrState;
    }

    // Map Identity Card formatting
    let identityInfo = "N/A";
    if (patient.identity_card && patient.identity_card.type) {
      identityInfo = `${patient.identity_card.type} - ${patient.identity_card.number || "N/A"}`;
    }

    // Construct the Print Data Object
    const printData = {
      patient: {
        _id: patient._id,
        uhid: patient.UHID || "N/A",
        name: `${patient.patient_first_name || ""} ${patient.patient_last_name || ""}`.trim(),
        image: patientImage,
        age: patient.patient_age || "N/A",
        gender: patient.gender || "N/A",
        date_of_birth: patient.date_of_birth || "N/A",

        // Contact Info
        mobile: patient.patient_phone || "N/A",
        alternate_mobile: patient.patient_alternate_number || "N/A",
        guardian_phone: patient.guardian_phone || "N/A",
        email: patient.patient_email || "N/A",
        address_full: fullAddress || "N/A",

        // Demographics & Background
        marital_status: patient.marital_status || "N/A",
        education: patient.education || "N/A",
        occupation: patient.occupation || "N/A",
        annual_income: patient.annual_income || "N/A",
        identity_card: identityInfo,

        // Registration Specifics
        registration_date: patient.patient_registration_date || new Date(),
        referral_source: patient.referral_source || "N/A",
        referral_details: patient.referral_details || "N/A",

        // Emergency Contact
        emergency_contact: {
          name: patient.emergency_contact?.name || "N/A",
          relationship: patient.emergency_contact?.relationship || "N/A",
          phone: patient.emergency_contact?.phone || "N/A",
        },
      },
      organization: {
        name: organization?.organization_name || "Institute Name",
        address: organization?.organization_address || {},
        logo: orgLogo,
        phone: organization?.organization_phone || "",
        email: organization?.organization_email || "",
      },
      doctor: {
        // Prioritize the doctor mapped to the patient, fallback to the logged-in user
        name:
          patient.doctor_name ||
          req.user.doctor_name ||
          `${req.user.doctor_first_name || "Dr."} ${req.user.doctor_last_name || ""}`.trim(),
      },
      metadata: {
        printed_on: new Date(),
        document_type: "Patient Registration Sheet",
      },
    };

    return res.status(200).json(printData);
  } catch (error) {
    console.error("Get Patient Registration Print Data Error:", error);
    return res.status(500).json({
      message: "Error fetching patient registration print data",
      error: error.message,
    });
  }
};

const recordPayment = async (req, res) => {
  try {
    const { id, therapyId } = req.params;
    const {
      amount,
      type,
      addon_services = [],
      location_address,
      location_name,
      location_id,
    } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ msg: "Invalid therapy plan ID format" });
    }

    // Parallel data fetching for better performance
    // Only fetch therapy session if therapyId is provided and valid
    const therapyPlanPromise = req.orgDb
      .collection("plans")
      .findOne({ _id: new ObjectId(id) });
    const therapySessionPromise =
      therapyId && ObjectId.isValid(therapyId)
        ? getTherapySession(req.orgDb)
            .findOne({ _id: new ObjectId(therapyId) })
            .lean()
        : null;

    const [therapyPlan, therapySession] = await Promise.all([
      therapyPlanPromise,
      therapySessionPromise,
    ]);

    if (!therapyPlan) {
      return res.status(404).json({ msg: "Therapy plan not found" });
    }

    // Get patient using the more efficient approach
    const Patient = getPatientModel(req.orgDb);
    const patient = await Patient.findOne(
      { therapy_plans: new ObjectId(id) },
      { _id: 1 }, // Project only the _id field
    ).lean(); // Use lean() for faster queries

    if (!patient) {
      return res.status(404).json({
        msg: "Patient not found for this therapy plan",
      });
    }

    // Priority order for location details:
    // 1. Location from request body (if provided by payment page)
    // 2. Location from therapy session (if therapyId exists)
    // 3. Location from therapy plan (fallback)
    const locationDetails = {
      location_address:
        location_address ||
        therapySession?.location_address ||
        therapyPlan.location_address ||
        null,
      location_name:
        location_name ||
        therapySession?.location_name ||
        therapyPlan.location_name ||
        null,
      location_id:
        location_id ||
        therapySession?.location_id ||
        therapyPlan.location_id ||
        null,
    };

    const therapyType = therapySession?.therepy_type || null;

    // Financial calculations
    const currentReceivedAmount = parseFloat(therapyPlan.received_amount || 0);
    const totalAmount = parseFloat(therapyPlan.total_amount || 0);
    const currentAddonsAmount = parseFloat(therapyPlan.addons_amount || 0);
    const paymentAmount = parseFloat(amount);
    const newReceivedAmount = currentReceivedAmount + paymentAmount;
    const newBalance = Math.max(0, totalAmount - newReceivedAmount);

    // Process addons
    let newAddonsAmount = currentAddonsAmount;
    const updatedAddons = [...(therapyPlan.extra_addons || [])];
    const addonServicesForPayment = [];
    let addonsTotal = 0;

    addon_services.forEach((addon) => {
      const addonAmount = parseFloat(addon.amount);
      newAddonsAmount += addonAmount;
      addonsTotal += addonAmount;

      const addonData = {
        name: addon.name,
        amount: addonAmount,
      };

      updatedAddons.push({
        ...addonData,
        date: new Date(),
      });

      addonServicesForPayment.push(addonData);
    });

    // Payment numbering for recurring payments
    let paymentNumber = null;
    let nextPaymentNumber = therapyPlan.next_payment_number;
    let nextPaymentDue = therapyPlan.next_payment_due;

    if (therapyPlan.payment_type === "recurring") {
      const paymentHistory = therapyPlan.payment_history || [];
      const maxPaymentNumber = paymentHistory.reduce(
        (max, payment) =>
          payment.payment_number ? Math.max(max, payment.payment_number) : max,
        0,
      );
      paymentNumber = maxPaymentNumber + 1;
      nextPaymentNumber = paymentNumber + 1;

      if (newBalance > 0) {
        nextPaymentDue = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      }
    }

    const currentDate = new Date();
    const totalPaymentAmount = paymentAmount + addonsTotal;

    // Prepare payment history entry
    const paymentHistoryEntry = {
      amount: paymentAmount,
      date: currentDate,
      type,
      therapyId: therapyId || null,
      payment_number: paymentNumber,
    };

    if (addon_services.length > 0) {
      paymentHistoryEntry.addon_services = addonServicesForPayment;
    }

    // Prepare therapy plan update
    const updateObj = {
      $set: {
        received_amount: newReceivedAmount.toString(),
        balance: newBalance.toString(),
        addons_amount: newAddonsAmount,
        extra_addons: updatedAddons,
        last_payment_date: currentDate,
      },
      $push: {
        payment_history: paymentHistoryEntry,
      },
    };

    if (nextPaymentNumber !== undefined) {
      updateObj.$set.next_payment_number = nextPaymentNumber;
    }
    if (nextPaymentDue) {
      updateObj.$set.next_payment_due = nextPaymentDue;
    }

    // Prepare payment document with location details
    const paymentDoc = {
      amount: totalPaymentAmount,
      type,
      date: currentDate,
      therapy_plan_id: new ObjectId(id),
      patient_id: new ObjectId(patient._id),
      doctor_id: req.doctor_id || req.user?.doctor_id,
      therapyId: therapyId ? new ObjectId(therapyId) : null,
      therepy_type: therapyType,
      payment_number: paymentNumber,
      balance_after_payment: newBalance,
      received_amount_total: newReceivedAmount,
      // Add location details from therapy session or plan
      location_address: locationDetails.location_address,
      location_name: locationDetails.location_name,
      location_id: locationDetails.location_id,
    };

    if (addon_services.length > 0) {
      paymentDoc.addon_services = addonServicesForPayment;
    }

    // Execute both updates in parallel for better performance
    const Payment = getPaymentModel(req.orgDb);
    const [updateResult] = await Promise.all([
      req.orgDb
        .collection("plans")
        .updateOne({ _id: new ObjectId(id) }, updateObj),
      Payment.create(paymentDoc),
    ]);

    if (updateResult.modifiedCount === 0) {
      return res.status(400).json({
        message: "Failed to update payment information",
      });
    }

    return res.status(200).json({
      message: "Payment recorded successfully",
      new_balance: newBalance,
      new_received_amount: newReceivedAmount,
      addon_services: updatedAddons,
      payment_number: paymentNumber,
      patient_id: patient._id,
      therapy_type: therapyType,
      location: locationDetails,
    });
  } catch (error) {
    console.error("Error in recordPayment:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};
const recordPatientPayment = async (req, res) => {
  try {
    const { patientId } = req.params;
    const {
      amount,
      type,
      date, // Date from frontend
      addon_services = [],
      location_address,
      location_name,
      location_id,
      description,
      notes,
    } = req.body;
    // Validate patient ID format
    if (!ObjectId.isValid(patientId)) {
      return res.status(400).json({ msg: "Invalid patient ID format" });
    }
    // Validate required fields
    if (!amount || amount <= 0) {
      return res.status(400).json({ msg: "Valid payment amount is required" });
    }
    if (!type) {
      return res.status(400).json({ msg: "Payment type is required" });
    }

    if (!date) {
      return res.status(400).json({ msg: "Payment date is required" });
    }

    // Validate and parse date
    const paymentDate = new Date(date);
    if (isNaN(paymentDate.getTime())) {
      return res.status(400).json({ msg: "Invalid date format" });
    }

    // Verify patient exists
    const Patient = getPatientModel(req.orgDb);
    const patient = await Patient.findOne(
      { _id: new ObjectId(patientId) },
      { _id: 1, name: 1 },
    ).lean();
    if (!patient) {
      return res.status(404).json({
        msg: "Patient not found",
      });
    }
    // Process addon services
    const addonServicesForPayment = [];
    let addonsTotal = 0;
    addon_services.forEach((addon) => {
      const addonAmount = parseFloat(addon.amount);
      addonsTotal += addonAmount;
      addonServicesForPayment.push({
        name: addon.name,
        amount: addonAmount,
      });
    });
    const paymentAmount = parseFloat(amount);
    const totalPaymentAmount = paymentAmount + addonsTotal;
    // Prepare payment document
    const paymentDoc = {
      amount: totalPaymentAmount,
      base_amount: paymentAmount,
      addons_amount: addonsTotal,
      type,
      date: paymentDate, // Use date from frontend
      patient_id: new ObjectId(patientId),
      doctor_id: req.doctor_id || req.user?.doctor_id,
      // Optional fields
      therapy_plan_id: null,
      therapyId: null,
      therepy_type: null,
      payment_number: null,
      balance_after_payment: null,
      received_amount_total: null,
      // Location details
      location_address: location_address || null,
      location_name: location_name || null,
      location_id: location_id || null,
      // Additional information
      description: description || null,
      notes: notes || null,
    };
    // Add addon services if present
    if (addon_services.length > 0) {
      paymentDoc.addon_services = addonServicesForPayment;
    }
    // Create payment record
    const Payment = getPaymentModel(req.orgDb);
    const createdPayment = await Payment.create(paymentDoc);
    return res.status(200).json({
      message: "Payment recorded successfully",
      payment: {
        id: createdPayment._id,
        amount: totalPaymentAmount,
        base_amount: paymentAmount,
        addons_amount: addonsTotal,
        type,
        date: paymentDate,
        patient_id: patientId,
        patient_name: patient.name,
        addon_services: addonServicesForPayment,
        location: {
          address: location_address || null,
          name: location_name || null,
          id: location_id || null,
        },
      },
    });
  } catch (error) {
    console.error("Error in recordPatientPayment:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};

const getPaymentInfo = async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        message: "Invalid therapy plan ID format",
      });
    }

    const therapyPlan = await req.orgDb.collection("plans").findOne(
      { _id: new ObjectId(id) },
      {
        projection: {
          therapy_name: 1,
          total_amount: 1,
          received_amount: 1,
          balance: 1,
          payment_type: 1,
          per_session_amount: 1,
          estimated_sessions: 1,
          therapy_sessions: 1,
          extra_addons: 1,
          addons_amount: 1,
          payment_history: 1,
          next_payment_due: 1,
          next_payment_number: 1,
        },
      },
    );

    if (!therapyPlan) {
      return res.status(404).json({
        message: "Therapy plan not found",
      });
    }

    // Handle therapy_sessions gracefully with case-insensitive status check
    const therapySessions = therapyPlan.therapy_sessions || []; // Default to an empty array if undefined
    const completedSessions = therapySessions.filter(
      (session) => session.status?.toLowerCase() === "completed",
    ).length;

    // Allow completed sessions to exceed estimated sessions
    const remainingSessions = Math.max(
      0,
      therapyPlan.estimated_sessions - completedSessions,
    );

    const paymentInfo = {
      therapy_name: therapyPlan.therapy_name,
      payment_summary: {
        total_amount: parseFloat(therapyPlan.total_amount || 0),
        received_amount: parseFloat(therapyPlan.received_amount || 0),
        balance: parseFloat(therapyPlan.balance || 0),
        addons_amount: parseFloat(therapyPlan.addons_amount || 0),
      },
      session_info: {
        per_session_amount: parseFloat(therapyPlan.per_session_amount || 0),
        estimated_sessions: therapyPlan.estimated_sessions || 0,
        completed_sessions: completedSessions,
        remaining_sessions: remainingSessions,
      },
      payment_structure: {
        payment_type: therapyPlan.payment_type || "",
        next_payment_due: therapyPlan.next_payment_due || null,
        next_payment_number: therapyPlan.next_payment_number || 1,
      },
      addons: therapyPlan.extra_addons || [],
      payment_history: Array.isArray(therapyPlan.payment_history)
        ? therapyPlan.payment_history.map((payment) => ({
            amount: payment.amount,
            date: payment.date,
            type: payment.type || "",
            session_number: payment.session_number,
            payment_number: payment.payment_number,
            addon_services: payment.addon_services || [],
            therapyId: payment.therapyId || "",
            payment_date_iso: payment.date?.$date, // Add ISO date for API calls
            edit_url: `/plans/${id}/payments/${payment.date?.$date}`, // Add URL for edit endpoint
            delete_url: `/plans/${id}/payments/${payment.date?.$date}`, // Add URL for delete endpoint
          }))
        : [],
    };

    return res.status(200).json(paymentInfo);
  } catch (error) {
    console.error("Error in getPaymentInfo:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};

const activeTherapyPlans = async (req, res) => {
  try {
    // Find all active therapy plans based only on the status[cite: 3]
    const activePlans = await req.orgDb
      .collection("plans")
      .find({ status: "Active" }) // Date filters removed[cite: 3]
      .toArray();

    // If no active plans found[cite: 3]
    if (!activePlans.length) {
      return res.status(200).json({
        message: "No active therapy plans found",
        active_plans: [],
      });
    }

    // Get all unique patient IDs who have these active plans[cite: 3]
    const planIds = activePlans.map((plan) => plan._id);
    const patients = await req.orgDb
      .collection("patients")
      .find(
        { therapy_plans: { $in: planIds } },
        {
          projection: {
            patient_first_name: 1,
            patient_last_name: 1,
            patient_image: 1,
            therapy_plans: 1,
          },
        },
      )
      .toArray();

    // Create a map of plan ID to patient info for quick lookup[cite: 3]
    const planToPatientMap = {};
    await Promise.all(
      patients.map(async (patient) => {
        // Generate SAS token for patient image[cite: 3]
        let patient_image_url = null;
        if (patient.patient_image) {
          try {
            patient_image_url = await generatepatientImageSasToken(
              patient.patient_image,
            );
          } catch (err) {
            console.warn(
              "Failed to generate patient image SAS token:",
              err.message,
            );
          }
        }

        patient.therapy_plans.forEach((planId) => {
          planToPatientMap[planId.toString()] = {
            name: `${patient.patient_first_name} ${patient.patient_last_name}`,
            patient_image: patient_image_url,
          };
        });
      }),
    );

    // Get current date for days_remaining calculation[cite: 3]
    const currentDate = new Date();
    currentDate.setHours(0, 0, 0, 0);

    // Combine plan data with patient names and images[cite: 3]
    const activePlansWithPatients = activePlans.map((plan) => {
      const patientInfo = planToPatientMap[plan._id.toString()];
      return {
        ...plan,
        patient_name: patientInfo?.name || "Unknown Patient",
        patient_image: patientInfo?.patient_image || null,
        days_remaining: Math.ceil(
          (new Date(plan.therapy_end) - currentDate) / (1000 * 60 * 60 * 24),
        ),
      };
    });

    // Sort plans by end date (ascending)[cite: 3]
    activePlansWithPatients.sort(
      (a, b) => new Date(a.therapy_end) - new Date(b.therapy_end),
    );

    return res.status(200).json({
      message: "Active therapy plans retrieved successfully",
      active_plans: activePlansWithPatients,
    });
  } catch (error) {
    console.error("Error in activeTherapyPlans:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};

const getDateRangeForFilter = (filter, customStart, customEnd) => {
  const now = new Date();
  let start, end;

  switch (filter) {
    case "thisMonth": {
      start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
      break;
    }
    case "lastMonth": {
      start = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
      end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      break;
    }
    case "thisYear": {
      start = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
      end = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
      break;
    }
    case "custom": {
      if (!customStart || !customEnd) {
        throw new Error(
          "startDate and endDate are required for the custom filter",
        );
      }
      start = new Date(customStart);
      start.setHours(0, 0, 0, 0);
      end = new Date(customEnd);
      end.setHours(23, 59, 59, 999);
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        throw new Error("startDate/endDate must be valid dates (YYYY-MM-DD)");
      }
      break;
    }
    default:
      return null;
  }

  return { start, end };
};

const completedTherapyPlans = async (req, res) => {
  try {
    const { filter, startDate, endDate, search } = req.query;

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, parseInt(req.query.limit, 10) || 10);

    let dateRange = null;
    if (filter && filter !== "all") {
      try {
        dateRange = getDateRangeForFilter(filter, startDate, endDate);
      } catch (rangeError) {
        return res.status(400).json({ message: rangeError.message });
      }
    }

    const matchStage = {
      status: { $in: ["Completed", "completed"] },
    };

    if (dateRange) {
      matchStage.effective_closure_date = {
        $gte: dateRange.start,
        $lte: dateRange.end,
      };
    }

    // Pull ALL matching plans first (patient_name lives on a different
    // collection, so we can't paginate at the DB level until after the join
    // + search filter are applied).
    const pipeline = [
      {
        $addFields: {
          effective_closure_date: { $ifNull: ["$closure_date", "$updatedAt"] },
        },
      },
      { $match: matchStage },
      { $sort: { effective_closure_date: -1 } },
    ];

    const allMatchingPlans = await req.orgDb
      .collection("plans")
      .aggregate(pipeline)
      .toArray();

    if (!allMatchingPlans.length) {
      return res.status(200).json({
        message: "No completed therapy plans found",
        completed_plans: [],
        pagination: { currentPage: page, totalPages: 1, totalCount: 0, limit },
      });
    }

    const planIds = allMatchingPlans.map((plan) => plan._id);
    const patients = await req.orgDb
      .collection("patients")
      .find(
        { therapy_plans: { $in: planIds } },
        {
          projection: {
            patient_first_name: 1,
            patient_last_name: 1,
            patient_image: 1,
            therapy_plans: 1,
          },
        },
      )
      .toArray();

    const planToPatientMap = {};
    await Promise.all(
      patients.map(async (patient) => {
        let patient_image_url = null;
        if (patient.patient_image) {
          try {
            patient_image_url = await generatepatientImageSasToken(
              patient.patient_image,
            );
          } catch (err) {
            console.warn(
              "Failed to generate patient image SAS token:",
              err.message,
            );
          }
        }

        patient.therapy_plans.forEach((planId) => {
          planToPatientMap[planId.toString()] = {
            name: `${patient.patient_first_name} ${patient.patient_last_name}`,
            patient_image: patient_image_url,
          };
        });
      }),
    );

    let plansWithPatients = allMatchingPlans.map((plan) => {
      const patientInfo = planToPatientMap[plan._id.toString()];
      return {
        ...plan,
        patient_name: patientInfo?.name || "Unknown Patient",
        patient_image: patientInfo?.patient_image || null,
        days_remaining: 0,
      };
    });

    // Search across ALL matching plans (not just one page)
    if (search && search.trim()) {
      const searchLower = search.trim().toLowerCase();
      plansWithPatients = plansWithPatients.filter((plan) =>
        plan.patient_name.toLowerCase().includes(searchLower),
      );
    }

    const totalCount = plansWithPatients.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / limit));
    const safePage = Math.min(page, totalPages);
    const skip = (safePage - 1) * limit;
    const paginatedResult = plansWithPatients.slice(skip, skip + limit);

    return res.status(200).json({
      message: "Completed therapy plans retrieved successfully",
      completed_plans: paginatedResult,
      pagination: {
        currentPage: safePage,
        totalPages,
        totalCount,
        limit,
      },
    });
  } catch (error) {
    console.error("Error in completedTherapyPlans:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};

const editPayment = async (req, res) => {
  try {
    const { planId, paymentDate } = req.params;
    const { amount, type, addon_services = [] } = req.body;

    if (!ObjectId.isValid(planId)) {
      return res.status(400).json({
        msg: "Invalid therapy plan ID format",
      });
    }

    const therapyPlan = await req.orgDb
      .collection("plans")
      .findOne({ _id: new ObjectId(planId) });

    if (!therapyPlan) {
      return res.status(404).json({
        msg: "Therapy plan not found",
      });
    }

    // Find the payment to edit using the payment date
    const paymentIndex = therapyPlan.payment_history.findIndex((payment) => {
      if (!payment.date) return false;
      const storedDate =
        payment.date instanceof Date
          ? payment.date.toISOString()
          : payment.date.$date || payment.date.toString();
      return storedDate === paymentDate;
    });

    if (paymentIndex === -1) {
      return res.status(404).json({
        msg: "Payment not found",
        searchDate: paymentDate,
        availableDates: therapyPlan.payment_history.map((p) =>
          p.date instanceof Date
            ? p.date.toISOString()
            : p.date.$date || p.date.toString(),
        ),
      });
    }

    const oldPayment = therapyPlan.payment_history[paymentIndex];
    const amountDifference = parseFloat(amount) - parseFloat(oldPayment.amount);

    // Calculate new received amount and balance
    const currentReceivedAmount = parseFloat(therapyPlan.received_amount);
    const totalAmount = parseFloat(therapyPlan.total_amount);
    const newReceivedAmount = currentReceivedAmount + amountDifference;
    const newBalance = totalAmount - newReceivedAmount;

    // Prevent negative balance
    if (newReceivedAmount > totalAmount) {
      return res.status(400).json({
        msg: "Updated payment amount would exceed total amount.",
      });
    }

    // Calculate addon differences
    const oldAddons = oldPayment.addon_services || [];
    const oldAddonsTotal = oldAddons.reduce(
      (sum, addon) => sum + parseFloat(addon.amount),
      0,
    );
    const newAddonsTotal = addon_services.reduce(
      (sum, addon) => sum + parseFloat(addon.amount),
      0,
    );
    const addonsDifference = newAddonsTotal - oldAddonsTotal;

    // Update extra_addons
    const updatedExtraAddons = [...therapyPlan.extra_addons];
    const paymentDateObj = new Date(paymentDate);
    const filteredExtraAddons = updatedExtraAddons.filter((addon) => {
      const addonDate =
        addon.date instanceof Date ? addon.date : new Date(addon.date.$date);
      return addonDate.getTime() !== paymentDateObj.getTime();
    });
    const newExtraAddons = addon_services.map((addon) => ({
      name: addon.name,
      amount: parseFloat(addon.amount),
      date: oldPayment.date, // Keep the same date as the payment
    }));

    // Update the payment in payment_history
    const updatedPayment = {
      ...oldPayment,
      amount: parseFloat(amount),
      type,
      addon_services: addon_services.map((addon) => ({
        name: addon.name,
        amount: parseFloat(addon.amount),
      })),
      last_modified: new Date(),
    };

    const newAddonsAmount =
      (parseFloat(therapyPlan.addons_amount) || 0) + addonsDifference;

    // Update using array filters to match the exact payment
    const updateResult = await req.orgDb.collection("plans").updateOne(
      { _id: new ObjectId(planId) },
      {
        $set: {
          received_amount: newReceivedAmount.toString(),
          balance: newBalance.toString(),
          [`payment_history.${paymentIndex}`]: updatedPayment,
          extra_addons: [...filteredExtraAddons, ...newExtraAddons],
          addons_amount: newAddonsAmount,
        },
      },
    );

    if (updateResult.modifiedCount === 0) {
      return res.status(400).json({
        message: "Failed to update payment",
      });
    }

    // Update payment in payments collection using therapyId
    const Payment = getPaymentModel(req.orgDb);

    // Calculate total payment amount (session + addons)
    const sessionAmount = parseFloat(amount);
    const totalPaymentAmount = sessionAmount + newAddonsTotal;

    // Find and update the payment record using therapyId
    let paymentUpdateResult = { modifiedCount: 0 };

    if (oldPayment.therapyId) {
      // Validate therapyId format
      if (!ObjectId.isValid(oldPayment.therapyId)) {
        console.warn(`Invalid therapyId format: ${oldPayment.therapyId}`);
      } else {
        // Use findOneAndUpdate for better debugging
        const updatedPaymentDoc = await Payment.findOneAndUpdate(
          { therapyId: new ObjectId(oldPayment.therapyId) },
          {
            $set: {
              amount: totalPaymentAmount, // Updated: session + addons
              type,
              addon_services: addon_services.map((addon) => ({
                name: addon.name,
                amount: parseFloat(addon.amount),
              })),
              balance_after_payment: newBalance,
              received_amount_total: newReceivedAmount,
              last_modified: new Date(),
            },
          },
          { new: true },
        );

        if (updatedPaymentDoc) {
          paymentUpdateResult.modifiedCount = 1;
        } else {
          console.warn(
            `Payment record with therapyId ${oldPayment.therapyId} not found in payments collection`,
          );

          // Debug: Check if payment exists with different query
          const existingPayment = await Payment.findOne({
            therapyId: new ObjectId(oldPayment.therapyId),
          });
          console.log("Payment search result:", existingPayment);
        }
      }
    } else {
      console.warn(
        "No therapyId found in payment history, cannot update payments collection",
      );
    }

    return res.status(200).json({
      message: "Payment updated successfully",
      updated_payment: updatedPayment,
      new_balance: newBalance,
      new_received_amount: newReceivedAmount,
      new_addons_amount: newAddonsAmount,
      updated_extra_addons: [...filteredExtraAddons, ...newExtraAddons],
      payment_collection_updated: paymentUpdateResult.modifiedCount > 0,
    });
  } catch (error) {
    console.error("Error in editPayment:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};
const deletePayment = async (req, res) => {
  try {
    const { planId, paymentDate } = req.params;

    if (!ObjectId.isValid(planId)) {
      return res.status(400).json({
        msg: "Invalid therapy plan ID format",
      });
    }

    const therapyPlan = await req.orgDb
      .collection("plans")
      .findOne({ _id: new ObjectId(planId) });

    if (!therapyPlan) {
      return res.status(404).json({
        msg: "Therapy plan not found",
      });
    }

    // Find the payment to delete using payment date
    const paymentToDelete = therapyPlan.payment_history.find((payment) => {
      if (!payment.date) return false;
      const storedDate =
        payment.date instanceof Date
          ? payment.date.toISOString()
          : payment.date.$date || payment.date.toString();
      return storedDate === paymentDate;
    });

    if (!paymentToDelete) {
      return res.status(404).json({
        msg: "Payment not found",
        searchDate: paymentDate,
        availableDates: therapyPlan.payment_history.map((p) =>
          p.date instanceof Date
            ? p.date.toISOString()
            : p.date.$date || p.date.toString(),
        ),
      });
    }

    // Calculate addon amount to remove
    const addonsToRemove = paymentToDelete.addon_services || [];
    const addonsAmountToRemove = addonsToRemove.reduce(
      (sum, addon) => sum + parseFloat(addon.amount),
      0,
    );
    const newAddonsAmount = Math.max(
      0,
      (parseFloat(therapyPlan.addons_amount) || 0) - addonsAmountToRemove,
    );

    // Filter out addons with matching date
    const paymentDateObj = new Date(paymentDate);
    const updatedExtraAddons = therapyPlan.extra_addons.filter((addon) => {
      const addonDate =
        addon.date instanceof Date ? addon.date : new Date(addon.date.$date);
      return addonDate.getTime() !== paymentDateObj.getTime();
    });

    // Calculate new received amount and balance
    const currentReceivedAmount = parseFloat(therapyPlan.received_amount);
    const totalAmount = parseFloat(therapyPlan.total_amount);
    const newReceivedAmount =
      currentReceivedAmount - parseFloat(paymentToDelete.amount);
    const newBalance = totalAmount - newReceivedAmount;

    const updateResult = await req.orgDb.collection("plans").updateOne(
      { _id: new ObjectId(planId) },
      {
        $set: {
          received_amount: newReceivedAmount.toString(),
          balance: newBalance.toString(),
          extra_addons: updatedExtraAddons,
          addons_amount: newAddonsAmount,
        },
        $pull: {
          payment_history: {
            date: paymentToDelete.date,
          },
        },
      },
    );

    if (updateResult.modifiedCount === 0) {
      return res.status(400).json({
        message: "Failed to delete payment",
      });
    }

    // Delete payment from payments collection using therapyId
    const Payment = getPaymentModel(req.orgDb);
    let paymentDeleteResult = { deletedCount: 0 };

    if (paymentToDelete.therapyId) {
      // Validate therapyId format
      if (!ObjectId.isValid(paymentToDelete.therapyId)) {
        console.warn(`Invalid therapyId format: ${paymentToDelete.therapyId}`);
      } else {
        // Use findOneAndDelete for better debugging
        const deletedPaymentDoc = await Payment.findOneAndDelete({
          therapyId: new ObjectId(paymentToDelete.therapyId),
        });

        if (deletedPaymentDoc) {
          paymentDeleteResult.deletedCount = 1;
        } else {
          console.warn(
            `Payment record with therapyId ${paymentToDelete.therapyId} not found in payments collection`,
          );

          // Debug: Check if payment exists
          const existingPayment = await Payment.findOne({
            therapyId: new ObjectId(paymentToDelete.therapyId),
          });
          console.log("Payment search result:", existingPayment);
        }
      }
    } else {
      console.warn(
        "No therapyId found in payment history, cannot delete from payments collection",
      );
    }

    return res.status(200).json({
      message: "Payment deleted successfully",
      new_balance: newBalance,
      new_received_amount: newReceivedAmount,
      new_addons_amount: newAddonsAmount,
      removed_addons: addonsToRemove,
      payment_collection_deleted: paymentDeleteResult.deletedCount > 0,
    });
  } catch (error) {
    console.error("Error in deletePayment:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};
const syncTherapyPlanPayments = async (req, res) => {
  try {
    const Payment = getPaymentModel(req.orgDb);
    const Patient = getPatientModel(req.orgDb);

    // Get all therapy plans
    const allPlans = await req.orgDb.collection("plans").find({}).toArray();

    console.log(`Found ${allPlans.length} therapy plans to process`);

    let processedCount = 0;
    let createdPayments = 0;
    let skippedCount = 0;
    let errorCount = 0;
    const errors = [];

    for (const plan of allPlans) {
      try {
        console.log(`Processing plan: ${plan._id}`);

        // Find the patient who owns this plan
        const patient = await Patient.findOne({
          therapy_plans: new ObjectId(plan._id),
        });

        if (!patient) {
          console.log(`No patient found for plan ${plan._id}, skipping`);
          skippedCount++;
          continue;
        }

        // Determine doctor_id - use patient's doctorId if available, otherwise use created_by from plan
        let doctorId = null;
        if (patient.doctorId) {
          doctorId = patient.doctorId;
        } else if (plan.created_by) {
          doctorId = plan.created_by;
        }

        if (!doctorId) {
          console.log(`No doctor found for plan ${plan._id}, skipping`);
          skippedCount++;
          continue;
        }

        // Get payment history for analysis
        const paymentHistory =
          plan.payment_history && Array.isArray(plan.payment_history)
            ? plan.payment_history
            : [];

        // Check if we should create an initial payment based on received_amount
        const receivedAmount = parseFloat(plan.received_amount || 0);
        const totalAmount = parseFloat(plan.total_amount || 0);
        const balance = totalAmount - receivedAmount;

        // Check if there's already a payment with payment_number: 1 in history
        const hasPaymentNumber1InHistory = paymentHistory.some(
          (p) => p.payment_number === 1,
        );

        if (receivedAmount > 0 && !hasPaymentNumber1InHistory) {
          // Check if initial payment already exists in database
          const existingInitialPayment = await Payment.findOne({
            therapy_plan_id: new ObjectId(plan._id),
            payment_number: 1,
          });

          if (!existingInitialPayment) {
            try {
              // Create initial payment record (similar to createTherapyPlan)
              await Payment.create({
                amount: receivedAmount,
                type: "CASH", // Default to Cash as in createTherapyPlan
                date: plan.start_date || plan.created_at || new Date(),
                therapy_plan_id: new ObjectId(plan._id),
                patient_id: new ObjectId(patient._id),
                doctor_id: new ObjectId(doctorId),
                balance_after_payment: balance,
                received_amount_total: receivedAmount,
                tenant_id: req.user?.tenant_id || patient.tenant_id,
                addon_services: [], // Empty array for initial payment
                payment_number: 1, // First payment
              });

              createdPayments++;
              console.log(
                `Created initial payment for plan ${plan._id} (payment #1)`,
              );
            } catch (paymentError) {
              console.error(
                `Error creating initial payment for plan ${plan._id}:`,
                paymentError,
              );
              errors.push({
                planId: plan._id,
                paymentNumber: 1,
                error: paymentError.message,
                type: "initial_payment",
              });
              errorCount++;
            }
          }
        } else if (receivedAmount > 0 && hasPaymentNumber1InHistory) {
          console.log(
            `Plan ${plan._id} has received_amount but payment #1 exists in history - will be processed in history section`,
          );
        }

        // Process payment history if it exists
        if (paymentHistory.length > 0) {
          console.log(
            `Processing ${paymentHistory.length} payment history entries for plan ${plan._id}`,
          );

          for (const paymentHistoryEntry of paymentHistory) {
            try {
              // Check if this payment already exists in payments collection
              const existingPayment = await Payment.findOne({
                therapy_plan_id: new ObjectId(plan._id),
                payment_number: paymentHistoryEntry.payment_number,
              });

              if (existingPayment) {
                console.log(
                  `Payment already exists for plan ${plan._id}, payment number ${paymentHistoryEntry.payment_number}`,
                );
                continue;
              }

              // Find corresponding therapy session if available
              let therapyId = null;
              if (
                plan.therapy_sessions &&
                Array.isArray(plan.therapy_sessions)
              ) {
                // Try to match by session_number if available
                if (paymentHistoryEntry.session_number) {
                  const matchingSession = plan.therapy_sessions.find(
                    (session) =>
                      session.session_number ===
                      paymentHistoryEntry.session_number,
                  );
                  if (matchingSession) {
                    therapyId = matchingSession._id;
                  }
                }

                // If no match by session_number, use the first available session
                if (!therapyId && plan.therapy_sessions.length > 0) {
                  therapyId = plan.therapy_sessions[0]._id;
                }
              }

              // Calculate running totals up to this payment
              const paymentsUpToThis = paymentHistory
                .filter(
                  (p) => p.payment_number <= paymentHistoryEntry.payment_number,
                )
                .reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);

              const balanceAfterThisPayment = totalAmount - paymentsUpToThis;

              // Create payment record from history
              const paymentData = {
                amount: parseFloat(paymentHistoryEntry.amount),
                type: paymentHistoryEntry.type || "CASH",
                date: paymentHistoryEntry.date || new Date(),
                doctor_id: new ObjectId(doctorId),
                therapy_plan_id: new ObjectId(plan._id),
                patient_id: new ObjectId(patient._id),
                payment_number: paymentHistoryEntry.payment_number,
                addon_services: paymentHistoryEntry.addon_services || [],
                balance_after_payment: balanceAfterThisPayment,
                received_amount_total: paymentsUpToThis,
                tenant_id: req.user?.tenant_id || patient.tenant_id,
              };

              // Add therapyId if found
              if (therapyId) {
                paymentData.therapyId = new ObjectId(therapyId);
              }

              // Create the payment
              await Payment.create(paymentData);
              createdPayments++;

              console.log(
                `Created payment from history for plan ${plan._id}, payment number ${paymentHistoryEntry.payment_number}, amount: ${paymentHistoryEntry.amount}`,
              );
            } catch (paymentError) {
              console.error(
                `Error creating payment from history for plan ${plan._id}:`,
                paymentError,
              );
              errors.push({
                planId: plan._id,
                paymentNumber: paymentHistoryEntry.payment_number,
                error: paymentError.message,
                type: "history_payment",
              });
              errorCount++;
            }
          }
        } else {
          console.log(`No payment history found for plan ${plan._id}`);
        }

        processedCount++;
      } catch (planError) {
        console.error(`Error processing plan ${plan._id}:`, planError);
        errors.push({
          planId: plan._id,
          error: planError.message,
          type: "plan_processing",
        });
        errorCount++;
      }
    }

    const summary = {
      total_plans: allPlans.length,
      processed_plans: processedCount,
      skipped_plans: skippedCount,
      created_payments: createdPayments,
      errors: errorCount,
      error_details: errors,
    };

    console.log("Sync completed:", summary);

    return res.status(200).json({
      message: "Therapy plan payments sync completed",
      summary,
    });
  } catch (error) {
    console.error("Error in syncTherapyPlanPayments:", error);
    return res.status(500).json({
      message: "Internal server error during sync",
      error: error.message,
    });
  }
};

// Alternative function to sync payments for a specific plan
const syncSinglePlanPayments = async (req, res) => {
  try {
    const { planId } = req.params;

    if (!ObjectId.isValid(planId)) {
      return res.status(400).json({ message: "Invalid plan ID format" });
    }

    const Payment = getPaymentModel(req.orgDb);
    const Patient = getPatientModel(req.orgDb);

    // Get the specific plan
    const plan = await req.orgDb
      .collection("plans")
      .findOne({ _id: new ObjectId(planId) });

    if (!plan) {
      return res.status(404).json({ message: "Plan not found" });
    }

    // Skip if no payment history
    if (
      !plan.payment_history ||
      !Array.isArray(plan.payment_history) ||
      plan.payment_history.length === 0
    ) {
      return res.status(200).json({
        message: "Plan has no payment history to sync",
        created_payments: 0,
      });
    }

    // Find the patient who owns this plan
    const patient = await Patient.findOne({
      therapy_plans: new ObjectId(plan._id),
    });

    if (!patient) {
      return res
        .status(404)
        .json({ message: "Patient not found for this plan" });
    }

    // Determine doctor_id
    let doctorId = null;
    if (patient.doctorId) {
      doctorId = patient.doctorId;
    } else if (plan.created_by) {
      doctorId = plan.created_by;
    }

    if (!doctorId) {
      return res.status(400).json({ message: "No doctor found for this plan" });
    }

    let createdPayments = 0;
    const errors = [];

    // Process each payment in payment_history
    for (const paymentHistory of plan.payment_history) {
      try {
        // Check if this payment already exists
        const existingPayment = await Payment.findOne({
          therapy_plan_id: new ObjectId(plan._id),
          amount: paymentHistory.amount,
          date: paymentHistory.date,
          payment_number: paymentHistory.payment_number,
        });

        if (existingPayment) {
          console.log(
            `Payment already exists for payment number ${paymentHistory.payment_number}`,
          );
          continue;
        }

        // Find corresponding therapy session
        let therapyId = null;
        if (plan.therapy_sessions && Array.isArray(plan.therapy_sessions)) {
          if (paymentHistory.session_number) {
            const matchingSession = plan.therapy_sessions.find(
              (session) =>
                session.session_number === paymentHistory.session_number,
            );
            if (matchingSession) {
              therapyId = matchingSession._id;
            }
          }

          if (!therapyId && plan.therapy_sessions.length > 0) {
            therapyId = plan.therapy_sessions[0]._id;
          }
        }

        // Create payment record
        const paymentData = {
          amount: parseFloat(paymentHistory.amount),
          type: paymentHistory.type || "recurring",
          date: paymentHistory.date || new Date(),
          doctor_id: new ObjectId(doctorId),
          therapy_plan_id: new ObjectId(plan._id),
          patient_id: new ObjectId(patient._id),
          payment_number: paymentHistory.payment_number,
          addon_services: paymentHistory.addon_services || [],
          balance_after_payment: parseFloat(plan.balance || 0),
          received_amount_total: parseFloat(plan.received_amount || 0),
          tenant_id: req.user?.tenant_id || patient.tenant_id,
        };

        if (therapyId) {
          paymentData.therapyId = new ObjectId(therapyId);
        }

        await Payment.create(paymentData);
        createdPayments++;
      } catch (paymentError) {
        console.error(`Error creating payment:`, paymentError);
        errors.push({
          paymentNumber: paymentHistory.payment_number,
          error: paymentError.message,
        });
      }
    }

    return res.status(200).json({
      message: "Plan payments sync completed",
      planId: planId,
      created_payments: createdPayments,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error("Error in syncSinglePlanPayments:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};
module.exports = {
  getPatientTherapyPlans,
  getTherapyPlan,
  editTherapyPlan,
  activeTherapyPlans,
  recordPayment,
  getPaymentInfo,
  editPayment,
  deletePayment,
  getPlanTherapies,
  addNoteInTherapy,
  syncTherapyPlanPayments,
  syncSinglePlanPayments,
  deleteTherapyPlan,
  recordPatientPayment,
  closeTherapyPlan,
  printTherapyPlan,
  printPatientRegistration,
  getGlobalAftercareReport,
  completedTherapyPlans,
  revertTherapyPlan,
};
