const { getMedicalReportModel } = require("../db/medicalReportSchema");
const { getTherapyPlanModel } = require("../db/therepy"); // Add this!
const { getPatientModel } = require("../db/patientSchema");

// 1. ADD A MEDICAL REPORT TO A PLAN
const addMedicalReportToPlan = async (req, res) => {
  try {
    const { planId, patientId } = req.params;
    const reportData = req.body;
    const { user, orgDb } = req;

    const TherapyPlan = getTherapyPlanModel(orgDb);
    const MedicalReport = getMedicalReportModel(orgDb);
    const Patient = getPatientModel(orgDb);

    const plan = await TherapyPlan.findById(planId);
    if (!plan) return res.status(404).json({ msg: "Therapy plan not found" });

    const patientData = await Patient.findById(patientId);
    if (!patientData) return res.status(404).json({ msg: "Patient not found" });

    if (!reportData.parameters || !reportData.parameters.length) {
      return res
        .status(400)
        .json({ msg: "At least one report parameter is required" });
    }

    const reportNumber =
      reportData.report_number ||
      `RPT-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const newReport = new MedicalReport({
      report_number: reportNumber,
      patient_id: patientId,
      patient_name:
        `${patientData.patient_first_name || ""} ${patientData.patient_last_name || ""}`.trim(),
      doctor_id: reportData.doctor_id || user.doctor_id,
      doctor_name:
        reportData.doctor_name ||
        user.doctor_name ||
        `${user.doctor_first_name || ""} ${user.doctor_last_name || ""}`.trim(),
      plan_id: planId,
      lab_name: reportData.lab_name || "",
      report_type: reportData.report_type,
      report_date: reportData.report_date || new Date(),
      parameters: reportData.parameters,
      method: reportData.method || "",
      interpretation: reportData.interpretation || "",
      attachment_url: reportData.attachment_url || "",
      notes: reportData.notes || "",
      status: "Active",
    });

    const savedReport = await newReport.save();

    // Atomic push — mirrors the fix already applied to createTherapyPlan/
    // prescription saves, so this array can't silently drop an entry
    // under concurrent writes the way a find-then-save() round trip can.
    await TherapyPlan.findByIdAndUpdate(planId, {
      $push: { medical_reports: savedReport._id },
    });

    return res.status(201).json({
      msg: "Medical report added successfully",
      report: savedReport,
    });
  } catch (error) {
    console.error("Add Medical Report Error: ", error);
    res.status(500).json({ msg: "Server error", error: error.message });
  }
};

// 2. EDIT AN EXISTING MEDICAL REPORT
const editMedicalReport = async (req, res) => {
  try {
    const { reportId } = req.params;
    const updateData = req.body;
    const MedicalReport = getMedicalReportModel(req.orgDb);

    const updatedReport = await MedicalReport.findByIdAndUpdate(
      reportId,
      {
        $set: {
          report_type: updateData.report_type,
          lab_name: updateData.lab_name,
          report_date: updateData.report_date,
          parameters: updateData.parameters,
          method: updateData.method,
          interpretation: updateData.interpretation,
          notes: updateData.notes,
          updated_at: new Date(),
        },
      },
      { new: true, runValidators: true },
    );

    if (!updatedReport)
      return res.status(404).json({ msg: "Medical report not found" });

    return res
      .status(200)
      .json({ msg: "Medical report updated", report: updatedReport });
  } catch (error) {
    console.error("Edit Medical Report Error: ", error);
    res.status(500).json({ msg: "Server error", error: error.message });
  }
};

// 3. ARCHIVE A MEDICAL REPORT (soft delete — keeps history intact)
const archiveMedicalReport = async (req, res) => {
  try {
    const { reportId } = req.params;
    const MedicalReport = getMedicalReportModel(req.orgDb);

    const archivedReport = await MedicalReport.findByIdAndUpdate(
      reportId,
      { $set: { status: "Archived", updated_at: new Date() } },
      { new: true },
    );

    if (!archivedReport)
      return res.status(404).json({ msg: "Medical report not found" });

    return res
      .status(200)
      .json({ msg: "Medical report archived", report: archivedReport });
  } catch (error) {
    console.error("Archive Medical Report Error: ", error);
    res.status(500).json({ msg: "Server error", error: error.message });
  }
};

// 4. GET ALL MEDICAL REPORTS FOR A PLAN
const getPlanMedicalReports = async (req, res) => {
  try {
    const { planId } = req.params;
    const TherapyPlan = getTherapyPlanModel(req.orgDb);
    const MedicalReport = getMedicalReportModel(req.orgDb);

    const plan = await TherapyPlan.findById(planId).select("medical_reports");
    if (!plan) return res.status(404).json({ msg: "Therapy plan not found" });

    if (!plan.medical_reports || !plan.medical_reports.length) {
      return res.status(200).json({ reports: [] });
    }

    const reports = await MedicalReport.find({
      _id: { $in: plan.medical_reports },
    }).sort({ report_date: -1 });

    return res.status(200).json({ reports });
  } catch (error) {
    console.error("Get Plan Medical Reports Error: ", error);
    res.status(500).json({ msg: "Server error", error: error.message });
  }
};

// 5. ADD A VITALS READING TO A PLAN
// Vitals are embedded directly on the plan (not their own collection),
// so the atomic equivalent is $push on the plan document itself.
const addVitalsReading = async (req, res) => {
  try {
    const { planId } = req.params;
    const { user } = req;
    const reading = req.body;

    const TherapyPlan = getTherapyPlanModel(req.orgDb);

    const hasAnyVital = [
      "pulse",
      "temperature",
      "bp_systolic",
      "bp_diastolic",
      "respiratory_rate",
      "spo2",
      "weight",
      "blood_glucose",
      "pain_score",
    ].some((key) => reading[key] !== undefined && reading[key] !== "");

    if (!hasAnyVital) {
      return res
        .status(400)
        .json({ msg: "At least one vital value is required" });
    }

    const newReading = {
      recorded_at: reading.recorded_at || new Date(),
      pulse: reading.pulse,
      temperature: reading.temperature,
      bp_systolic: reading.bp_systolic,
      bp_diastolic: reading.bp_diastolic,
      respiratory_rate: reading.respiratory_rate,
      spo2: reading.spo2,
      weight: reading.weight,
      blood_glucose: reading.blood_glucose,
      pain_score: reading.pain_score,
      notes: reading.notes || "",
      recorded_by: reading.recorded_by || user.doctor_id,
      recorded_by_name:
        reading.recorded_by_name ||
        user.doctor_name ||
        `${user.doctor_first_name || ""} ${user.doctor_last_name || ""}`.trim(),
      session_id: reading.session_id || null,
    };

    const updatedPlan = await TherapyPlan.findByIdAndUpdate(
      planId,
      { $push: { vitals_history: newReading } },
      { new: true, runValidators: true },
    ).select("vitals_history");

    if (!updatedPlan)
      return res.status(404).json({ msg: "Therapy plan not found" });

    return res.status(201).json({
      msg: "Vitals reading added",
      // Return just the newly added entry, not the whole history —
      // cheaper for the frontend to append to its existing list with
      reading:
        updatedPlan.vitals_history[updatedPlan.vitals_history.length - 1],
    });
  } catch (error) {
    console.error("Add Vitals Reading Error: ", error);
    res.status(500).json({ msg: "Server error", error: error.message });
  }
};

// 6. EDIT A SPECIFIC VITALS READING (e.g. fix a typo'd value)
const editVitalsReading = async (req, res) => {
  try {
    const { planId, readingId } = req.params;
    const updateData = req.body;
    const TherapyPlan = getTherapyPlanModel(req.orgDb);

    const setFields = {};
    [
      "pulse",
      "temperature",
      "bp_systolic",
      "bp_diastolic",
      "respiratory_rate",
      "spo2",
      "weight",
      "blood_glucose",
      "pain_score",
      "notes",
    ].forEach((key) => {
      if (updateData[key] !== undefined) {
        setFields[`vitals_history.$.${key}`] = updateData[key];
      }
    });

    const updatedPlan = await TherapyPlan.findOneAndUpdate(
      { _id: planId, "vitals_history._id": readingId },
      { $set: setFields },
      { new: true, runValidators: true },
    ).select("vitals_history");

    if (!updatedPlan)
      return res
        .status(404)
        .json({ msg: "Therapy plan or vitals reading not found" });

    const updatedReading = updatedPlan.vitals_history.find(
      (v) => v._id.toString() === readingId,
    );

    return res
      .status(200)
      .json({ msg: "Vitals reading updated", reading: updatedReading });
  } catch (error) {
    console.error("Edit Vitals Reading Error: ", error);
    res.status(500).json({ msg: "Server error", error: error.message });
  }
};

// 7. GET VITALS HISTORY FOR A PLAN (lightweight — for trend charts on the dashboard)
const getPlanVitalsHistory = async (req, res) => {
  try {
    const { planId } = req.params;
    const TherapyPlan = getTherapyPlanModel(req.orgDb);

    const plan = await TherapyPlan.findById(planId).select("vitals_history");
    if (!plan) return res.status(404).json({ msg: "Therapy plan not found" });

    const sorted = [...(plan.vitals_history || [])].sort(
      (a, b) => new Date(b.recorded_at) - new Date(a.recorded_at),
    );

    return res.status(200).json({ vitals_history: sorted });
  } catch (error) {
    console.error("Get Plan Vitals History Error: ", error);
    res.status(500).json({ msg: "Server error", error: error.message });
  }
};

module.exports = {
  addMedicalReportToPlan,
  editMedicalReport,
  archiveMedicalReport,
  getPlanMedicalReports,
  addVitalsReading,
  editVitalsReading,
  getPlanVitalsHistory,
};
