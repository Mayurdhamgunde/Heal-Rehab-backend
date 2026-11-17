const mongoose = require("mongoose");
const { getPatientAssessmentModel } = require("../db/patientAssessmentSchema");
const { getDoctorModel } = require("../db/doctorschema");
const { getPatientModel } = require("../db/patientSchema");
const { getFormTemplateModel } = require("../db/formBuilderSchema");
const { getTherapyPlanModel, getTherapySession } = require("../db/therepy");
const { getPrescriptionModel } = require("../db/prescriptionSchema");
const {
  generatepatientImageSasToken,
  generateImageSasTokenLogo,
} = require("../utils/azureutils");
const Organization = require("../db/OrganizationSchema");

// 1. Create a new Patient Assessment
// 1. Create a new Patient Assessment
const createAssessment = async (req, res) => {
  try {
    const {
      patient_id,
      template_id,
      assessment_name,
      responses,
      status,
      general_notes,
      date_taken,
    } = req.body;

    if (!patient_id || !template_id || !assessment_name) {
      return res.status(400).json({
        msg: "patient_id, template_id, and assessment_name are required.",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(patient_id)) {
      return res.status(400).json({ msg: "Invalid patient_id format." });
    }

    let assessmentDate = new Date();
    if (date_taken) {
      const parsed = new Date(date_taken);
      if (isNaN(parsed.getTime())) {
        return res.status(400).json({ msg: "Invalid date_taken value." });
      }
      if (parsed > new Date()) {
        return res
          .status(400)
          .json({ msg: "date_taken cannot be in the future." });
      }
      assessmentDate = parsed;
    }

    const PatientAssessment = getPatientAssessmentModel(req.orgDb);
    const Doctor = getDoctorModel(req.orgDb);
    const FormTemplate = getFormTemplateModel(req.orgDb);
    const Patient = getPatientModel(req.orgDb);

    // Parallel fetch doctor and template snapshot to minimize latency
    const [doctor, templateSnapshot] = await Promise.all([
      Doctor.findOne({ doctor_email: req.user.email })
        .select("doctor_first_name doctor_last_name")
        .lean(),
      FormTemplate.findById(template_id).lean(),
    ]);

    if (!doctor) {
      return res
        .status(404)
        .json({ msg: "Doctor profile not found for the current user." });
    }

    const newAssessment = new PatientAssessment({
      patient_id,
      doctor_id: doctor._id,
      template_id,
      assessment_name,
      date_taken: assessmentDate,
      template_snapshot: templateSnapshot || {},
      responses: responses || [],
      status: status || "Completed",
      general_notes: general_notes || "",
    });

    const savedAssessment = await newAssessment.save();

    // Fast conditional journey logging: single atomic roundtrip
    const patientObjectId = new mongoose.Types.ObjectId(patient_id);
    const doctorName =
      `${doctor.doctor_first_name} ${doctor.doctor_last_name}`.trim();

    const journeyEntry = {
      stage: "Completed First Assessment",
      performed_by_id: doctor._id,
      performed_by_name: doctorName,
      performed_at: new Date(),
      notes: `Assessment completed: ${assessment_name}`,
      status: "Completed",
    };

    await Patient.updateOne(
      {
        _id: patientObjectId,
        "patient_journey.stage": { $ne: "Completed First Assessment" },
      },
      {
        $push: { patient_journey: journeyEntry },
      },
    );

    return res.status(201).json({
      message: "Assessment saved successfully",
      assessment: savedAssessment,
    });
  } catch (error) {
    console.error("Error creating assessment:", error);
    return res
      .status(500)
      .json({ message: "Error creating assessment", error: error.message });
  }
};

// 2. Get all Assessments (Optionally filtered by patientId)
const getAllAssessments = async (req, res) => {
  try {
    const { patientId } = req.query;

    const PatientAssessment = getPatientAssessmentModel(req.orgDb);
    getDoctorModel(req.orgDb);

    const query = {};
    if (patientId) {
      if (!mongoose.Types.ObjectId.isValid(patientId)) {
        return res.status(400).json({ error: "Invalid patient ID format" });
      }
      query.patient_id = patientId;
    }

    const assessments = await PatientAssessment.find(query)
      .populate("doctor_id", "doctor_first_name doctor_last_name")
      .sort({ date_taken: -1 })
      .lean();

    return res.status(200).json({ assessments });
  } catch (error) {
    console.error("Error retrieving assessments:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

const getAssessmentById = async (req, res) => {
  try {
    const { assessmentId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(assessmentId)) {
      return res.status(400).json({ error: "Invalid assessment ID format" });
    }

    const PatientAssessment = getPatientAssessmentModel(req.orgDb);
    getDoctorModel(req.orgDb);
    getPatientModel(req.orgDb);

    const assessment = await PatientAssessment.findById(assessmentId)
      .populate("doctor_id", "doctor_first_name doctor_last_name")
      .populate(
        "patient_id",
        "patient_first_name patient_last_name UHID patient_image",
      )
      .lean();

    if (!assessment) {
      return res.status(404).json({ error: "Assessment not found" });
    }

    if (assessment.patient_id && assessment.patient_id.patient_image) {
      assessment.patient_id.patient_image = await generatepatientImageSasToken(
        assessment.patient_id.patient_image,
      );
    }

    const snapshotQuestions = Array.isArray(
      assessment.template_snapshot?.questions,
    )
      ? assessment.template_snapshot.questions
      : [];

    const snapshotMap = {};
    for (const q of snapshotQuestions) {
      snapshotMap[q.id] = q;
    }

    const resolvedResponses = (assessment.responses || []).map((r) => {
      const snapQ = snapshotMap[r.question_id] || {};
      const type = r.question_type || snapQ.type || "";

      const base = {
        question_id: r.question_id,
        question_title: r.question_title || snapQ.title || "",
        question: r.question_title || snapQ.title || "",
        type: type,
        question_type: type,
        score: r.score,
        notes: r.notes,
      };

      if (type === "section_header") {
        return { ...base, answer: null };
      }

      // --- ADDED: Nested MCQ Formatter ---
      if (type === "nested_mcq") {
        const rawAnswer =
          r.answer && typeof r.answer === "object" ? r.answer : {};
        const parent = rawAnswer.selectedParent || "";
        const subs =
          Array.isArray(rawAnswer.subSelections) &&
          rawAnswer.subSelections.length > 0
            ? rawAnswer.subSelections.join(", ")
            : "";

        let displayAnswer = parent;
        if (parent && subs) {
          displayAnswer = `${parent} - ${subs}`; // Formats to "Uncomplicated - TREMORS, INSOMNIA"
        }

        return {
          ...base,
          answer: displayAnswer || null, // Clean string for viewing/printing
          answer_raw: rawAnswer, // Keeps the object structure for Editing
        };
      }
      // -----------------------------------

      if (type === "radio" || type === "dropdown") {
        const options = snapQ.options || [];
        const matched = options.find((o) => o.id === r.answer);
        return {
          ...base,
          answer: matched ? matched.value : (r.answer ?? null),
          answer_raw: r.answer ?? null,
        };
      }

      if (type === "checkbox") {
        const options = snapQ.options || [];
        const selectedIds = Array.isArray(r.answer) ? r.answer : [];
        const selectedLabels = selectedIds.map((id) => {
          const opt = options.find((o) => o.id === id);
          return opt ? opt.value : id;
        });
        return {
          ...base,
          answer: selectedLabels,
          answer_raw: selectedIds,
        };
      }
      if (type === "table") {
        const columns = snapQ.columns || [];
        const rows = snapQ.rows || [];
        const rawAnswer =
          r.answer && typeof r.answer === "object" ? r.answer : {};

        const resolvedRows = rows.map((rowDef) => {
          const rowAnswer = rawAnswer[rowDef.id] || {};
          const cells = columns.map((colDef) => ({
            col_id: colDef.id,
            col_label: colDef.value || "",
            col_type: colDef.colType || "text",
            value: rowAnswer[colDef.id] ?? null,
            reference_value: rowDef.referenceValues
              ? rowDef.referenceValues[colDef.id]
              : null, // Appends the reference text dynamically
          }));

          return {
            row_id: rowDef.id,
            sr_no: rowDef.srNo || null,
            // FIX: Prefer the user-typed label (__rowLabel) over the template label
            row_label:
              rowAnswer.__rowLabel !== undefined
                ? rowAnswer.__rowLabel
                : rowDef.label || "",
            cell_type: rowDef.cellType || "text",
            is_sub_row: rowDef.isSubRow || false,
            unit: rowDef.unit || null,
            cell_descriptions: rowDef.cellDescriptions || [],
            cells,
          };
        });

        return {
          ...base,
          columns: columns.map((c) => ({
            id: c.id,
            label: c.value || "",
            col_type: c.colType || "text",
          })),
          has_row_labels: snapQ.hasRowLabels !== false,
          show_total_score: snapQ.showTotalScore || false,
          print_side_by_side: snapQ.printSideBySide || false,
          hide_empty_dashes: snapQ.hideEmptyDashes || false, // <--- NEW
          large_table_print: snapQ.largeTablePrint || false, // <--- NEW
          answer: resolvedRows,
          answer_raw: rawAnswer,
        };
      }

      if (type === "inline_blanks") {
        const blankLines = snapQ.blankLines || [];
        const templateText = snapQ.templateText || "";
        const rawAnswer =
          r.answer && typeof r.answer === "object" ? r.answer : {};

        const resolvedBlanks = blankLines.map((blank) => ({
          blank_id: blank.id,
          blank_label: blank.text || "",
          value: rawAnswer[blank.id] ?? null,
        }));

        return {
          ...base,
          template_text: templateText,
          blanks: resolvedBlanks,
          answer: rawAnswer,
        };
      }

      return {
        ...base,
        answer: r.answer ?? null,
      };
    });

    assessment.responses = resolvedResponses;

    return res.status(200).json({ assessment });
  } catch (error) {
    console.error("Error fetching assessment:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// 4. Update an Assessment
const updateAssessment = async (req, res) => {
  try {
    const { assessmentId } = req.params;
    const { responses, status, general_notes } = req.body;

    if (!mongoose.Types.ObjectId.isValid(assessmentId)) {
      return res.status(400).json({ error: "Invalid assessment ID format" });
    }

    const PatientAssessment = getPatientAssessmentModel(req.orgDb);
    getDoctorModel(req.orgDb);

    const existingAssessment = await PatientAssessment.findById(
      assessmentId,
      "doctor_id",
    ).lean();

    if (!existingAssessment) {
      return res.status(404).json({ msg: "Assessment not found" });
    }

    if (existingAssessment.doctor_id.toString() !== req.doctor_id.toString()) {
      return res.status(403).json({
        msg: "You are not authorized to update this assessment",
      });
    }

    const updateData = {};
    if (responses !== undefined) updateData.responses = responses;
    if (status !== undefined) updateData.status = status;
    if (general_notes !== undefined) updateData.general_notes = general_notes;
    if (req.body.date_taken !== undefined) {
      const parsed = new Date(req.body.date_taken);
      if (!isNaN(parsed.getTime()) && parsed <= new Date()) {
        updateData.date_taken = parsed;
      }
    }

    const updatedAssessment = await PatientAssessment.findByIdAndUpdate(
      assessmentId,
      { $set: updateData },
      { new: true },
    );

    await updatedAssessment.populate(
      "doctor_id",
      "doctor_first_name doctor_last_name",
    );

    return res.status(200).json({
      msg: "Assessment updated successfully",
      assessment: updatedAssessment,
    });
  } catch (error) {
    console.error("Error updating assessment:", error);
    return res.status(500).json({ msg: "Internal server error" });
  }
};

const getPatientForPrint = async (req, res) => {
  try {
    const { patientId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ error: "Invalid patient ID format" });
    }

    const PatientAssessment = getPatientAssessmentModel(req.orgDb);
    const Patient = getPatientModel(req.orgDb);
    const TherapyPlan = getTherapyPlanModel(req.orgDb);
    const TherapySession = getTherapySession(req.orgDb);
    getDoctorModel(req.orgDb);

    const patient = await Patient.findById(patientId).lean();
    if (!patient) {
      return res.status(404).json({ error: "Patient not found" });
    }

    let patientImage = patient.patient_image || "";
    if (patientImage) {
      try {
        patientImage = await generatepatientImageSasToken(patientImage);
      } catch (err) {
        patientImage = "";
      }
    }

    const organization = await Organization.findOne({
      tenant_id: req.user.tenant_id,
    }).lean();

    let orgLogo = organization?.organization_logo || "";
    if (orgLogo) {
      try {
        orgLogo = await generateImageSasTokenLogo(orgLogo);
      } catch (err) {
        orgLogo = "";
      }
    }

    const assessments = await PatientAssessment.find({ patient_id: patientId })
      .populate("doctor_id", "doctor_first_name doctor_last_name")
      .sort({ date_taken: -1 })
      .lean();

    const printReadyAssessments = assessments.map((assessment) => {
      const snapshotQuestions = Array.isArray(
        assessment.template_snapshot?.questions,
      )
        ? assessment.template_snapshot.questions
        : [];

      const snapshotMap = {};
      for (const q of snapshotQuestions) {
        snapshotMap[q.id] = q;
      }

      const resolvedResponses = (assessment.responses || [])
        .filter((r) => r.question_type !== "section_header")
        .map((r) => {
          const snapQ = snapshotMap[r.question_id] || {};
          const type = r.question_type || snapQ.type || "";
          const base = {
            question_id: r.question_id,
            question: r.question_title || snapQ.title || "",
            type,
          };

          // --- ADDED: Nested MCQ Formatter ---
          if (type === "nested_mcq") {
            const rawAnswer =
              r.answer && typeof r.answer === "object" ? r.answer : {};
            const parent = rawAnswer.selectedParent || "";
            const subs =
              Array.isArray(rawAnswer.subSelections) &&
              rawAnswer.subSelections.length > 0
                ? rawAnswer.subSelections.join(", ")
                : "";

            let displayAnswer = parent;
            if (parent && subs) {
              displayAnswer = `${parent} - ${subs}`;
            }

            return {
              ...base,
              answer: displayAnswer || null,
              answer_raw: rawAnswer,
            };
          }
          // -----------------------------------

          if (type === "radio" || type === "dropdown") {
            const options = snapQ.options || [];
            const matched = options.find((o) => o.id === r.answer);
            return {
              ...base,
              answer: matched ? matched.value : (r.answer ?? null),
              answer_raw: r.answer ?? null,
            };
          }

          if (type === "checkbox") {
            const options = snapQ.options || [];
            const selectedIds = Array.isArray(r.answer) ? r.answer : [];
            const selectedLabels = selectedIds.map((id) => {
              const opt = options.find((o) => o.id === id);
              return opt ? opt.value : id;
            });
            return {
              ...base,
              answer: selectedLabels,
              answer_raw: selectedIds,
            };
          }

          if (type === "table") {
            const columns = snapQ.columns || [];
            const rows = snapQ.rows || [];
            const rawAnswer =
              r.answer && typeof r.answer === "object" ? r.answer : {};

            const resolvedRows = rows.map((rowDef) => {
              const rowAnswer = rawAnswer[rowDef.id] || {};
              const cells = columns.map((colDef) => ({
                col_id: colDef.id,
                col_label: colDef.value || "",
                col_type: colDef.colType || "text",
                value: rowAnswer[colDef.id] ?? null,
                reference_value: rowDef.referenceValues
                  ? rowDef.referenceValues[colDef.id]
                  : null, // Appends the reference text dynamically
              }));
              return {
                row_id: rowDef.id,
                sr_no: rowDef.srNo || null,
                row_label: rowDef.label || "",
                cell_type: rowDef.cellType || "text",
                is_sub_row: rowDef.isSubRow || false,
                unit: rowDef.unit || null,
                cell_descriptions: rowDef.cellDescriptions || [],
                cells,
              };
            });

            return {
              ...base,
              columns: columns.map((c) => ({
                id: c.id,
                label: c.value || "",
                col_type: c.colType || "text",
              })),
              has_row_labels: snapQ.hasRowLabels !== false,
              show_total_score: snapQ.showTotalScore || false,
              print_side_by_side: snapQ.printSideBySide || false,
              hide_empty_dashes: snapQ.hideEmptyDashes || false, // <--- NEW
              large_table_print: snapQ.largeTablePrint || false, // <--- NEW
              answer: resolvedRows,
              answer_raw: rawAnswer,
            };
          }

          if (type === "inline_blanks") {
            const blankLines = snapQ.blankLines || [];
            const templateText = snapQ.templateText || "";
            const rawAnswer =
              r.answer && typeof r.answer === "object" ? r.answer : {};

            const resolvedBlanks = blankLines.map((blank) => ({
              blank_id: blank.id,
              blank_label: blank.text || "",
              value: rawAnswer[blank.id] ?? null,
            }));

            return {
              ...base,
              template_text: templateText,
              blanks: resolvedBlanks,
              answer: rawAnswer,
            };
          }

          return {
            ...base,
            answer: r.answer ?? null,
          };
        });

      return {
        assessment_id: assessment._id,
        assessment_name: assessment.assessment_name,
        date_taken: assessment.date_taken,
        status: assessment.status,
        general_notes: assessment.general_notes || "",
        doctor: assessment.doctor_id
          ? `${assessment.doctor_id.doctor_first_name} ${assessment.doctor_id.doctor_last_name}`
          : "N/A",
        responses: resolvedResponses,
      };
    });

    const rawSessions = await TherapySession.find({ patient_id: patientId })
      .sort({ therepy_date: 1, therepy_start_time: 1 })
      .lean();

    const printReadySessions = rawSessions.map((session) => ({
      session_id: session._id,
      date: session.therepy_date || null,
      start_time: session.therepy_start_time || null,
      end_time: session.therepy_end_time || null,
      type: session.therepy_type || null,
      status: session.status || "Scheduled",
      doctor_name: session.doctor_name || "N/A",
      location_name: session.location_name || null,
      issue_dealt_with: session.issue_dealt_with || null,
      counselor_impression: session.counselor_impression || null,
      presession_remarks: session.presession_remarks || null,
      postsession_remarks: session.postsession_remarks || null,
      notes: session.notes || null,
      rehab_indicators: session.rehab_indicators || null,
      clinical_observations: session.clinical_observations || null,
    }));

    const therapyPlanIds = Array.isArray(patient.therapy_plans)
      ? patient.therapy_plans.filter((id) =>
          mongoose.Types.ObjectId.isValid(id),
        )
      : [];

    let printReadyPlans = [];
    let latestClosureDate = null; // Variable to store the overall discharge date

    if (therapyPlanIds.length > 0) {
      const plans = await TherapyPlan.find({
        _id: { $in: therapyPlanIds },
      }).lean();

      // Find the most recent closure date to act as the overall discharge date
      const closedPlans = plans.filter((p) => p.closure_date);
      if (closedPlans.length > 0) {
        closedPlans.sort(
          (a, b) => new Date(b.closure_date) - new Date(a.closure_date),
        );
        latestClosureDate = closedPlans[0].closure_date;
      }

      const Prescription = getPrescriptionModel(req.orgDb);

      printReadyPlans = await Promise.all(
        plans.map(async (plan) => {
          let prescription = null;
          let allPrescriptions = [];

          if (
            Array.isArray(plan.prescriptions) &&
            plan.prescriptions.length > 0
          ) {
            try {
              allPrescriptions = await Prescription.find({
                _id: { $in: plan.prescriptions },
              })
                .sort({ prescription_date: -1 })
                .lean();
            } catch (e) {
              console.warn(
                "Could not fetch prescription history for plan:",
                plan._id,
                e.message,
              );
            }
          }

          if (plan.prescription_id) {
            try {
              const rx = await Prescription.findById(
                plan.prescription_id,
              ).lean();
              if (rx) {
                prescription = {
                  prescription_number: rx.prescription_number,
                  prescription_date: rx.prescription_date,
                  doctor_name: rx.doctor_name,
                  diagnosis: rx.diagnosis || null,
                  notes: rx.notes || null,
                  vitals: rx.vitals || {},
                  medications: (rx.medications || []).map((med) => ({
                    drug_name: med.drug_name,
                    generic_name: med.generic_name || null,
                    drug_type: med.drug_type || null,
                    strength: med.strength || null,
                    route: med.route || null,
                    frequency: med.frequency,
                    duration: med.duration,
                    quantity: med.quantity || null,
                    instructions: med.instructions || null,
                    start_date: med.start_date || null,
                    end_date: med.end_date || null,
                  })),
                };

                if (
                  !allPrescriptions.some(
                    (p) => p._id.toString() === rx._id.toString(),
                  )
                ) {
                  allPrescriptions.unshift(rx);
                }
              }
            } catch (e) {
              console.warn(
                "Could not fetch prescription for plan:",
                plan._id,
                e.message,
              );
            }
          }

          const totalAmount = parseFloat(plan.total_amount || 0);
          const receivedAmount = parseFloat(plan.received_amount || 0);
          const balance = parseFloat(
            plan.balance || (totalAmount - receivedAmount).toFixed(2),
          );

          const isCompleted =
            plan.status === "Completed" || plan.status === "completed";
          let closure_summary = null;

          if (isCompleted) {
            let closed_by_name = plan.closed_by_name || "N/A";
            if (plan.closed_by) {
              try {
                const closedByDoc = await req.orgDb
                  .collection("doctors")
                  .findOne(
                    { _id: new mongoose.Types.ObjectId(plan.closed_by) },
                    {
                      projection: {
                        doctor_first_name: 1,
                        doctor_last_name: 1,
                      },
                    },
                  );
                if (closedByDoc?.doctor_first_name) {
                  closed_by_name =
                    `Dr. ${closedByDoc.doctor_first_name} ${closedByDoc.doctor_last_name}`.trim();
                }
              } catch (e) {
                console.warn("Could not fetch closed_by doctor:", e.message);
              }
            }

            const estimatedSessions = plan.estimated_sessions || 0;
            const completedSessions =
              plan.final_completed_sessions || plan.completed_sessions || 0;

            closure_summary = {
              closure_date: plan.closure_date || null,
              closure_reason: plan.closure_reason || null,
              closure_details: plan.closure_details || null,
              final_remarks: plan.final_remarks || null,
              treatment_outcome: plan.treatment_outcome || null,
              follow_up_recommendations: plan.follow_up_recommendations || null,
              next_visit_date: plan.next_visit_date || null,
              closed_by_name,
              goal_achievement: `${plan.goal_achievement || 0}%`,
              session_statistics: {
                estimated_sessions: estimatedSessions,
                completed_sessions: completedSessions,
                total_sessions_conducted:
                  plan.final_total_sessions || completedSessions,
                completion_rate:
                  estimatedSessions > 0
                    ? `${Math.round((completedSessions / estimatedSessions) * 100)}%`
                    : "N/A",
              },
              financial_summary: {
                original_amount:
                  plan.final_original_amount || plan.original_amount || null,
                discount_percentage:
                  plan.final_discount_percentage ||
                  plan.discount_percentage ||
                  0,
                discount_amount:
                  plan.final_discount_amount || plan.discount_amount || "0",
                final_amount: plan.final_total_amount || plan.total_amount,
                received_amount:
                  plan.final_received_amount || plan.received_amount,
                balance: plan.final_balance || plan.balance,
                addons_amount:
                  plan.final_addons_amount || plan.addons_amount || 0,
              },
            };
          }

          return {
            plan_id: plan._id,
            therapy_name: plan.therapy_name,
            status: plan.status,
            patient_therapy_category: plan.patient_therapy_category || null,
            therapy_start: plan.therapy_start,
            therapy_end: plan.therapy_end,
            admission_date: patient.patient_registration_date || null, // Map reg date
            discharge_date: plan.closure_date || null, // Map plan closure
            therapy_duration: plan.therapy_duration || null,
            patient_diagnosis: plan.patient_diagnosis || null,
            patient_symptoms: Array.isArray(plan.patient_symptoms)
              ? plan.patient_symptoms.join(", ")
              : plan.patient_symptoms || null,
            ICD_11_Codes: plan.ICD_11_Codes || null,
            MarksOfIdentification: plan.MarksOfIdentification || null,
            financial: {
              original_amount: plan.original_amount || null,
              total_amount: totalAmount,
              discount_percentage: plan.discount_percentage || 0,
              discount_amount: plan.discount_amount || "0",
              received_amount: receivedAmount,
              balance: balance,
              payment_type: plan.payment_type || null,
              per_session_amount: plan.per_session_amount || null,
              addons_amount: plan.addons_amount || 0,
              extra_addons: (plan.extra_addons || []).map((a) => ({
                name: a.name,
                amount: a.amount,
                description: a.description || null,
                status: a.status || null,
              })),
              payment_history: (plan.payment_history || []).map((p) => ({
                payment_number: p.payment_number,
                amount: p.amount,
                type: p.type,
                date: p.date,
                notes: p.notes || null,
              })),
            },
            estimated_sessions: plan.estimated_sessions || 0,
            completed_sessions: plan.completed_sessions || 0,
            remaining_sessions: plan.remaining_sessions || 0,
            presession_remarks: (plan.presession_remarks || []).map((r) => ({
              doctor_name: r.doctor_name,
              remark: r.presession_remark,
              timestamp: r.timestamp,
            })),
            postsession_remarks: (plan.postsession_remarks || []).map((r) => ({
              doctor_name: r.doctor_name,
              remark: r.postsession_remarks,
              timestamp: r.timestamp,
            })),
            notes: (plan.notes || []).map((n) => ({
              note: n.note,
              doctor_name: n.doctor_name,
              date: n.date,
            })),
            prescription,
            prescriptions: allPrescriptions,
            closure_summary,
          };
        }),
      );

      printReadyPlans.sort((a, b) => {
        if (a.status === "Active" && b.status !== "Active") return -1;
        if (a.status !== "Active" && b.status === "Active") return 1;
        return new Date(b.therapy_start) - new Date(a.therapy_start);
      });
    }

    return res.status(200).json({
      patient: {
        id: patient._id,
        name: `${patient.patient_first_name} ${patient.patient_last_name}`,
        UHID: patient.UHID || null,
        age: patient.patient_age || null,
        gender: patient.gender || null,
        phone: patient.patient_phone || null,
        email: patient.patient_email || null,
        address: patient.patient_address1 || null,
        guardian_phone: patient.guardian_phone || null,
        guardian_relation: patient.guardian_relation || null,
        guardian_phone_2: patient.guardian_phone_2 || null,
        guardian_relation_2: patient.guardian_relation_2 || null,
        treatment_days: patient.treatment_days || null,
        image: patientImage,
        admission_date: patient.patient_registration_date || null, // Sent directly in patient object
        discharge_date: patient.archived_at || null, // Latest closed plan date sent directly in patient object
      },
      organization: {
        name: organization?.organization_name || "Institute Name",
        address: organization?.organization_address || {},
        logo: orgLogo,
        phone: organization?.organization_phone || "",
        email: organization?.organization_email || "",
      },
      total_assessments: printReadyAssessments.length,
      assessments: printReadyAssessments,
      total_sessions: printReadySessions.length,
      sessions: printReadySessions,
      total_plans: printReadyPlans.length,
      therapy_plans: printReadyPlans,
    });
  } catch (error) {
    console.error("Error fetching patient data for print:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

const getTherapyPlanForPrint = async (req, res) => {
  try {
    const { planId } = req.params;

    // ── Validate ID ───────────────────────────────────────────────────────────
    if (!mongoose.Types.ObjectId.isValid(planId)) {
      return res.status(400).json({ error: "Invalid therapy plan ID format" });
    }

    // ── Register models on the tenant connection ──────────────────────────────
    const TherapyPlan = getTherapyPlanModel(req.orgDb);
    const TherapySession = getTherapySession(req.orgDb);
    const Patient = getPatientModel(req.orgDb);
    getDoctorModel(req.orgDb); // ensure Doctor model is registered for population

    // ── 1. Fetch therapy plan ─────────────────────────────────────────────────
    const plan = await TherapyPlan.findById(planId).lean();
    if (!plan) {
      return res.status(404).json({ error: "Therapy plan not found" });
    }

    // ── 2. Fetch patient ──────────────────────────────────────────────────────
    const patient = await Patient.findOne({
      therapy_plans: new mongoose.Types.ObjectId(planId),
    }).lean();

    if (!patient) {
      return res.status(404).json({ error: "Patient not found for this plan" });
    }

    // ── 3. Patient image SAS token ────────────────────────────────────────────
    let patientImage = patient.patient_image || "";
    if (patientImage) {
      try {
        patientImage = await generatepatientImageSasToken(patientImage);
      } catch (err) {
        console.warn(
          "Failed to generate SAS token for patient image:",
          err.message,
        );
        patientImage = "";
      }
    }

    // ── 4. Organization + logo SAS token ─────────────────────────────────────
    const organization = await Organization.findOne({
      tenant_id: req.user.tenant_id,
    }).lean();

    let orgLogo = organization?.organization_logo || "";
    if (orgLogo) {
      try {
        orgLogo = await generateImageSasTokenLogo(orgLogo);
      } catch (err) {
        console.warn("Failed to generate SAS token for org logo:", err.message);
        orgLogo = "";
      }
    }

    // ── 5. Hydrate full therapy sessions ─────────────────────────────────────
    let sessions = [];
    if (
      Array.isArray(plan.therapy_sessions) &&
      plan.therapy_sessions.length > 0
    ) {
      const sessionIds = plan.therapy_sessions.map((s) => s._id);
      const fullSessions = await TherapySession.find({
        _id: { $in: sessionIds },
      }).lean();

      sessions = fullSessions.map((session) => {
        const planRef = plan.therapy_sessions.find((s) =>
          s._id.equals(session._id),
        );
        return {
          session_id: session._id,
          session_number: planRef?.session_number || null,
          date: session.therepy_date || null,
          start_time: session.therepy_start_time || null,
          end_time: session.therepy_end_time || null,
          type: session.therepy_type || null,
          status: planRef?.status || session.status || "Scheduled",
          doctor_name: session.doctor_name || "N/A",
          location_name: session.location_name || null,
          issue_dealt_with: session.issue_dealt_with || null,
          counselor_impression: session.counselor_impression || null,
          presession_remarks: session.presession_remarks || null,
          postsession_remarks: session.postsession_remarks || null,
          notes: session.notes || null,
        };
      });

      // Sort ascending by session number for clean print order
      sessions.sort(
        (a, b) => (a.session_number || 0) - (b.session_number || 0),
      );
    }

    // ── 6. Resolve prescription (plan-linked or post-care) ───────────────────
    const prescriptionId =
      plan.post_care_prescription_id || plan.prescription_id || null;

    let prescription = null;
    if (prescriptionId) {
      try {
        const Prescription = getPrescriptionModel(req.orgDb);
        const rx = await Prescription.findById(prescriptionId).lean();
        if (rx) {
          prescription = {
            prescription_number: rx.prescription_number,
            prescription_date: rx.prescription_date,
            doctor_name: rx.doctor_name,
            diagnosis: rx.diagnosis || null,
            notes: rx.notes || null,
            vitals: rx.vitals || {},
            medications: (rx.medications || []).map((med) => {
              let extractedFrequency = med.frequency;
              let extractedDuration = med.duration;

              if (
                !extractedFrequency &&
                med.schedules &&
                med.schedules.length > 0
              ) {
                extractedFrequency = med.schedules[0].frequency;
                extractedDuration = med.schedules[0].duration;
              }

              return {
                drug_name: med.drug_name,
                generic_name: med.generic_name || null,
                drug_type: med.drug_type || null,
                strength: med.strength || null,
                route: med.route || null,
                frequency: extractedFrequency || "0",
                morning: med.morning ?? null,
                afternoon: med.afternoon ?? null,
                night: med.night ?? null,
                duration: extractedDuration || "",
                quantity: med.quantity || null,
                instructions: med.instructions || null,
                start_date: med.start_date || null,
                end_date: med.end_date || null,
                schedules: med.schedules || [],
              };
            }),
          };
        }
      } catch (e) {
        console.warn(
          "Could not fetch prescription for plan:",
          planId,
          e.message,
        );
      }
    }
    // ── 7. Resolve "closed by" doctor name ───────────────────────────────────
    let closed_by_name = plan.closed_by_name || "N/A";
    if (plan.closed_by) {
      try {
        const closedByDoc = await req.orgDb
          .collection("doctors")
          .findOne(
            { _id: new mongoose.Types.ObjectId(plan.closed_by) },
            { projection: { doctor_first_name: 1, doctor_last_name: 1 } },
          );
        if (closedByDoc?.doctor_first_name) {
          closed_by_name =
            `Dr. ${closedByDoc.doctor_first_name} ${closedByDoc.doctor_last_name}`.trim();
        }
      } catch (e) {
        console.warn("Could not fetch closed_by doctor:", e.message);
      }
    }

    // ── 8. Financial calculations ─────────────────────────────────────────────
    const totalAmount = parseFloat(plan.total_amount || 0);
    const receivedAmount = parseFloat(plan.received_amount || 0);
    const balance = parseFloat(
      plan.balance || (totalAmount - receivedAmount).toFixed(2),
    );

    // ── 9. Session statistics ─────────────────────────────────────────────────
    const estimatedSessions = plan.estimated_sessions || 0;
    const completedSessions =
      plan.final_completed_sessions || plan.completed_sessions || 0;
    const totalSessionsConducted = plan.final_total_sessions || sessions.length;

    // ── 10. Closure summary (if plan is completed) ────────────────────────────
    const isCompleted =
      plan.status === "Completed" || plan.status === "completed";

    const closure_summary = isCompleted
      ? {
          closure_date: plan.closure_date || null,
          closure_reason: plan.closure_reason || null,
          closure_details: plan.closure_details || null,
          final_remarks: plan.final_remarks || null,
          treatment_outcome: plan.treatment_outcome || null,
          follow_up_recommendations: plan.follow_up_recommendations || null,
          next_visit_date: patient.follow_Up_Date || null,
          closed_by_name,
          goal_achievement: `${plan.goal_achievement || 0}%`,
          session_statistics: {
            estimated_sessions: estimatedSessions,
            completed_sessions: completedSessions,
            total_sessions_conducted: totalSessionsConducted,
            completion_rate:
              estimatedSessions > 0
                ? `${Math.round(
                    (completedSessions / estimatedSessions) * 100,
                  )}%`
                : "N/A",
          },
          financial_summary: {
            original_amount:
              plan.final_original_amount || plan.original_amount || null,
            discount_percentage:
              plan.final_discount_percentage || plan.discount_percentage || 0,
            discount_amount:
              plan.final_discount_amount || plan.discount_amount || "0",
            final_amount: plan.final_total_amount || plan.total_amount,
            received_amount: plan.final_received_amount || plan.received_amount,
            balance: plan.final_balance || plan.balance,
            addons_amount: plan.final_addons_amount || plan.addons_amount || 0,
          },
        }
      : null;

    // ── 11. Care team (for doctor signatures section) ─────────────────────────
    const care_team = (patient.care_team || []).map((member) => ({
      doctor_id: member.doctor_id,
      doctor_name: member.doctor_name || "N/A",
      department_name: member.department_name || null,
      role: member.role || "Specialist",
    }));

    // ── 12. Build final response ──────────────────────────────────────────────
    return res.status(200).json({
      // ── Organization header ──────────────────────────────────────────────
      organization: {
        name: organization?.organization_name || "Institute Name",
        address: organization?.organization_address || {},
        logo: orgLogo,
        phone: organization?.organization_phone || "",
        email: organization?.organization_email || "",
        registration_number: organization?.registration_number || null,
        website: organization?.organization_website || null,
        organization_heads: (organization?.organization_heads || []).map(
          (head) => ({
            name: head.name || null,
            degree: head.degree || null,
            reg_no: head.reg_no || null,
          }),
        ),
        social_media: {
          instagram: organization?.organization_social_media?.instagram || null,
          facebook: organization?.organization_social_media?.facebook || null,
          youtube: organization?.organization_social_media?.youtube || null,
          twitter: organization?.organization_social_media?.twitter || null,
          linkedin: organization?.organization_social_media?.linkedin || null,
        },
      },

      // ── Patient band ─────────────────────────────────────────────────────
      patient: {
        id: patient._id,
        name: `${patient.patient_first_name} ${patient.patient_last_name}`,
        UHID: patient.UHID || null,
        age: patient.patient_age || null,
        gender: patient.gender || null,
        phone: patient.patient_phone || null,
        guardian_phone: patient.guardian_phone || null,
        email: patient.patient_email || null,
        address: patient.patient_address1 || null,
        date_of_birth: patient.date_of_birth || null,
        image: patientImage,
        marks_of_identification: plan.MarksOfIdentification || null,
        registration_date: patient.patient_registration_date || null, // <--- ADDED HERE
      },

      // ── Plan core ────────────────────────────────────────────────────────
      plan: {
        plan_id: plan._id,
        therapy_name: plan.therapy_name,
        status: plan.status,
        category: plan.patient_therapy_category || plan.therapy_name,
        admission_date: plan.therapy_start,
        discharge_date: patient.archived_at || null,
        therapy_duration: plan.therapy_duration || null,
        patient_diagnosis: plan.patient_diagnosis || null,
        patient_symptoms: Array.isArray(plan.patient_symptoms)
          ? plan.patient_symptoms.join(", ")
          : plan.patient_symptoms || null,
        ICD_11_Codes: plan.ICD_11_Codes || null,
        estimated_sessions: estimatedSessions,
        completed_sessions: completedSessions,
        remaining_sessions: plan.remaining_sessions || 0,
        total_sessions_conducted: totalSessionsConducted,
      },

      // ── Medication table (discharge card centre section) ──────────────────
      prescription,
      closure_summary,

      // ── Financial ────────────────────────────────────────────────────────
      financial: {
        original_amount: plan.original_amount || null,
        total_amount: totalAmount,
        discount_percentage: plan.discount_percentage || 0,
        discount_amount: plan.discount_amount || "0",
        received_amount: receivedAmount,
        balance,
        payment_type: plan.payment_type || null,
        per_session_amount: plan.per_session_amount || null,
        addons_amount: plan.addons_amount || 0,
        extra_addons: (plan.extra_addons || []).map((a) => ({
          name: a.name,
          amount: a.amount,
          description: a.description || null,
          status: a.status || null,
        })),
        payment_history: (plan.payment_history || []).map((p) => ({
          payment_number: p.payment_number,
          amount: p.amount,
          type: p.type,
          date: p.date,
          notes: p.notes || null,
        })),
      },

      // ── Session log ───────────────────────────────────────────────────────
      sessions,

      // ── Pre / post session remarks ────────────────────────────────────────
      presession_remarks: (plan.presession_remarks || []).map((r) => ({
        doctor_name: r.doctor_name,
        remark: r.presession_remark,
        timestamp: r.timestamp,
      })),
      postsession_remarks: (plan.postsession_remarks || []).map((r) => ({
        doctor_name: r.doctor_name,
        remark: r.postsession_remarks,
        timestamp: r.timestamp,
      })),
      notes: (plan.notes || []).map((n) => ({
        note: n.note,
        doctor_name: n.doctor_name,
        date: n.date,
      })),
      care_team,
      has_outstanding_balance: balance > 0,
      outstanding_balance: balance > 0 ? balance.toFixed(2) : null,
    });
  } catch (error) {
    console.error("Error fetching therapy plan for print:", error);

    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid therapy plan ID format" });
    }

    return res.status(500).json({ error: "Internal server error" });
  }
};

// 5. Delete an Assessment
const deleteAssessment = async (req, res) => {
  try {
    const { assessmentId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(assessmentId)) {
      return res.status(400).json({ error: "Invalid assessment ID format" });
    }

    const PatientAssessment = getPatientAssessmentModel(req.orgDb);

    const deletedAssessment =
      await PatientAssessment.findByIdAndDelete(assessmentId);

    if (!deletedAssessment) {
      return res.status(404).json({ error: "Assessment not found" });
    }

    return res.status(200).json({
      msg: "Assessment deleted successfully",
      deletedId: assessmentId,
    });
  } catch (error) {
    console.error("Error deleting assessment:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// 6. Get a single Assessment formatted for printing
// Helper function to convert integers to Roman Numerals
const convertToRoman = (num) => {
  if (!num || isNaN(num) || num <= 0) return null;
  const romanMap = {
    M: 1000,
    CM: 900,
    D: 500,
    CD: 400,
    C: 100,
    XC: 90,
    L: 50,
    XL: 40,
    X: 10,
    IX: 9,
    V: 5,
    IV: 4,
    I: 1,
  };
  let result = "";
  for (let key in romanMap) {
    while (num >= romanMap[key]) {
      result += key;
      num -= romanMap[key];
    }
  }
  return result;
};

// 6. Get a single Assessment formatted for printing
const getSingleAssessmentForPrint = async (req, res) => {
  try {
    const { assessmentId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(assessmentId)) {
      return res.status(400).json({ error: "Invalid assessment ID format" });
    }

    const PatientAssessment = getPatientAssessmentModel(req.orgDb);
    const Patient = getPatientModel(req.orgDb);
    getDoctorModel(req.orgDb);

    const assessment = await PatientAssessment.findById(assessmentId)
      .populate("doctor_id", "doctor_first_name doctor_last_name")
      .lean();

    if (!assessment) {
      return res.status(404).json({ error: "Assessment not found" });
    }

    const patient = await Patient.findById(assessment.patient_id).lean();
    if (!patient) {
      return res.status(404).json({ error: "Patient not found" });
    }

    let patientImage = patient.patient_image || "";
    if (patientImage) {
      try {
        patientImage = await generatepatientImageSasToken(patientImage);
      } catch (err) {
        patientImage = "";
      }
    }

    const organization = await Organization.findOne({
      tenant_id: req.user.tenant_id,
    }).lean();

    let orgLogo = organization?.organization_logo || "";
    if (orgLogo) {
      try {
        orgLogo = await generateImageSasTokenLogo(orgLogo);
      } catch (err) {
        orgLogo = "";
      }
    }

    const snapshotQuestions = Array.isArray(
      assessment.template_snapshot?.questions,
    )
      ? assessment.template_snapshot.questions
      : [];

    const snapshotMap = {};
    for (const q of snapshotQuestions) {
      snapshotMap[q.id] = q;
    }

    const resolvedResponses = (assessment.responses || [])
      .filter((r) => r.question_type !== "section_header")
      .map((r) => {
        const snapQ = snapshotMap[r.question_id] || {};
        const type = r.question_type || snapQ.type || "";
        const base = {
          question_id: r.question_id,
          question: r.question_title || snapQ.title || "",
          type,
        };

        // --- ADDED: Nested MCQ Formatter ---
        if (type === "nested_mcq") {
          const rawAnswer =
            r.answer && typeof r.answer === "object" ? r.answer : {};
          const parent = rawAnswer.selectedParent || "";
          const subs =
            Array.isArray(rawAnswer.subSelections) &&
            rawAnswer.subSelections.length > 0
              ? rawAnswer.subSelections.join(", ")
              : "";

          let displayAnswer = parent;
          if (parent && subs) {
            displayAnswer = `${parent} - ${subs}`;
          }

          return {
            ...base,
            answer: displayAnswer || null,
            answer_raw: rawAnswer,
          };
        }
        // -----------------------------------

        if (type === "radio" || type === "dropdown") {
          const options = snapQ.options || [];
          const matched = options.find((o) => o.id === r.answer);
          return {
            ...base,
            answer: matched ? matched.value : (r.answer ?? null),
            answer_raw: r.answer ?? null,
          };
        }

        if (type === "checkbox") {
          const options = snapQ.options || [];
          const selectedIds = Array.isArray(r.answer) ? r.answer : [];
          const selectedLabels = selectedIds.map((id) => {
            const opt = options.find((o) => o.id === id);
            return opt ? opt.value : id;
          });
          return {
            ...base,
            answer: selectedLabels,
            answer_raw: selectedIds,
          };
        }

        if (type === "table") {
          const columns = snapQ.columns || [];
          const rows = snapQ.rows || [];
          const rawAnswer =
            r.answer && typeof r.answer === "object" ? r.answer : {};

          const resolvedRows = rows.map((rowDef) => {
            const rowAnswer = rawAnswer[rowDef.id] || {};
            const cells = columns.map((colDef) => ({
              col_id: colDef.id,
              col_label: colDef.value || "",
              col_type: colDef.colType || "text",
              value: rowAnswer[colDef.id] ?? null,
              reference_value: rowDef.referenceValues
                ? rowDef.referenceValues[colDef.id]
                : null,
            }));
            return {
              row_id: rowDef.id,
              sr_no: rowDef.srNo || null,
              row_label:
                rowAnswer.__rowLabel !== undefined
                  ? rowAnswer.__rowLabel
                  : rowDef.label || "",
              cell_type: rowDef.cellType || "text",
              is_sub_row: rowDef.isSubRow || false,
              unit: rowDef.unit || null,
              cell_descriptions: rowDef.cellDescriptions || [],
              cells,
            };
          });

          return {
            ...base,
            columns: columns.map((c) => ({
              id: c.id,
              label: c.value || "",
              col_type: c.colType || "text",
            })),
            has_row_labels: snapQ.hasRowLabels !== false,
            show_total_score: snapQ.showTotalScore || false,
            print_side_by_side: snapQ.printSideBySide || false,
            hide_empty_dashes: snapQ.hideEmptyDashes || false, // <--- NEW
            large_table_print: snapQ.largeTablePrint || false, // <--- NEW
            answer: resolvedRows,
            answer_raw: rawAnswer,
          };
        }

        if (type === "inline_blanks") {
          const blankLines = snapQ.blankLines || [];
          const templateText = snapQ.templateText || "";
          const rawAnswer =
            r.answer && typeof r.answer === "object" ? r.answer : {};

          const resolvedBlanks = blankLines.map((blank) => ({
            blank_id: blank.id,
            blank_label: blank.text || "",
            value: rawAnswer[blank.id] ?? null,
          }));

          return {
            ...base,
            template_text: templateText,
            blanks: resolvedBlanks,
            answer: rawAnswer,
          };
        }

        return {
          ...base,
          answer: r.answer ?? null,
        };
      });

    return res.status(200).json({
      organization: {
        name: organization?.organization_name || "Institute Name",
        address: organization?.organization_address || {},
        logo: orgLogo,
        phone: organization?.organization_phone || "",
        email: organization?.organization_email || "",
        registration_number: organization?.registration_number || null,
        website: organization?.organization_website || null,
      },

      patient: {
        id: patient._id,
        name: `${patient.patient_first_name || ""} ${patient.patient_last_name || ""}`.trim(),
        UHID: patient.UHID || null,
        age: patient.patient_age || null,
        gender: patient.gender || null,
        phone: patient.patient_phone || null,
        guardian_phone: patient.guardian_phone || null,
        guardian_relation: patient.guardian_relation || null,
        guardian_phone_2: patient.guardian_phone_2 || null,
        guardian_relation_2: patient.guardian_relation_2 || null,
        email: patient.patient_email || null,
        address: patient.patient_address1 || null,
        date_of_birth: patient.date_of_birth || null,
        image: patientImage,
        treatment_days: patient.treatment_days
          ? convertToRoman(patient.treatment_days)
          : null,
      },

      assessment: {
        assessment_id: assessment._id,
        assessment_name: assessment.assessment_name,
        date_taken: assessment.date_taken,
        status: assessment.status,
        general_notes: assessment.general_notes || "",
        doctor: assessment.doctor_id
          ? `${assessment.doctor_id.doctor_first_name} ${assessment.doctor_id.doctor_last_name}`
          : "N/A",
        responses: resolvedResponses,
      },
    });
  } catch (error) {
    console.error("Error fetching assessment for print:", error);

    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid assessment ID format" });
    }

    return res.status(500).json({ error: "Internal server error" });
  }
};

const suggestionCache = new Map();
const EMPTY_SUGGESTION_RESULT = { suggestions: [], rewrite: "" };

// Domain grounding for this platform's assessments (substance-use / de-addiction
// clinical documentation — alcohol, tobacco, and other drug dependence). This is
// generalized vocabulary and phrasing style, not any specific patient's data, so
// it stays useful across every assessment instead of overfitting to one record.
// Extend this as new assessment templates introduce new recurring vocabulary.
const DOMAIN_KNOWLEDGE =
  "This platform is used by doctors documenting substance-use / de-addiction " +
  "assessments (most commonly alcohol, also tobacco and other drugs). Draw on this " +
  "vocabulary whenever the field context makes it relevant — don't force it into " +
  "unrelated fields:\n" +
  "- Alcohol/substance withdrawal symptoms: tremors (of hands), insomnia, disturbed " +
  "sleep, anorexia, nausea & vomiting, anxiety, sweating, hallucinations, delirium " +
  "tremens (DTs), withdrawal seizures. Withdrawal severity is usually classed as " +
  '"Uncomplicated" or "Complicated".\n' +
  "- Dependence criteria (ICD-11 style): craving, tolerance, loss of control, " +
  "withdrawal, harm, salience.\n" +
  "- Risk-assessment categories, usually rated Low / Moderate / High: Suicide Risk, " +
  "Violence Risk, Self-neglect, Withdrawal Seizure Risk, Delirium Tremens Risk.\n" +
  "- Standardized scales referenced by name/acronym: AUDIT, FTND, DAST, ASSIST, " +
  "CIWA-Ar, WHODAS 2.0.\n" +
  "- Common short diagnoses / ICD-11 codes: Alcohol Dependence (6C40), Alcohol " +
  "Withdrawal Uncomplicated (6C40.40), Nicotine Dependence (6C4A).\n" +
  "- Narrative fields (history of present illness, mental status exam, systemic " +
  "exam, family history, affected life areas) are written as short, complete " +
  'clinical sentences — e.g. "The client reported ...", "No significant ... was ' +
  'reported/noted", "The client denied ..." — not sentence fragments.\n' +
  "- Vitals / short measurement table fields (Pulse, BP, RR, Temp, SpO2, RBSL, " +
  "Weight, and similar) are typically just the bare value with no extra words " +
  '(e.g. "98", "110/80", "No").\n';

const suggestNotesCompletion = async (req, res) => {
  try {
    const { text, context } = req.body;

    if (!text || typeof text !== "string" || text.trim().length < 4) {
      return res.status(200).json(EMPTY_SUGGESTION_RESULT);
    }

    const safeContext =
      typeof context === "string" ? context.trim().slice(0, 300) : "";

    // Key the cache on context + text: the same partial text ("no ") means
    // something different in a "Pain Location" field than in a "Sleep
    // Quality" field, so they shouldn't share a cached completion.
    const cacheKey = safeContext ? `${safeContext}::${text}` : text;

    if (suggestionCache.has(cacheKey)) {
      return res.status(200).json(suggestionCache.get(cacheKey));
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error(
        "[suggestNotesCompletion] GEMINI_API_KEY is missing — set it in your backend .env and restart the server.",
      );
      return res.status(200).json(EMPTY_SUGGESTION_RESULT);
    }

    const prompt =
      "You are a clinical notes writing assistant helping a doctor fill in a field on a structured " +
      "patient assessment form.\n" +
      DOMAIN_KNOWLEDGE +
      (safeContext
        ? "Field context (what this field is for — use it to judge what kind of continuation makes " +
          "sense here, e.g. a short table value vs. a fuller sentence, and whether the domain " +
          "vocabulary above applies): " +
          JSON.stringify(safeContext) +
          "\n"
        : "") +
      "Given the partial text below, do two things:\n" +
      "1. Predict 3 distinct, natural ways the CURRENT sentence might continue, appropriate for the field " +
      "context and, where relevant, grounded in the domain vocabulary above rather than generic phrasing. " +
      "Each string must be ONLY the continuation (the part that comes AFTER what's already written), 2-8 " +
      "words, no leading space.\n" +
      "2. Rewrite the ENTIRE partial text with correct grammar, spelling, and punctuation. Preserve the " +
      "original clinical meaning, tone, and level of detail exactly — do not add, remove, or infer any " +
      "clinical information. If the text is already correct, return it unchanged.\n" +
      "Partial text: " +
      JSON.stringify(text);

    let geminiRes;
    try {
      geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              maxOutputTokens: 500,
              temperature: 0.7,
              responseMimeType: "application/json",
              responseSchema: {
                type: "OBJECT",
                properties: {
                  continuations: {
                    type: "ARRAY",
                    items: { type: "STRING" },
                  },
                  rewrite: {
                    type: "STRING",
                  },
                },
                required: ["continuations", "rewrite"],
              },
              thinkingConfig: {
                thinkingBudget: 0,
              },
            },
          }),
        },
      );
    } catch (networkErr) {
      console.error(
        "[suggestNotesCompletion] Network error calling Gemini:",
        networkErr,
      );
      return res.status(200).json(EMPTY_SUGGESTION_RESULT);
    }

    if (!geminiRes.ok) {
      const errBody = await geminiRes.text().catch(() => "<unreadable body>");
      console.error(
        `[suggestNotesCompletion] Gemini API returned ${geminiRes.status} ${geminiRes.statusText}:`,
        errBody,
      );
      return res.status(200).json(EMPTY_SUGGESTION_RESULT);
    }

    const data = await geminiRes.json();
    const finishReason = data?.candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== "STOP") {
      console.error(
        `[suggestNotesCompletion] Gemini finishReason was "${finishReason}" (expected "STOP"). Full candidate:`,
        JSON.stringify(data?.candidates?.[0]),
      );
    }

    const rawContent = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

    let suggestions = [];
    let rewrite = "";
    try {
      const parsed = JSON.parse(rawContent);
      if (Array.isArray(parsed?.continuations)) {
        suggestions = parsed.continuations;
      } else {
        console.error(
          "[suggestNotesCompletion] Gemini response missing continuations array:",
          rawContent,
        );
      }
      if (typeof parsed?.rewrite === "string") {
        rewrite = parsed.rewrite;
      } else {
        console.error(
          "[suggestNotesCompletion] Gemini response missing rewrite string:",
          rawContent,
        );
      }
    } catch (e) {
      console.error(
        "[suggestNotesCompletion] Failed to parse Gemini JSON. Raw content was:",
        rawContent,
        "Error:",
        e,
      );
    }

    const result = { suggestions, rewrite };
    suggestionCache.set(cacheKey, result);
    if (suggestionCache.size > 500) {
      suggestionCache.delete(suggestionCache.keys().next().value);
    }

    return res.status(200).json(result);
  } catch (error) {
    console.error("[suggestNotesCompletion] Unexpected error:", error);
    return res.status(200).json(EMPTY_SUGGESTION_RESULT);
  }
};

const getFollowupForPrint = async (req, res) => {
  try {
    const { sessionId } = req.params;

    // ── 1. Validate ID ──────────────────────────────────────────────────────────
    if (!mongoose.Types.ObjectId.isValid(sessionId)) {
      return res
        .status(400)
        .json({ error: "Invalid follow-up session ID format" });
    }

    // ── 2. Register models on the tenant connection ─────────────────────────────
    const TherapySession = getTherapySession(req.orgDb);
    const TherapyPlan = getTherapyPlanModel(req.orgDb);
    const Patient = getPatientModel(req.orgDb);
    const Prescription = getPrescriptionModel(req.orgDb);
    getDoctorModel(req.orgDb);

    // ── 3. Fetch the specific follow-up session ─────────────────────────────────
    const session = await TherapySession.findById(sessionId).lean();
    if (!session) {
      return res.status(404).json({ error: "Follow-up session not found" });
    }

    // ── 4. Fetch the linked patient ─────────────────────────────────────────────
    const patient = await Patient.findById(session.patient_id).lean();
    if (!patient) {
      return res
        .status(404)
        .json({ error: "Patient not found for this follow-up session" });
    }

    // ── 5. Compute the 1-based sequence number for this specific follow-up ───────
    const chronologicalFollowups = await TherapySession.find({
      patient_id: session.patient_id,
      therepy_type: "Follow-up",
    })
      .sort({ therepy_date: 1, createdAt: 1 })
      .select("_id")
      .lean();

    const followupIndex = chronologicalFollowups.findIndex(
      (s) => s._id.toString() === session._id.toString(),
    );
    const followupNumber = followupIndex !== -1 ? followupIndex + 1 : 1;

    // ── 6. Fetch patient image SAS token ────────────────────────────────────────
    let patientImage = patient.patient_image || "";
    if (patientImage) {
      try {
        patientImage = await generatepatientImageSasToken(patientImage);
      } catch (err) {
        console.warn(
          "Failed to generate SAS token for patient image:",
          err.message,
        );
        patientImage = "";
      }
    }

    // ── 7. Fetch organization + logo SAS token ──────────────────────────────────
    const organization = await Organization.findOne({
      tenant_id: req.user.tenant_id,
    }).lean();

    let orgLogo = organization?.organization_logo || "";
    if (orgLogo) {
      try {
        orgLogo = await generateImageSasTokenLogo(orgLogo);
      } catch (err) {
        console.warn("Failed to generate SAS token for org logo:", err.message);
        orgLogo = "";
      }
    }

    // ── 8. Resolve therapy plan decoupled via patient document ──────────────────
    let therapyPlan = null;
    const therapyPlanIds = Array.isArray(patient.therapy_plans)
      ? patient.therapy_plans.filter((id) =>
          mongoose.Types.ObjectId.isValid(id),
        )
      : [];

    if (therapyPlanIds.length > 0) {
      const plans = await TherapyPlan.find({
        _id: { $in: therapyPlanIds },
      }).lean();

      therapyPlan =
        plans.find((p) => p.status === "Active") ||
        plans.sort(
          (a, b) =>
            new Date(b.therapy_start || b.createdAt || 0) -
            new Date(a.therapy_start || a.createdAt || 0),
        )[0] ||
        null;
    }

    // ── 9. Resolve session prescription details ─────────────────────────────────
    let prescription = null;
    const prescriptionId = session.prescription_id || null;

    if (prescriptionId && mongoose.Types.ObjectId.isValid(prescriptionId)) {
      try {
        const rx = await Prescription.findById(prescriptionId).lean();
        if (rx) {
          prescription = {
            prescription_id: rx._id,
            prescription_number: rx.prescription_number || null,
            prescription_date: rx.prescription_date || null,
            doctor_name: rx.doctor_name || "N/A",
            diagnosis: rx.diagnosis || null,
            notes: rx.notes || null,
            vitals: rx.vitals || {},
            medications: (rx.medications || []).map((med) => {
              let extractedFrequency = med.frequency;
              let extractedDuration = med.duration;

              if (
                !extractedFrequency &&
                med.schedules &&
                med.schedules.length > 0
              ) {
                extractedFrequency = med.schedules[0].frequency;
                extractedDuration = med.schedules[0].duration;
              }

              return {
                drug_name: med.drug_name,
                generic_name: med.generic_name || null,
                drug_type: med.drug_type || null,
                strength: med.strength || null,
                route: med.route || null,
                frequency: extractedFrequency || "0",
                morning: med.morning ?? null,
                afternoon: med.afternoon ?? null,
                night: med.night ?? null,
                duration: extractedDuration || "",
                quantity: med.quantity || null,
                instructions: med.instructions || null,
                start_date: med.start_date || null,
                end_date: med.end_date || null,
                schedules: med.schedules || [],
              };
            }),
          };
        }
      } catch (rxErr) {
        console.warn(
          "Could not fetch prescription for follow-up session:",
          sessionId,
          rxErr.message,
        );
      }
    }

    // ── 10. Format therapy plan data & closure summary ───────────────────────────
    let planData = null;
    let closure_summary = null;

    if (therapyPlan) {
      const totalAmount = parseFloat(therapyPlan.total_amount || 0);
      const receivedAmount = parseFloat(therapyPlan.received_amount || 0);
      const balance = parseFloat(
        therapyPlan.balance || (totalAmount - receivedAmount).toFixed(2),
      );

      let closed_by_name = therapyPlan.closed_by_name || "N/A";
      if (therapyPlan.closed_by) {
        try {
          const closedByDoc = await req.orgDb
            .collection("doctors")
            .findOne(
              { _id: new mongoose.Types.ObjectId(therapyPlan.closed_by) },
              { projection: { doctor_first_name: 1, doctor_last_name: 1 } },
            );
          if (closedByDoc?.doctor_first_name) {
            closed_by_name =
              `Dr. ${closedByDoc.doctor_first_name} ${closedByDoc.doctor_last_name}`.trim();
          }
        } catch (e) {
          console.warn("Could not fetch closed_by doctor:", e.message);
        }
      }

      closure_summary = {
        closure_date: therapyPlan.closure_date || null,
        closure_reason:
          therapyPlan.closure_reason ||
          therapyPlan.patient_therapy_category ||
          therapyPlan.therapy_name ||
          null,
        closure_details: therapyPlan.closure_details || null,
        final_remarks: therapyPlan.final_remarks || null,
        treatment_outcome: therapyPlan.treatment_outcome || null,
        follow_up_recommendations:
          therapyPlan.follow_up_recommendations || null,
        next_visit_date: patient.follow_Up_Date || null,
        closed_by_name,
      };

      planData = {
        plan_id: therapyPlan._id,
        therapy_name: therapyPlan.therapy_name,
        status: therapyPlan.status,
        category:
          therapyPlan.patient_therapy_category || therapyPlan.therapy_name,
        therapy_start: therapyPlan.therapy_start,
        therapy_end: therapyPlan.therapy_end,
        discharge_date: therapyPlan.closure_date || patient.archived_at || null,
        therapy_duration: therapyPlan.therapy_duration || null,
        patient_diagnosis: therapyPlan.patient_diagnosis || null,
        patient_symptoms: Array.isArray(therapyPlan.patient_symptoms)
          ? therapyPlan.patient_symptoms.join(", ")
          : therapyPlan.patient_symptoms || null,
        ICD_11_Codes: therapyPlan.ICD_11_Codes || null,
        estimated_sessions: therapyPlan.estimated_sessions || 0,
        completed_sessions: therapyPlan.completed_sessions || 0,
        remaining_sessions: therapyPlan.remaining_sessions || 0,
        financial: {
          original_amount: therapyPlan.original_amount || null,
          total_amount: totalAmount,
          discount_percentage: therapyPlan.discount_percentage || 0,
          discount_amount: therapyPlan.discount_amount || "0",
          received_amount: receivedAmount,
          balance,
          payment_type: therapyPlan.payment_type || null,
        },
      };
    }

    // ── 11. Care team mapping ───────────────────────────────────────────────────
    const care_team = (patient.care_team || []).map((member) => ({
      doctor_id: member.doctor_id,
      doctor_name: member.doctor_name || "N/A",
      department_name: member.department_name || null,
      role: member.role || "Specialist",
    }));

    // ── 12. Build and return unified response ───────────────────────────────────
    return res.status(200).json({
      organization: {
        name: organization?.organization_name || "Institute Name",
        address: organization?.organization_address || {},
        logo: orgLogo,
        phone: organization?.organization_phone || "",
        email: organization?.organization_email || "",
        registration_number: organization?.registration_number || null,
        website: organization?.organization_website || null,
        organization_heads: (organization?.organization_heads || []).map(
          (head) => ({
            name: head.name || null,
            degree: head.degree || null,
            reg_no: head.reg_no || null,
          }),
        ),
        social_media: {
          instagram: organization?.organization_social_media?.instagram || null,
          facebook: organization?.organization_social_media?.facebook || null,
          youtube: organization?.organization_social_media?.youtube || null,
          twitter: organization?.organization_social_media?.twitter || null,
          linkedin: organization?.organization_social_media?.linkedin || null,
        },
      },

      patient: {
        id: patient._id,
        name: `${patient.patient_first_name || ""} ${patient.patient_last_name || ""}`.trim(),
        UHID: patient.UHID || null,
        age: patient.patient_age || null,
        gender: patient.gender || null,
        phone: patient.patient_phone || null,
        guardian_phone: patient.guardian_phone || null,
        email: patient.patient_email || null,
        address: patient.patient_address1 || null,
        date_of_birth: patient.date_of_birth || null,
        image: patientImage,
        registration_date: patient.patient_registration_date || null,
        next_follow_up_date: patient.follow_Up_Date || null,
      },

      followup: {
        session_id: session._id,
        followup_number: followupNumber,
        date: session.therepy_date || null,
        start_time: session.therepy_start_time || null,
        end_time: session.therepy_end_time || null,
        status: session.status || "Completed",
        doctor_name: session.doctor_name || "N/A",
        location_name: session.location_name || null,
        location_address: session.location_address || null,
        issues_addressed: session.issues_addressed || null,
        recovery_status: session.recovery_status || null,
        other_communication: session.other_communication || null,
        recovery_domain_scores: session.recovery_domain_scores || {},
        total_recovery_score: session.total_recovery_score ?? null,
        counselor_impression: session.counselor_impression || null,
        patient_complaints: session.patient_complaints || null,
        rehab_indicators: session.rehab_indicators || {},
        clinical_observations: session.clinical_observations || {},
        postsession_remarks: session.postsession_remarks || null,
        presession_remarks: session.presession_remarks || null,
        notes: session.notes || null,
      },

      plan: planData,
      closure_summary,
      prescription,
      care_team,
    });
  } catch (error) {
    console.error("Error fetching follow-up session for print:", error);

    if (error.name === "CastError") {
      return res.status(400).json({ error: "Invalid ID format" });
    }

    return res.status(500).json({ error: "Internal server error" });
  }
};

// ── Helpers for OPD Register Excel Extraction ────────────────────────────────

const formatDateYYYYMMDD = (dateVal) => {
  if (!dateVal) return null;
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return typeof dateVal === "string" ? dateVal : null;
  return d.toISOString().split("T")[0];
};

/**
 * Resolves a checkbox question's selected option labels from a PatientAssessment
 */
const extractCheckboxLabels = (
  assessment,
  questionIds = [],
  titlePattern = null,
) => {
  if (!assessment || !Array.isArray(assessment.responses)) return [];

  const snapshotQuestions = Array.isArray(
    assessment.template_snapshot?.questions,
  )
    ? assessment.template_snapshot.questions
    : [];

  const response = assessment.responses.find((r) => {
    if (questionIds.includes(r.question_id)) return true;
    const snapQ = snapshotQuestions.find((q) => q.id === r.question_id);
    const title = r.question_title || snapQ?.title || "";
    return titlePattern ? titlePattern.test(title) : false;
  });

  if (!response) return [];

  const snapQ =
    snapshotQuestions.find((q) => q.id === response.question_id) || {};
  const options = Array.isArray(snapQ.options) ? snapQ.options : [];
  const rawSelected = Array.isArray(response.answer) ? response.answer : [];

  return rawSelected
    .map((val) => {
      const matchedOpt = options.find((o) => o.id === val || o.value === val);
      return (matchedOpt ? matchedOpt.value : String(val || "")).trim();
    })
    .filter(
      (label) => label && !/^(not\s*significant|none|nil|n\/a)$/i.test(label),
    );
};

/**
 * Resolves rows of a table question into an array of key-value maps
 * keyed by both column ID and normalized column label.
 */
const extractTableRows = (
  assessment,
  questionIds = [],
  titlePattern = null,
) => {
  if (!assessment || !Array.isArray(assessment.responses)) return [];

  const snapshotQuestions = Array.isArray(
    assessment.template_snapshot?.questions,
  )
    ? assessment.template_snapshot.questions
    : [];

  const response = assessment.responses.find((r) => {
    if (questionIds.includes(r.question_id)) return true;
    const snapQ = snapshotQuestions.find((q) => q.id === r.question_id);
    const title = r.question_title || snapQ?.title || "";
    return titlePattern ? titlePattern.test(title) : false;
  });

  if (!response || !response.answer || typeof response.answer !== "object") {
    return [];
  }

  const snapQ =
    snapshotQuestions.find((q) => q.id === response.question_id) || {};
  const columns = Array.isArray(snapQ.columns) ? snapQ.columns : [];
  const rows = Array.isArray(snapQ.rows) ? snapQ.rows : [];
  const rawAnswer = response.answer;

  // Map column ID -> column header text
  const colIdToLabel = {};
  for (const col of columns) {
    colIdToLabel[col.id] = (col.value || "").trim().toLowerCase();
  }

  const orderedRowIds =
    rows.length > 0 ? rows.map((r) => r.id) : Object.keys(rawAnswer);

  return orderedRowIds
    .map((rowId) => {
      const rowAns = rawAnswer[rowId];
      if (!rowAns || typeof rowAns !== "object") return null;

      const rowDef = rows.find((r) => r.id === rowId) || {};
      const parsedRow = {
        __rowId: rowId,
        __rowLabel:
          rowAns.__rowLabel !== undefined
            ? rowAns.__rowLabel
            : rowDef.label || "",
      };

      for (const [colId, cellVal] of Object.entries(rowAns)) {
        const cleanVal =
          cellVal !== null && cellVal !== undefined
            ? String(cellVal).trim()
            : "";
        parsedRow[colId] = cleanVal;
        if (colIdToLabel[colId]) {
          parsedRow[colIdToLabel[colId]] = cleanVal;
        }
      }
      return parsedRow;
    })
    .filter(Boolean);
};

// ── 8. Get Monthly OPD Register Data for Excel Export ────────────────────────
/**
 * Query Params (all optional):
 * - month: 1-12 or "YYYY-MM" (e.g. ?month=10&year=2026 or ?month=2026-10)
 * - year: YYYY (e.g. ?year=2026)
 * - startDate / endDate: Custom ISO date range
 */
const getMonthlyOpdRegisterForExcel = async (req, res) => {
  try {
    const { month, year, startDate, endDate } = req.query;

    const Patient = getPatientModel(req.orgDb);
    const PatientAssessment = getPatientAssessmentModel(req.orgDb);
    const TherapyPlan = getTherapyPlanModel(req.orgDb);
    const TherapySession = getTherapySession(req.orgDb);
    const Prescription = getPrescriptionModel(req.orgDb);
    getDoctorModel(req.orgDb);

    // ── 1. Build Date Filter on patient_registration_date ───────────────────
    const patientQuery = {};
    let dateFilter = null;

    if (startDate || endDate) {
      dateFilter = {};
      if (startDate) dateFilter.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        dateFilter.$lte = end;
      }
    } else if (month && /^\d{4}-\d{2}$/.test(String(month))) {
      const [y, m] = String(month).split("-").map(Number);
      dateFilter = {
        $gte: new Date(y, m - 1, 1, 0, 0, 0, 0),
        $lte: new Date(y, m, 0, 23, 59, 59, 999),
      };
    } else if (month && year) {
      const y = parseInt(year, 10);
      const m = parseInt(month, 10);
      if (isNaN(y) || isNaN(m) || m < 1 || m > 12) {
        return res
          .status(400)
          .json({ error: "Invalid month or year parameter." });
      }
      dateFilter = {
        $gte: new Date(y, m - 1, 1, 0, 0, 0, 0),
        $lte: new Date(y, m, 0, 23, 59, 59, 999),
      };
    } else if (year) {
      const y = parseInt(year, 10);
      if (isNaN(y)) {
        return res.status(400).json({ error: "Invalid year parameter." });
      }
      dateFilter = {
        $gte: new Date(y, 0, 1, 0, 0, 0, 0),
        $lte: new Date(y, 11, 31, 23, 59, 59, 999),
      };
    }

    if (dateFilter) {
      patientQuery.patient_registration_date = dateFilter;
    }

    // ── 2. Fetch Patients in chronological order ────────────────────────────
    const patients = await Patient.find(patientQuery)
      .populate("doctor_id", "doctor_first_name doctor_last_name")
      .sort({ patient_registration_date: 1 })
      .lean();

    if (patients.length === 0) {
      return res.status(200).json({
        total_records: 0,
        records: [],
        monthly_data: [],
      });
    }

    // ── Sort patients by UHID (OPD Reg No, then IPD No) ─────────────────────
    patients.sort(compareByUhid);

    const patientObjectIds = patients.map((p) => p._id);
    const patientIdStrings = patients.map((p) => p._id.toString());

    const allPlanIds = [];
    for (const p of patients) {
      if (Array.isArray(p.therapy_plans)) {
        for (const planId of p.therapy_plans) {
          if (mongoose.Types.ObjectId.isValid(planId)) {
            allPlanIds.push(new mongoose.Types.ObjectId(planId));
          }
        }
      }
    }

    // ── 3. Batch-fetch Assessments, Plans, Prescriptions, Follow-ups ────────
    const [assessments, plans, prescriptionsByPatient, followupSessions] =
      await Promise.all([
        PatientAssessment.find({ patient_id: { $in: patientObjectIds } })
          .sort({ date_taken: -1 })
          .lean(),
        allPlanIds.length > 0
          ? TherapyPlan.find({ _id: { $in: allPlanIds } }).lean()
          : Promise.resolve([]),
        Prescription.find({ patient_id: { $in: patientObjectIds } })
          .sort({ prescription_date: -1 })
          .lean(),
        TherapySession.find({
          patient_id: { $in: patientIdStrings },
          therepy_type: { $in: ["Follow-up", "Aftercare"] },
        })
          .sort({ therepy_date: -1 })
          .select("patient_id therepy_date")
          .lean(),
      ]);

    // Fetch any prescriptions directly linked on plans that weren't in prescriptionsByPatient
    const fetchedRxIds = new Set(
      prescriptionsByPatient.map((rx) => rx._id.toString()),
    );
    const missingPlanRxIds = [];

    for (const plan of plans) {
      const candidateRxIds = [
        plan.prescription_id,
        plan.post_care_prescription_id,
        ...(Array.isArray(plan.prescriptions) ? plan.prescriptions : []),
      ].filter((id) => id && mongoose.Types.ObjectId.isValid(id));

      for (const rxId of candidateRxIds) {
        if (!fetchedRxIds.has(rxId.toString())) {
          missingPlanRxIds.push(new mongoose.Types.ObjectId(rxId));
          fetchedRxIds.add(rxId.toString());
        }
      }
    }

    const extraPrescriptions =
      missingPlanRxIds.length > 0
        ? await Prescription.find({ _id: { $in: missingPlanRxIds } }).lean()
        : [];

    // ── 4. Index related data by Patient ID / Plan ID for O(1) lookup ───────
    const assessmentsByPatientMap = new Map();
    for (const a of assessments) {
      const key = a.patient_id.toString();
      if (!assessmentsByPatientMap.has(key)) {
        assessmentsByPatientMap.set(key, []);
      }
      assessmentsByPatientMap.get(key).push(a);
    }

    const planByIdMap = new Map();
    for (const plan of plans) {
      planByIdMap.set(plan._id.toString(), plan);
    }

    const rxByIdMap = new Map();
    const rxByPatientMap = new Map();
    for (const rx of [...prescriptionsByPatient, ...extraPrescriptions]) {
      rxByIdMap.set(rx._id.toString(), rx);
      if (rx.patient_id) {
        const pKey = rx.patient_id.toString();
        if (!rxByPatientMap.has(pKey)) {
          rxByPatientMap.set(pKey, []);
        }
        rxByPatientMap.get(pKey).push(rx);
      }
    }

    const followupByPatientMap = new Map();
    for (const sess of followupSessions) {
      const pKey = String(sess.patient_id);
      if (!followupByPatientMap.has(pKey) && sess.therepy_date) {
        followupByPatientMap.set(pKey, sess.therepy_date);
      }
    }

    // ── 5. Build OPD Register rows & group month-wise ───────────────────────
    const monthlyGroupsMap = new Map();

    for (const patient of patients) {
      const pIdStr = patient._id.toString();
      const regDateObj = patient.patient_registration_date
        ? new Date(patient.patient_registration_date)
        : new Date();

      const yearNum = regDateObj.getFullYear();
      const monthNum = regDateObj.getMonth() + 1;
      const monthKey = `${yearNum}-${String(monthNum).padStart(2, "0")}`;
      const monthLabel = regDateObj.toLocaleString("en-US", {
        month: "long",
        year: "numeric",
      });

      // Resolve patient's plans (prefer Active, otherwise latest by therapy_start)
      const patientPlans = (patient.therapy_plans || [])
        .map((id) => planByIdMap.get(id?.toString()))
        .filter(Boolean);

      const selectedPlan =
        patientPlans.find((p) => p.status === "Active") ||
        patientPlans.sort(
          (a, b) =>
            new Date(b.therapy_start || b.createdAt || 0) -
            new Date(a.therapy_start || a.createdAt || 0),
        )[0] ||
        null;

      // Resolve patient's assessments
      const patientAssessments = assessmentsByPatientMap.get(pIdStr) || [];

      const drugUseAssessment = patientAssessments.find((a) =>
        /drug\s*use\s*history/i.test(a.assessment_name || ""),
      );
      const clinicalAssessment = patientAssessments.find((a) =>
        /clinical\s*asses+ment/i.test(a.assessment_name || ""),
      );

      // ── A. Primary Substance & Duration of Use (Yrs) ──────────────────────
      let primarySubstance = null;
      let durationOfUse = null;

      // 1st priority: 'Drug Use History' -> Question 'qy0izwu' (Substance Use History)
      if (drugUseAssessment) {
        const drugRows = extractTableRows(
          drugUseAssessment,
          ["qy0izwu"],
          /substance\s*use\s*history/i,
        );
        const firstFilledRow = drugRows.find(
          (r) => r["6naifxr"] || r["types of drug"],
        );
        if (firstFilledRow) {
          primarySubstance =
            firstFilledRow["6naifxr"] ||
            firstFilledRow["types of drug"] ||
            null;
          durationOfUse =
            firstFilledRow["w9suwvx"] ||
            firstFilledRow["duration of use"] ||
            null;
        }
      }

      // 2nd priority: 'Clinical Assesment' -> Question '5la1boj' (History of present illness)
      if (!primarySubstance && clinicalAssessment) {
        const hpiRows = extractTableRows(
          clinicalAssessment,
          ["5la1boj"],
          /history\s*of\s*present\s*illness/i,
        );
        const firstFilledRow = hpiRows.find(
          (r) => r["xo9elnt"] || r["substance"],
        );
        if (firstFilledRow) {
          primarySubstance =
            firstFilledRow["xo9elnt"] || firstFilledRow["substance"] || null;
          durationOfUse =
            firstFilledRow["0hlm1xk"] ||
            firstFilledRow["duration of use"] ||
            null;
        }
      }

      // ── B. Co-morbidities (Medical/Psych) ─────────────────────────────────
      const comorbiditySet = new Set();

      if (clinicalAssessment) {
        // 1. Comorbidity checkbox ('d24j6l5')
        const comorbidities = extractCheckboxLabels(
          clinicalAssessment,
          ["d24j6l5"],
          /^comorbidity$/i,
        );
        // 2. Medical Complication checkbox ('67i4vdm')
        const medComplications = extractCheckboxLabels(
          clinicalAssessment,
          ["67i4vdm"],
          /medical\s*complication/i,
        );
        // 3. Psychiatric Problem checkbox ('jsd3qgc')
        const psychProblems = extractCheckboxLabels(
          clinicalAssessment,
          ["jsd3qgc"],
          /psychiatric\s*problem/i,
        );

        [...comorbidities, ...medComplications, ...psychProblems].forEach(
          (item) => comorbiditySet.add(item),
        );

        // Also check Psychiatric / Medical / Comorbidity rows in Clinical Assessment Diagnosis table ('35zehvd')
        const diagRows = extractTableRows(
          clinicalAssessment,
          ["35zehvd"],
          /^diagnosis$/i,
        );
        for (const r of diagRows) {
          if (
            ["lmnuql1", "xkowlwd", "b5izq3r"].includes(r.__rowId) ||
            /psychiatric|medical|comorbidity/i.test(r.__rowLabel || "")
          ) {
            const resp = r["tqrjog0"] || r["response"];
            if (resp && !/^(not\s*significant|none|nil|n\/a)$/i.test(resp)) {
              comorbiditySet.add(resp);
            }
          }
        }
      }

      if (comorbiditySet.size === 0 && Array.isArray(patient.medical_history)) {
        patient.medical_history
          .map((m) => String(m || "").trim())
          .filter((m) => m && !/^(not\s*significant|none|nil|n\/a)$/i.test(m))
          .forEach((m) => comorbiditySet.add(m));
      }

      const coMorbiditiesStr =
        comorbiditySet.size > 0
          ? Array.from(comorbiditySet).join(", ")
          : "None";

      // ── C. Diagnosis (ICD Code) — Primarily ICD_11_Codes from Plan ────────
      let diagnosisIcd = selectedPlan?.ICD_11_Codes?.trim() || null;

      // Fallback to Diagnosis table in Clinical Assessment ('35zehvd') or Drug Use History ('juyghk0')
      if (!diagnosisIcd) {
        const diagRows = [
          ...extractTableRows(clinicalAssessment, ["35zehvd"], /^diagnosis$/i),
          ...extractTableRows(drugUseAssessment, ["juyghk0"], /^diagnosis$/i),
        ];
        const primaryDiagRow = diagRows.find(
          (r) =>
            r.__rowId === "r6w4n77" ||
            r.__rowId === "ulnkbna" ||
            /primary\s*diagnosis/i.test(r.__rowLabel || "") ||
            r["vp7ugse"] ||
            r["spyddr1"],
        );
        if (primaryDiagRow) {
          const code =
            primaryDiagRow["vp7ugse"] ||
            primaryDiagRow["spyddr1"] ||
            primaryDiagRow["icd-11 codes"] ||
            primaryDiagRow["icd11 codes"] ||
            "";
          const desc =
            primaryDiagRow["tqrjog0"] ||
            primaryDiagRow["xm9sia2"] ||
            primaryDiagRow["response"] ||
            "";
          diagnosisIcd =
            code && desc ? `${code} (${desc})` : code || desc || null;
        }
      }

      if (!diagnosisIcd && selectedPlan?.patient_diagnosis) {
        diagnosisIcd = selectedPlan.patient_diagnosis;
      }

      // ── D. Treatment Plan — Top 2 Medications from Prescription ───────────
      let selectedRx = null;
      if (selectedPlan) {
        const planRxId =
          selectedPlan.prescription_id ||
          selectedPlan.post_care_prescription_id ||
          (Array.isArray(selectedPlan.prescriptions) &&
          selectedPlan.prescriptions.length > 0
            ? selectedPlan.prescriptions[selectedPlan.prescriptions.length - 1]
            : null);

        if (planRxId) {
          selectedRx = rxByIdMap.get(planRxId.toString()) || null;
        }
      }

      if (!selectedRx) {
        const patientRxs = rxByPatientMap.get(pIdStr) || [];
        selectedRx = patientRxs[0] || null;
      }

      let top2Medications = [];
      if (selectedRx && Array.isArray(selectedRx.medications)) {
        top2Medications = selectedRx.medications
          .slice(0, 2)
          .map((med) => {
            const name = (med.drug_name || "").trim();
            const strength = (med.strength || "").trim();
            return strength &&
              !name.toLowerCase().includes(strength.toLowerCase())
              ? `${name} ${strength}`
              : name;
          })
          .filter(Boolean);
      } else if (
        Array.isArray(patient.medications) &&
        patient.medications.length > 0
      ) {
        top2Medications = patient.medications
          .slice(0, 2)
          .map((m) => String(m || "").trim())
          .filter(Boolean);
      }

      const treatmentPlanStr =
        top2Medications.length > 0
          ? top2Medications.join(" + ")
          : selectedPlan?.therapy_name || "N/A";

      // ── E. Assigned Counselor ─────────────────────────────────────────────
      let assignedCounselor = null;
      if (Array.isArray(patient.care_team) && patient.care_team.length > 0) {
        const counselorMember =
          patient.care_team.find((m) => m.role === "Head Counselor") ||
          patient.care_team.find((m) =>
            /counsel|psych|rehab|therap/i.test(m.department_name || ""),
          ) ||
          patient.care_team[0];

        assignedCounselor = counselorMember?.doctor_name || null;
      }

      if (!assignedCounselor) {
        assignedCounselor =
          patient.doctor_name ||
          (patient.doctor_id?.doctor_first_name
            ? `${patient.doctor_id.doctor_first_name} ${patient.doctor_id.doctor_last_name || ""}`.trim()
            : "N/A");
      }

      // ── F. Address & Follow-up Date ───────────────────────────────────────
      const addressParts = [
        patient.patient_address1,
        patient.patient_address2,
        patient.address?.street,
        patient.address?.city,
        patient.address?.state,
      ]
        .map((part) => (part ? String(part).trim() : ""))
        .filter(Boolean);

      const fullAddress =
        addressParts.length > 0 ? [...new Set(addressParts)].join(", ") : "N/A";

      const followUpDate = formatDateYYYYMMDD(
        patient.follow_Up_Date ||
          selectedPlan?.next_visit_date ||
          followupByPatientMap.get(pIdStr) ||
          null,
      );

      const fullName = [
        patient.patient_first_name,
        patient.patient_middle_name,
        patient.patient_last_name,
      ]
        .filter(Boolean)
        .join(" ")
        .trim();

      // ── G. Push into Month Bucket ─────────────────────────────────────────
      if (!monthlyGroupsMap.has(monthKey)) {
        monthlyGroupsMap.set(monthKey, {
          month_key: monthKey,
          month_label: monthLabel,
          year: yearNum,
          month: monthNum,
          records: [],
        });
      }

      const monthGroup = monthlyGroupsMap.get(monthKey);
      const sNo = monthGroup.records.length + 1;

      monthGroup.records.push({
        // Clean keys for UI table rendering
        s_no: sNo,
        patient_id: patient._id,
        date: formatDateYYYYMMDD(patient.patient_registration_date),
        reg_no: patient.UHID || "N/A",
        patient_name: fullName || "N/A",
        age: patient.patient_age || "N/A",
        gender: patient.gender || "N/A",
        contact_number:
          patient.patient_phone || patient.guardian_phone || "N/A",
        address: fullAddress,
        primary_substance: primarySubstance || "N/A",
        duration_of_use: durationOfUse || "N/A",
        co_morbidities: coMorbiditiesStr,
        diagnosis: diagnosisIcd || "N/A",
        treatment_plan: treatmentPlanStr,
        assigned_counselor: assignedCounselor || "N/A",
        follow_up_date: followUpDate || "N/A",

        // Exact Excel Header row mapping for direct SheetJS (xlsx) export
        excel_row: {
          "S.No": sNo,
          Date: formatDateYYYYMMDD(patient.patient_registration_date) || "",
          "Reg No / Case No": patient.UHID || "",
          "Patient Name": fullName || "",
          Age: patient.patient_age || "",
          Gender: patient.gender || "",
          "Contact Number":
            patient.patient_phone || patient.guardian_phone || "",
          Address: fullAddress === "N/A" ? "" : fullAddress,
          "Primary Substance": primarySubstance || "",
          "Duration of Use (Yrs)": durationOfUse || "",
          "Co-morbidities (Medical/Psych)": coMorbiditiesStr,
          "Diagnosis (ICD Code)": diagnosisIcd || "",
          "Treatment Plan": treatmentPlanStr === "N/A" ? "" : treatmentPlanStr,
          "Assigned Counselor":
            assignedCounselor === "N/A" ? "" : assignedCounselor,
          "Follow-up Date": followUpDate || "",
        },
      });
    }

    const monthlyData = Array.from(monthlyGroupsMap.values())
      .sort((a, b) => a.month_key.localeCompare(b.month_key))
      .map((group) => ({
        ...group,
        total_records: group.records.length,
      }));

    const allRecords = monthlyData.flatMap((group) => group.records);

    return res.status(200).json({
      total_records: allRecords.length,
      records: allRecords,
      monthly_data: monthlyData,
    });
  } catch (error) {
    console.error("Error generating monthly OPD register data:", error);
    return res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  }
};

// ── Helper: Split UHID ("7552/0992") into OPD Reg No ("7552") & IPD No ("0992") ──
const parseUhidAndIpd = (rawUhid, fallbackId = null) => {
  if (!rawUhid || typeof rawUhid !== "string") {
    return {
      opdRegNo: fallbackId ? String(fallbackId).trim() : "N/A",
      ipdNo: "N/A",
    };
  }

  const trimmed = rawUhid.trim();
  if (trimmed.includes("/")) {
    const [beforeSlash, ...afterSlashParts] = trimmed.split("/");
    const opdPart = beforeSlash.trim();
    const ipdPart = afterSlashParts.join("/").trim();

    return {
      opdRegNo: opdPart || (fallbackId ? String(fallbackId).trim() : "N/A"),
      ipdNo: ipdPart || "N/A",
    };
  }

  return {
    opdRegNo: trimmed,
    ipdNo: "N/A",
  };
};

// ── Helper: Comparator to sort patients by UHID ("7552/0992") ─────────────────
// Sorts by OPD Reg No first, then IPD No, using natural/numeric ordering so
// "2" < "10" < "100". Patients without a UHID are pushed to the end, and
// ties fall back to registration date for a stable, predictable order.
const compareByUhid = (a, b) => {
  const hasA = typeof a.UHID === "string" && a.UHID.trim() !== "";
  const hasB = typeof b.UHID === "string" && b.UHID.trim() !== "";
  if (hasA !== hasB) return hasA ? -1 : 1;

  if (hasA && hasB) {
    const pa = parseUhidAndIpd(a.UHID);
    const pb = parseUhidAndIpd(b.UHID);
    const natural = (x, y) =>
      String(x).localeCompare(String(y), undefined, {
        numeric: true,
        sensitivity: "base",
      });

    const opdCmp = natural(pa.opdRegNo, pb.opdRegNo);
    if (opdCmp !== 0) return opdCmp;

    // "N/A" (no IPD No) should come before real IPD numbers
    if (pa.ipdNo !== pb.ipdNo) {
      if (pa.ipdNo === "N/A") return -1;
      if (pb.ipdNo === "N/A") return 1;
      const ipdCmp = natural(pa.ipdNo, pb.ipdNo);
      if (ipdCmp !== 0) return ipdCmp;
    }
  }

  return (
    new Date(a.patient_registration_date || 0) -
    new Date(b.patient_registration_date || 0)
  );
};

const formatTimeIST = (dateVal) => {
  if (!dateVal) return null;
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return null;
  // Ignore midnight-only dates (e.g. 2026-09-27T00:00:00.000Z)
  if (
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0
  ) {
    return null;
  }
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
};
/**
 * Resolves a radio, dropdown, or nested_mcq question's answer
 * (e.g. 'History of withdrawls' - question 'tganror') from a PatientAssessment.
 */
const extractSingleOrNestedAnswer = (
  assessment,
  questionIds = [],
  titlePattern = null,
) => {
  if (!assessment || !Array.isArray(assessment.responses)) return null;

  const snapshotQuestions = Array.isArray(
    assessment.template_snapshot?.questions,
  )
    ? assessment.template_snapshot.questions
    : [];

  const response = assessment.responses.find((r) => {
    if (questionIds.includes(r.question_id)) return true;
    const snapQ = snapshotQuestions.find((q) => q.id === r.question_id);
    const title = r.question_title || snapQ?.title || "";
    return titlePattern ? titlePattern.test(title) : false;
  });

  if (!response || response.answer === null || response.answer === undefined) {
    return null;
  }

  const snapQ =
    snapshotQuestions.find((q) => q.id === response.question_id) || {};
  const options = Array.isArray(snapQ.options) ? snapQ.options : [];
  const type = response.question_type || snapQ.type || "";

  // 1. Handle nested_mcq or object-shaped radio answers: { selectedParent, subSelections }
  if (
    type === "nested_mcq" ||
    (typeof response.answer === "object" && !Array.isArray(response.answer))
  ) {
    const rawParent = response.answer.selectedParent || "";
    const matchedParentOpt = options.find(
      (o) => o.id === rawParent || o.value === rawParent,
    );
    const parentLabel = (
      matchedParentOpt ? matchedParentOpt.value : String(rawParent)
    ).trim();

    const subOptions = Array.isArray(matchedParentOpt?.subOptions)
      ? matchedParentOpt.subOptions
      : [];

    const subs = Array.isArray(response.answer.subSelections)
      ? response.answer.subSelections
          .map((subVal) => {
            const matchedSub = subOptions.find(
              (s) => s.id === subVal || s.value === subVal,
            );
            return (
              matchedSub ? matchedSub.value : String(subVal || "")
            ).trim();
          })
          .filter((s) => s && !/^(not\s*significant|none|nil|n\/a)$/i.test(s))
      : [];

    if (parentLabel && subs.length > 0) {
      return `${parentLabel} (${subs.join(", ")})`;
    }
    return parentLabel || subs.join(", ") || null;
  }

  // 2. Handle standard radio / dropdown string answers
  if (type === "radio" || type === "dropdown") {
    const matched = options.find(
      (o) => o.id === response.answer || o.value === response.answer,
    );
    return (matched ? matched.value : String(response.answer)).trim() || null;
  }

  // 3. Fallback for plain text or array
  if (Array.isArray(response.answer)) {
    return response.answer.join(", ").trim() || null;
  }

  return String(response.answer).trim() || null;
};
// ── Get Monthly IPD Admission Register Data for UI & Excel Export ────────────
const getMonthlyIpdRegisterForExcel = async (req, res) => {
  try {
    const { month, year, startDate, endDate, onlyWithPlans } = req.query;

    const Patient = getPatientModel(req.orgDb);
    const PatientAssessment = getPatientAssessmentModel(req.orgDb);
    const TherapyPlan = getTherapyPlanModel(req.orgDb);
    const TherapySession = getTherapySession(req.orgDb);
    const Prescription = getPrescriptionModel(req.orgDb);
    const Doctor = getDoctorModel(req.orgDb);

    // ── 1. Build Date Window ────────────────────────────────────────────────
    let rangeStart = null;
    let rangeEnd = null;

    if (startDate || endDate) {
      if (startDate) rangeStart = new Date(startDate);
      if (endDate) {
        rangeEnd = new Date(endDate);
        rangeEnd.setHours(23, 59, 59, 999);
      }
    } else if (month && /^\d{4}-\d{2}$/.test(String(month))) {
      const [y, m] = String(month).split("-").map(Number);
      rangeStart = new Date(y, m - 1, 1, 0, 0, 0, 0);
      rangeEnd = new Date(y, m, 0, 23, 59, 59, 999);
    } else if (month && String(month).toLowerCase() !== "all" && year) {
      const y = parseInt(year, 10);
      const m = parseInt(month, 10);
      if (isNaN(y) || isNaN(m) || m < 1 || m > 12) {
        return res
          .status(400)
          .json({ error: "Invalid month or year parameter." });
      }
      rangeStart = new Date(y, m - 1, 1, 0, 0, 0, 0);
      rangeEnd = new Date(y, m, 0, 23, 59, 59, 999);
    } else if (year) {
      const y = parseInt(year, 10);
      if (isNaN(y)) {
        return res.status(400).json({ error: "Invalid year parameter." });
      }
      rangeStart = new Date(y, 0, 1, 0, 0, 0, 0);
      rangeEnd = new Date(y, 11, 31, 23, 59, 59, 999);
    }

    // ── 2. Fetch Matching Patients ──────────────────────────────────────────
    let matchingPlanIds = [];
    if (rangeStart || rangeEnd) {
      const planDateQuery = {};
      if (rangeStart) planDateQuery.$gte = formatDateYYYYMMDD(rangeStart);
      if (rangeEnd) planDateQuery.$lte = formatDateYYYYMMDD(rangeEnd);

      const plansInWindow = await TherapyPlan.find({
        therapy_start: planDateQuery,
      })
        .select("_id")
        .lean();

      matchingPlanIds = plansInWindow.map((p) => p._id);
    }

    const patientQuery = {};
    if (rangeStart || rangeEnd) {
      const regDateCond = {};
      if (rangeStart) regDateCond.$gte = rangeStart;
      if (rangeEnd) regDateCond.$lte = rangeEnd;

      patientQuery.$or = [
        { patient_registration_date: regDateCond },
        ...(matchingPlanIds.length > 0
          ? [{ therapy_plans: { $in: matchingPlanIds } }]
          : []),
      ];
    }

    if (onlyWithPlans === "true") {
      patientQuery["therapy_plans.0"] = { $exists: true };
    }

    const patients = await Patient.find(patientQuery)
      .populate("doctor_id", "doctor_first_name doctor_last_name")
      .sort({ patient_registration_date: 1 })
      .lean();

    if (patients.length === 0) {
      return res.status(200).json({
        total_records: 0,
        records: [],
        monthly_data: [],
      });
    }

    // ── Sort patients by UHID (OPD Reg No, then IPD No) ─────────────────────
    patients.sort(compareByUhid);

    const patientObjectIds = patients.map((p) => p._id);
    const patientIdStrings = patients.map((p) => p._id.toString());

    const allPlanIds = [];
    for (const p of patients) {
      if (Array.isArray(p.therapy_plans)) {
        for (const planId of p.therapy_plans) {
          if (mongoose.Types.ObjectId.isValid(planId)) {
            allPlanIds.push(new mongoose.Types.ObjectId(planId));
          }
        }
      }
    }

    // ── 3. Batch-Fetch Assessments, Plans, Prescriptions, Sessions ──────────
    const [assessments, plans, prescriptionsByPatient, sessions] =
      await Promise.all([
        PatientAssessment.find({ patient_id: { $in: patientObjectIds } })
          .sort({ date_taken: -1 })
          .lean(),
        allPlanIds.length > 0
          ? TherapyPlan.find({ _id: { $in: allPlanIds } }).lean()
          : Promise.resolve([]),
        Prescription.find({ patient_id: { $in: patientObjectIds } })
          .sort({ prescription_date: -1 })
          .lean(),
        TherapySession.find({ patient_id: { $in: patientIdStrings } })
          .select(
            "patient_id therepy_type issue_dealt_with clinical_observations",
          )
          .lean(),
      ]);

    const fetchedRxIds = new Set(
      prescriptionsByPatient.map((rx) => rx._id.toString()),
    );
    const missingPlanRxIds = [];
    const closedByDocIds = [];

    for (const plan of plans) {
      const candidateRxIds = [
        plan.prescription_id,
        plan.post_care_prescription_id,
        ...(Array.isArray(plan.prescriptions) ? plan.prescriptions : []),
      ].filter((id) => id && mongoose.Types.ObjectId.isValid(id));

      for (const rxId of candidateRxIds) {
        if (!fetchedRxIds.has(rxId.toString())) {
          missingPlanRxIds.push(new mongoose.Types.ObjectId(rxId));
          fetchedRxIds.add(rxId.toString());
        }
      }

      if (plan.closed_by && mongoose.Types.ObjectId.isValid(plan.closed_by)) {
        closedByDocIds.push(new mongoose.Types.ObjectId(plan.closed_by));
      }
    }

    const [extraPrescriptions, closedByDoctors] = await Promise.all([
      missingPlanRxIds.length > 0
        ? Prescription.find({ _id: { $in: missingPlanRxIds } }).lean()
        : Promise.resolve([]),
      closedByDocIds.length > 0
        ? Doctor.find({ _id: { $in: closedByDocIds } })
            .select("doctor_first_name doctor_last_name")
            .lean()
        : Promise.resolve([]),
    ]);

    // ── 4. Build Lookup Maps ────────────────────────────────────────────────
    const assessmentsByPatientMap = new Map();
    for (const a of assessments) {
      const key = a.patient_id.toString();
      if (!assessmentsByPatientMap.has(key)) {
        assessmentsByPatientMap.set(key, []);
      }
      assessmentsByPatientMap.get(key).push(a);
    }

    const planByIdMap = new Map();
    for (const plan of plans) {
      planByIdMap.set(plan._id.toString(), plan);
    }

    const rxByIdMap = new Map();
    const rxByPatientMap = new Map();
    for (const rx of [...prescriptionsByPatient, ...extraPrescriptions]) {
      rxByIdMap.set(rx._id.toString(), rx);
      if (rx.patient_id) {
        const pKey = rx.patient_id.toString();
        if (!rxByPatientMap.has(pKey)) {
          rxByPatientMap.set(pKey, []);
        }
        rxByPatientMap.get(pKey).push(rx);
      }
    }

    const sessionsByPatientMap = new Map();
    for (const s of sessions) {
      const pKey = String(s.patient_id);
      if (!sessionsByPatientMap.has(pKey)) {
        sessionsByPatientMap.set(pKey, []);
      }
      sessionsByPatientMap.get(pKey).push(s);
    }

    const doctorByIdMap = new Map();
    for (const d of closedByDoctors) {
      doctorByIdMap.set(
        d._id.toString(),
        `Dr. ${d.doctor_first_name || ""} ${d.doctor_last_name || ""}`.trim(),
      );
    }

    // ── 5. Construct IPD Admission Register Rows Grouped Month-Wise ─────────
    const monthlyGroupsMap = new Map();

    for (const patient of patients) {
      const pIdStr = patient._id.toString();

      const patientPlans = (patient.therapy_plans || [])
        .map((id) => planByIdMap.get(id?.toString()))
        .filter(Boolean);

      const selectedPlan =
        patientPlans.find((p) => p.status === "Active") ||
        patientPlans.sort(
          (a, b) =>
            new Date(b.therapy_start || b.createdAt || 0) -
            new Date(a.therapy_start || a.createdAt || 0),
        )[0] ||
        null;

      // ── Col 2 & 3: Date & Time of Admission ───────────────────────────────
      // Prefer patient_registration_date or plan.therapy_start
      const rawAdmissionDate =
        patient.patient_registration_date || selectedPlan?.therapy_start;
      const admissionDateObj = rawAdmissionDate
        ? new Date(rawAdmissionDate)
        : new Date();

      if (rangeStart && admissionDateObj < rangeStart) continue;
      if (rangeEnd && admissionDateObj > rangeEnd) continue;

      const yearNum = admissionDateObj.getFullYear();
      const monthNum = admissionDateObj.getMonth() + 1;
      const monthKey = `${yearNum}-${String(monthNum).padStart(2, "0")}`;
      const monthLabel = admissionDateObj.toLocaleString("en-US", {
        month: "long",
        year: "numeric",
      });

      const dateOfAdmission = formatDateYYYYMMDD(rawAdmissionDate);

      // Extract Time of Admission from patient_journey "Registration" stage first
      const regJourneyStage = Array.isArray(patient.patient_journey)
        ? patient.patient_journey.find((j) => j.stage === "Registration") ||
          patient.patient_journey[0]
        : null;

      const timeOfAdmission =
        formatTimeIST(regJourneyStage?.performed_at) ||
        formatTimeIST(patient.patient_registration_date) ||
        formatTimeIST(selectedPlan?.createdAt) ||
        "N/A";

      // ── Col 4 & 5: Split UHID ("7552/0992") into OPD Reg No & IPD No ──────
      const { opdRegNo, ipdNo } = parseUhidAndIpd(
        patient.UHID,
        patient.patient_id,
      );

      // ── Assessments Lookup ────────────────────────────────────────────────
      const patientAssessments = assessmentsByPatientMap.get(pIdStr) || [];
      const drugUseAssessment = patientAssessments.find((a) =>
        /drug\s*use\s*history/i.test(a.assessment_name || ""),
      );
      const clinicalAssessment = patientAssessments.find((a) =>
        /clinical\s*asses+ment/i.test(a.assessment_name || ""),
      );

      // ── Col 9: Address & Contact ──────────────────────────────────────────
      const addressParts = [
        patient.patient_address1,
        patient.patient_address2,
        patient.address?.street,
        patient.address?.city,
        patient.address?.state,
        patient.address?.zip,
      ]
        .map((part) => (part ? String(part).trim() : ""))
        .filter(Boolean);

      const cleanAddress =
        addressParts.length > 0 ? [...new Set(addressParts)].join(", ") : "";
      const cleanPhone = (
        patient.patient_phone ||
        patient.guardian_phone ||
        ""
      ).trim();

      const addressAndContact =
        cleanAddress && cleanPhone
          ? `${cleanAddress} | ${cleanPhone}`
          : cleanAddress || cleanPhone || "N/A";

      // ── Col 10: Relative / Guardian Name & Relation ───────────────────────
      const relName = (
        patient.witness_name ||
        patient.emergency_contact?.name ||
        ""
      ).trim();
      const relType = (
        patient.witness_relationship ||
        patient.guardian_relation ||
        patient.guardian_relation_2 ||
        patient.emergency_contact?.relationship ||
        ""
      ).trim();
      const relPhone = (
        patient.guardian_phone ||
        patient.guardian_phone_2 ||
        patient.emergency_contact?.phone ||
        ""
      ).trim();

      let guardianInfo = "N/A";
      if (relName) {
        guardianInfo = `${relName}${relType ? ` (${relType})` : ""}`;
      } else if (relType) {
        guardianInfo = `${relType}${relPhone ? ` - ${relPhone}` : ""}`;
      } else if (relPhone) {
        guardianInfo = relPhone;
      }

      // ── Col 11: Primary Substance of Abuse ────────────────────────────────
      let primarySubstance = null;
      if (drugUseAssessment) {
        const drugRows = extractTableRows(
          drugUseAssessment,
          ["qy0izwu"],
          /substance\s*use\s*history/i,
        );
        const firstFilledRow = drugRows.find(
          (r) => r["6naifxr"] || r["types of drug"],
        );
        if (firstFilledRow) {
          primarySubstance =
            firstFilledRow["6naifxr"] ||
            firstFilledRow["types of drug"] ||
            null;
        }
      }
      if (!primarySubstance && clinicalAssessment) {
        const hpiRows = extractTableRows(
          clinicalAssessment,
          ["5la1boj"],
          /history\s*of\s*present\s*illness/i,
        );
        const firstFilledRow = hpiRows.find(
          (r) => r["xo9elnt"] || r["substance"],
        );
        if (firstFilledRow) {
          primarySubstance =
            firstFilledRow["xo9elnt"] || firstFilledRow["substance"] || null;
        }
      }

      // ── Col 12: Withdrawal Symptoms / Severity (CIWA/COWS) ────────────────
      const withdrawalParts = [];

      if (drugUseAssessment) {
        const screeningRows = extractTableRows(
          drugUseAssessment,
          ["zdvrwuv"],
          /screening\s*reports/i,
        );
        const ciwaRow = screeningRows.find(
          (r) =>
            r.__rowId === "5vgwjjk" ||
            /ciwa|cows/i.test(r.__rowLabel || r["c8laoqe"] || r["test"] || ""),
        );
        if (ciwaRow) {
          const score = ciwaRow["rv5hyja"] || ciwaRow["score"] || "";
          const interp = ciwaRow["r95ysk3"] || ciwaRow["interpretation"] || "";
          if (score || interp) {
            withdrawalParts.push(
              `CIWA-Ar: ${score}${interp ? ` (${interp.replace(/\.$/, "")})` : ""}`.trim(),
            );
          }
        }
      }

      if (clinicalAssessment) {
        const withdrawalNature = extractSingleOrNestedAnswer(
          clinicalAssessment,
          ["tganror"],
          /history\s*of\s*withdraw/i,
        );
        const withdrawalSymptoms = extractCheckboxLabels(
          clinicalAssessment,
          ["qaq0bdg"],
          /symptoms\s*of\s*withdraw/i,
        );

        if (withdrawalNature && !/not\s*significant/i.test(withdrawalNature)) {
          withdrawalParts.push(withdrawalNature);
        }
        if (withdrawalSymptoms.length > 0) {
          const symStr = withdrawalSymptoms.join(", ");
          if (!withdrawalParts.some((p) => p.includes(symStr))) {
            withdrawalParts.push(symStr);
          }
        }
      }

      if (withdrawalParts.length === 0 && selectedPlan?.patient_symptoms) {
        const planSyms = Array.isArray(selectedPlan.patient_symptoms)
          ? selectedPlan.patient_symptoms.join(", ")
          : String(selectedPlan.patient_symptoms).trim();
        if (planSyms) withdrawalParts.push(planSyms);
      }

      const withdrawalSeverityStr =
        withdrawalParts.length > 0 ? withdrawalParts.join(" | ") : "N/A";

      // ── Col 13: Co-morbidities (Medical/Psychiatric) ──────────────────────
      const comorbiditySet = new Set();
      if (clinicalAssessment) {
        const comorbidities = extractCheckboxLabels(
          clinicalAssessment,
          ["d24j6l5"],
          /^comorbidity$/i,
        );
        const medComplications = extractCheckboxLabels(
          clinicalAssessment,
          ["67i4vdm"],
          /medical\s*complication/i,
        );
        const psychProblems = extractCheckboxLabels(
          clinicalAssessment,
          ["jsd3qgc"],
          /psychiatric\s*problem/i,
        );

        [...comorbidities, ...medComplications, ...psychProblems].forEach(
          (item) => comorbiditySet.add(item),
        );

        const diagRows = extractTableRows(
          clinicalAssessment,
          ["35zehvd"],
          /^diagnosis$/i,
        );
        for (const r of diagRows) {
          if (
            ["lmnuql1", "xkowlwd", "b5izq3r"].includes(r.__rowId) ||
            /psychiatric|medical|comorbidity/i.test(r.__rowLabel || "")
          ) {
            const resp = r["tqrjog0"] || r["response"];
            if (resp && !/^(not\s*significant|none|nil|n\/a)$/i.test(resp)) {
              comorbiditySet.add(resp);
            }
          }
        }
      }

      if (comorbiditySet.size === 0 && Array.isArray(patient.medical_history)) {
        patient.medical_history
          .map((m) => String(m || "").trim())
          .filter((m) => m && !/^(not\s*significant|none|nil|n\/a)$/i.test(m))
          .forEach((m) => comorbiditySet.add(m));
      }

      const coMorbiditiesStr =
        comorbiditySet.size > 0
          ? Array.from(comorbiditySet).join(", ")
          : "None";

      // ── Col 14: Detoxification Regimen / Medications (Top 2 Medications) ──
      let selectedRx = null;
      if (selectedPlan) {
        const planRxId =
          selectedPlan.prescription_id ||
          selectedPlan.post_care_prescription_id ||
          (Array.isArray(selectedPlan.prescriptions) &&
          selectedPlan.prescriptions.length > 0
            ? selectedPlan.prescriptions[selectedPlan.prescriptions.length - 1]
            : null);

        if (planRxId) {
          selectedRx = rxByIdMap.get(planRxId.toString()) || null;
        }
      }
      if (!selectedRx) {
        const patientRxs = rxByPatientMap.get(pIdStr) || [];
        selectedRx = patientRxs[0] || null;
      }

      let top2Medications = [];
      if (selectedRx && Array.isArray(selectedRx.medications)) {
        top2Medications = selectedRx.medications
          .slice(0, 2)
          .map((med) => {
            const name = (med.drug_name || "").trim();
            const strength = (med.strength || "").trim();
            const freq =
              med.frequency ||
              (Array.isArray(med.schedules) && med.schedules[0]?.frequency) ||
              "";
            let label =
              strength && !name.toLowerCase().includes(strength.toLowerCase())
                ? `${name} ${strength}`
                : name;
            if (freq && freq !== "0") {
              label = `${label} (${freq})`;
            }
            return label.trim();
          })
          .filter(Boolean);
      } else if (
        Array.isArray(patient.medications) &&
        patient.medications.length > 0
      ) {
        top2Medications = patient.medications
          .slice(0, 2)
          .map((m) => String(m || "").trim())
          .filter(Boolean);
      }

      const detoxMedicationsStr =
        top2Medications.length > 0 ? top2Medications.join(" + ") : "N/A";

      // ── Col 15: Psychosocial Intervention Plan ────────────────────────────
      const patientSessions = sessionsByPatientMap.get(pIdStr) || [];
      const sessionTypes = [
        ...new Set(
          patientSessions
            .map((s) => s.therepy_type)
            .filter(
              (t) =>
                t && !["In Clinic", "In Home", "IP/ICU", "Online"].includes(t),
            ),
        ),
      ];

      const psychParts = [];
      if (selectedPlan?.therapy_name) {
        psychParts.push(selectedPlan.therapy_name);
      }
      if (
        selectedPlan?.patient_therapy_category &&
        selectedPlan.patient_therapy_category !== selectedPlan?.therapy_name
      ) {
        psychParts.push(selectedPlan.patient_therapy_category);
      }
      if (sessionTypes.length > 0) {
        psychParts.push(`${sessionTypes.join(" + ")} Counseling`);
      }

      const psychosocialPlanStr =
        psychParts.length > 0
          ? [...new Set(psychParts)].join(" + ")
          : "Individual + Family Counseling";

      // ── Col 16 & 17: Date of Discharge & Condition at Discharge ───────────
      const dischargeJourneyStage = Array.isArray(patient.patient_journey)
        ? patient.patient_journey.find((j) => j.stage === "Discharged")
        : null;

      const isPlanCompleted =
        selectedPlan?.status?.toLowerCase() === "completed" ||
        patient.status === "Archived";

      const rawDischargeDate =
        patient.archived_at ||
        dischargeJourneyStage?.performed_at ||
        selectedPlan?.closure_date ||
        (isPlanCompleted ? selectedPlan?.therapy_end : null);

      const dateOfDischarge =
        formatDateYYYYMMDD(rawDischargeDate) || "Admitted";

      let conditionAtDischarge = "Admitted / Under Care";
      if (selectedPlan?.treatment_outcome) {
        conditionAtDischarge = selectedPlan.treatment_outcome;
      } else if (patient.status === "Archived" && patient.archived_reason) {
        conditionAtDischarge = /completed/i.test(patient.archived_reason)
          ? "Stable"
          : patient.archived_reason;
      } else if (selectedPlan?.closure_reason) {
        const reasonMap = {
          Completed: "Stable",
          Incomplete: "LAMA / Incomplete",
          Dropout: "LAMA / Dropout",
          Refer: "Referred",
          OPD: "Stepped Down to OPD",
        };
        conditionAtDischarge =
          reasonMap[selectedPlan.closure_reason] || selectedPlan.closure_reason;
      }

      // ── Col 18: Medical Officer Signature ─────────────────────────────────
      // Prioritize Medical Department doctor from care_team (e.g. "Dr. Ajay Shinde")
      let medicalOfficer = null;
      if (Array.isArray(patient.care_team) && patient.care_team.length > 0) {
        const medDoctor =
          patient.care_team.find(
            (m) =>
              /medical/i.test(m.department_name || "") &&
              /^dr\.?\s/i.test(m.doctor_name || ""),
          ) ||
          patient.care_team.find((m) =>
            /^dr\.?\s/i.test(m.doctor_name || ""),
          ) ||
          patient.care_team.find((m) =>
            /medical/i.test(m.department_name || ""),
          );
        if (medDoctor?.doctor_name) {
          medicalOfficer = medDoctor.doctor_name.trim();
        }
      }

      if (!medicalOfficer && selectedPlan?.closed_by_name) {
        medicalOfficer = selectedPlan.closed_by_name;
      }
      if (!medicalOfficer && selectedPlan?.closed_by) {
        medicalOfficer =
          doctorByIdMap.get(selectedPlan.closed_by.toString()) || null;
      }
      if (!medicalOfficer && Array.isArray(patient.patient_journey)) {
        const medStage = patient.patient_journey.find(
          (j) =>
            j.stage === "Treatment Plan Created" ||
            j.stage === "Completed First Assessment",
        );
        if (medStage?.performed_by_name) {
          medicalOfficer = medStage.performed_by_name;
        }
      }
      if (!medicalOfficer && patient.doctor_id?.doctor_first_name) {
        medicalOfficer =
          `${patient.doctor_id.doctor_first_name} ${patient.doctor_id.doctor_last_name || ""}`.trim();
      }
      if (!medicalOfficer && patient.doctor_name) {
        medicalOfficer = patient.doctor_name;
      }

      // ── Group into Month Bucket ───────────────────────────────────────────
      if (!monthlyGroupsMap.has(monthKey)) {
        monthlyGroupsMap.set(monthKey, {
          month_key: monthKey,
          month_label: monthLabel,
          year: yearNum,
          month: monthNum,
          records: [],
        });
      }

      const monthGroup = monthlyGroupsMap.get(monthKey);
      const sNo = monthGroup.records.length + 1;

      const fullName = [
        patient.patient_first_name,
        patient.patient_middle_name,
        patient.patient_last_name,
      ]
        .filter(Boolean)
        .join(" ")
        .trim();

      monthGroup.records.push({
        patient_id: patient._id,
        plan_id: selectedPlan?._id || null,
        s_no: sNo,
        date_of_admission: dateOfAdmission,
        time_of_admission: timeOfAdmission,
        ipd_bed_no: ipdNo, // After "/" in UHID (e.g., "0992")
        opd_reg_no: opdRegNo, // Before "/" in UHID (e.g., "7552")
        patient_name: fullName || "N/A",
        age: patient.patient_age || "N/A",
        gender: patient.gender || "N/A",
        address_and_contact: addressAndContact,
        address: cleanAddress || "N/A",
        contact_number: cleanPhone || "N/A",
        guardian_details: guardianInfo,
        primary_substance: primarySubstance || "N/A",
        withdrawal_severity: withdrawalSeverityStr,
        co_morbidities: coMorbiditiesStr,
        detox_medications: detoxMedicationsStr,
        psychosocial_plan: psychosocialPlanStr,
        date_of_discharge: dateOfDischarge,
        condition_at_discharge: conditionAtDischarge,
        medical_officer: medicalOfficer || "N/A",
        diagnosis_icd: selectedPlan?.ICD_11_Codes || "N/A",

        // Exact 18-column Excel mapping matching private_deaddiction_ipd_format-v2.xlsx
        excel_row: {
          "S.No": sNo,
          "Date of Admission": dateOfAdmission || "",
          "Time of Admission": timeOfAdmission === "N/A" ? "" : timeOfAdmission,
          "IPD No. / Bed No.": ipdNo === "N/A" ? "" : ipdNo,
          "OPD Reg No.": opdRegNo === "N/A" ? "" : opdRegNo,
          "Patient Name": fullName || "",
          Age: patient.patient_age || "",
          Gender: patient.gender || "",
          "Address & Contact":
            addressAndContact === "N/A" ? "" : addressAndContact,
          "Relative / Guardian Name & Relation":
            guardianInfo === "N/A" ? "" : guardianInfo,
          "Primary Substance of Abuse": primarySubstance || "",
          "Withdrawal Symptoms / Severity (CIWA/COWS)":
            withdrawalSeverityStr === "N/A" ? "" : withdrawalSeverityStr,
          "Co-morbidities (Medical/Psychiatric)": coMorbiditiesStr,
          "Detoxification Regimen / Medications":
            detoxMedicationsStr === "N/A" ? "" : detoxMedicationsStr,
          "Psychosocial Intervention Plan": psychosocialPlanStr,
          "Date of Discharge":
            dateOfDischarge === "Admitted" ? "" : dateOfDischarge,
          "Condition at Discharge (Stable/LAMA/Referred)":
            conditionAtDischarge === "Admitted / Under Care"
              ? ""
              : conditionAtDischarge,
          "Medical Officer Signature":
            medicalOfficer && medicalOfficer !== "N/A" ? medicalOfficer : "",
        },
      });
    }

    const monthlyData = Array.from(monthlyGroupsMap.values())
      .sort((a, b) => a.month_key.localeCompare(b.month_key))
      .map((group) => ({
        ...group,
        total_records: group.records.length,
      }));

    const allRecords = monthlyData.flatMap((group) => group.records);

    return res.status(200).json({
      total_records: allRecords.length,
      records: allRecords,
      monthly_data: monthlyData,
    });
  } catch (error) {
    console.error("Error generating monthly IPD register data:", error);
    return res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  }
};
module.exports = {
  createAssessment,
  getAllAssessments,
  getAssessmentById,
  updateAssessment,
  deleteAssessment,
  getPatientForPrint,
  getTherapyPlanForPrint,
  getSingleAssessmentForPrint,
  suggestNotesCompletion,
  getFollowupForPrint,
  getMonthlyOpdRegisterForExcel,
  getMonthlyIpdRegisterForExcel,
};
