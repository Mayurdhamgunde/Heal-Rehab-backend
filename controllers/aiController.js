const axios = require("axios");
const mongoose = require("mongoose");
const ObjectId = mongoose.Types.ObjectId;

const { getPatientModel } = require("../db/patientSchema");
const { getTherapySession, getTherapyPlanModel } = require("../db/therepy");
const { getPrescriptionModel } = require("../db/prescriptionSchema");
const { getPatientAssessmentModel } = require("../db/patientAssessmentSchema");

const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODEL = "gemini-3.5-flash"; // swap to gemini-3.1-flash-lite for cheaper/faster runs (same tier as your Smart Compose feature); flash-lite trades off reasoning depth on ambiguous multi-factor cases

/* ============================================================================
 * 1. DATA COMPACTION
 *    Goal: strip every field the model doesn't need to reason about relapse
 *    risk (Mongo ids, template metadata, column defs, empty answers) and
 *    keep only clinically meaningful "label: value" signal. This is what
 *    keeps the payload small and keeps every token load-bearing.
 * ========================================================================== */

const GENERIC_COL = /^(response|details|value)$/i;

// Turns one assessment's raw responses + template_snapshot into short,
// human-readable lines. Skips section headers, empty answers, and "None"
// checkbox answers (a "None" is a non-finding, not a signal).
function flattenAssessmentResponses(assessment) {
  const snapshotQuestions = assessment.template_snapshot?.questions || [];
  const snapshotMap = {};
  snapshotQuestions.forEach((q) => (snapshotMap[q.id] = q));

  const lines = [];

  (assessment.responses || []).forEach((r) => {
    const snapQ = snapshotMap[r.question_id] || {};
    const type = r.question_type || snapQ.type;
    if (type === "section_header") return;

    const label = r.question_title || snapQ.title || "";

    if (type === "text") {
      if (r.answer && String(r.answer).trim()) {
        lines.push(`${label}: ${String(r.answer).trim()}`);
      }
      return;
    }

    if (type === "inline_blanks") {
      const blankLines = snapQ.blankLines || [];
      const raw = r.answer && typeof r.answer === "object" ? r.answer : {};
      blankLines.forEach((b) => {
        const val = raw[`${b.id}_0`] ?? raw[b.id];
        if (val && String(val).trim()) {
          const cleanLabel = (b.text || "").replace("[blank]", "").trim();
          lines.push(`${cleanLabel} ${String(val).trim()}`.trim());
        }
      });
      return;
    }

    if (type === "radio" || type === "dropdown") {
      const options = snapQ.options || [];
      const matched = options.find(
        (o) => o.id === r.answer || o.value === r.answer,
      );
      const val = matched ? matched.value : r.answer;
      if (val) lines.push(`${label}: ${val}`);
      return;
    }

    if (type === "checkbox") {
      const options = snapQ.options || [];
      const ids = Array.isArray(r.answer) ? r.answer : [];
      const values = ids.map(
        (id) => options.find((o) => o.id === id || o.value === id)?.value || id,
      );
      if (
        values.length &&
        !(values.length === 1 && /^none$/i.test(values[0]))
      ) {
        lines.push(`${label}: ${values.join(", ")}`);
      }
      return;
    }

    if (type === "table") {
      const rows = snapQ.rows || [];
      const columns = snapQ.columns || [];
      const raw = r.answer && typeof r.answer === "object" ? r.answer : {};
      rows.forEach((row) => {
        const rowAns = raw[row.id];
        if (!rowAns) return;
        const parts = [];
        columns.forEach((col) => {
          const v = rowAns[col.id];
          if (v === true) parts.push(col.value);
          else if (v && typeof v === "string" && v.trim()) {
            parts.push(
              GENERIC_COL.test(col.value || "")
                ? v.trim()
                : `${col.value}: ${v.trim()}`,
            );
          }
        });
        if (!parts.length) return;
        const prefix = label ? `${label} — ${row.label}` : row.label;
        lines.push(`${prefix}: ${parts.join("; ")}`);
      });
      return;
    }

    // Fallback for any future/unknown question type
    if (r.answer) lines.push(`${label}: ${JSON.stringify(r.answer)}`);
  });

  return lines;
}

// Session -> only non-null rehab/clinical signal, dropping "none"/empty noise.
function compactSession(s) {
  const out = {
    date: s.therepy_date,
    session_no: s.session_number ?? null,
    type: s.therepy_type,
    status: s.status,
  };
  if (s.issue_dealt_with) out.issue = s.issue_dealt_with;
  if (s.counselor_impression) out.impression = s.counselor_impression;

  const ri = s.rehab_indicators || {};
  const filteredRi = Object.fromEntries(
    Object.entries(ri).filter(
      ([, v]) => v !== null && v !== undefined && v !== "",
    ),
  );
  if (Object.keys(filteredRi).length) out.rehab_indicators = filteredRi;

  const co = s.clinical_observations || {};
  const filteredCo = {};
  if (
    Array.isArray(co.withdrawal_symptoms) &&
    co.withdrawal_symptoms.length &&
    !(
      co.withdrawal_symptoms.length === 1 &&
      co.withdrawal_symptoms[0] === "none"
    )
  ) {
    filteredCo.withdrawal_symptoms = co.withdrawal_symptoms;
  }
  if (co.appetite) filteredCo.appetite = co.appetite;
  if (co.physical_appearance)
    filteredCo.physical_appearance = co.physical_appearance;
  if (Object.keys(filteredCo).length) out.clinical_observations = filteredCo;

  return out;
}

function compactPlan(p) {
  return {
    name: p.therapy_name,
    diagnosis: p.patient_diagnosis,
    symptoms: p.patient_symptoms,
    category: p.patient_therapy_category,
    start: p.therapy_start,
    end: p.therapy_end,
    status: p.status,
    completed_sessions: p.completed_sessions,
    remaining_sessions: p.remaining_sessions,
    goal_achievement: p.goal_achievement,
  };
}

function compactPrescription(rx) {
  return {
    date: rx.prescription_date,
    status: rx.status, // Active / Superseded / Expired
    diagnosis: rx.diagnosis,
    meds: (rx.medications || []).map(
      (m) =>
        `${m.drug_name} ${m.strength} ${m.frequency}x/day x ${m.duration}d`,
    ),
  };
}

// Walks the previous_patient_id linked list backward: every hop is a
// documented prior relapse/re-admission for this same person. This is
// one of the strongest relapse-risk signals HealTrack has, so each hop
// now carries its own clinical record (sessions, plans, prescriptions,
// assessments) — not just closure metadata — since how a prior admission
// actually played out (declining indicators, poor goal_achievement,
// psychosocial findings from that episode's assessments) is exactly the
// kind of signal categories 1, 2, 4 and 5 in the system prompt need.
async function getRelapseChainSummary(orgDb, patient) {
  const Patient = getPatientModel(orgDb);
  const TherapySession = getTherapySession(orgDb);
  const TherapyPlan = getTherapyPlanModel(orgDb);
  const Prescription = getPrescriptionModel(orgDb);
  const PatientAssessment = getPatientAssessmentModel(orgDb);

  const priorAdmissions = [];
  const seen = new Set();
  let cursor = patient.previous_patient_id;

  while (cursor && !seen.has(String(cursor))) {
    seen.add(String(cursor));
    const prev = await Patient.findById(cursor)
      .select(
        "patient_registration_date status referral_source previous_patient_id therapy_plans",
      )
      .lean();
    if (!prev) break;

    const [prevSessions, prevPlans, prevAssessments] = await Promise.all([
      TherapySession.find({ patient_id: prev._id })
        .sort({ therepy_date: 1 })
        .lean(),
      TherapyPlan.find({ _id: { $in: prev.therapy_plans || [] } }).lean(),
      PatientAssessment.find({ patient_id: prev._id })
        .sort({ date_taken: 1 })
        .lean(),
    ]);

    const prevPrescriptionIds = prevPlans.flatMap((p) => p.prescriptions || []);
    const prevPrescriptions = prevPrescriptionIds.length
      ? await Prescription.find({ _id: { $in: prevPrescriptionIds } })
          .sort({ prescription_date: 1 })
          .lean()
      : [];

    priorAdmissions.push({
      registered: prev.patient_registration_date,
      closure_status: prev.status,
      referral_source: prev.referral_source,
      therapy_plans: prevPlans.map(compactPlan),
      sessions: prevSessions.map(compactSession),
      prescriptions: prevPrescriptions.map(compactPrescription),
      assessments: prevAssessments.map((a) => ({
        name: a.assessment_name,
        date: a.date_taken,
        findings: flattenAssessmentResponses(a),
      })),
    });
    cursor = prev.previous_patient_id;
  }

  return {
    prior_relapse_count: priorAdmissions.length,
    prior_admissions: priorAdmissions,
  };
}

// Assembles the full, trimmed patient profile sent to the model.
async function buildRelapseProfile(orgDb, patientId) {
  const Patient = getPatientModel(orgDb);
  const TherapySession = getTherapySession(orgDb);
  const TherapyPlan = getTherapyPlanModel(orgDb);
  const Prescription = getPrescriptionModel(orgDb);
  const PatientAssessment = getPatientAssessmentModel(orgDb);

  const patient = await Patient.findById(patientId).lean();
  if (!patient) return null;

  const [sessions, plans, assessments] = await Promise.all([
    TherapySession.find({ patient_id: patientId })
      .sort({ therepy_date: 1 })
      .lean(),
    TherapyPlan.find({ _id: { $in: patient.therapy_plans || [] } }).lean(),
    PatientAssessment.find({ patient_id: patientId })
      .sort({ date_taken: 1 })
      .lean(),
  ]);

  const prescriptionIds = plans.flatMap((p) => p.prescriptions || []);
  const prescriptions = prescriptionIds.length
    ? await Prescription.find({ _id: { $in: prescriptionIds } })
        .sort({ prescription_date: 1 })
        .lean()
    : [];

  const relapseHistory = await getRelapseChainSummary(orgDb, patient);

  return {
    demographics: {
      age: patient.patient_age,
      gender: patient.gender,
      occupation: patient.occupation,
      education: patient.education,
      marital_status: patient.marital_status,
      referral_source: patient.referral_source,
      prior_treatment: patient.prior_treatment,
      registration_date: patient.patient_registration_date,
      current_status: patient.status,
    },
    relapse_history: relapseHistory,
    assessments: assessments.map((a) => ({
      name: a.assessment_name,
      date: a.date_taken,
      findings: flattenAssessmentResponses(a),
    })),
    therapy_plans: plans.map(compactPlan),
    sessions: sessions.map(compactSession),
    prescriptions: prescriptions.map(compactPrescription),
  };
}

/* ============================================================================
 * 2. AI CALL
 *    Uses Gemini's responseSchema (responseMimeType: "application/json")
 *    instead of "please reply with JSON" prompting — this guarantees a
 *    schema-valid, parseable response every time instead of hoping the
 *    model doesn't add preamble or break formatting.
 * ========================================================================== */

const RELAPSE_RISK_SCHEMA = {
  type: "object",
  properties: {
    risk_level: {
      type: "string",
      enum: ["Low", "Moderate", "High", "Critical"],
    },
    risk_score: {
      type: "integer",
      minimum: 0,
      maximum: 100,
      description: "0 = negligible risk, 100 = near-certain imminent relapse.",
    },
    confidence: {
      type: "string",
      enum: ["Low", "Medium", "High"],
      description:
        "Reflects completeness of the data provided, NOT how risky the patient looks.",
    },
    contributing_factors: {
      type: "array",
      items: { type: "string" },
      maxItems: 5,
      description:
        "Concrete, data-backed factors raising relapse risk. Each under 12 words.",
    },
    protective_factors: {
      type: "array",
      items: { type: "string" },
      maxItems: 5,
      description:
        "Concrete, data-backed factors lowering relapse risk. Each under 12 words.",
    },
    recommended_actions: {
      type: "array",
      items: { type: "string" },
      maxItems: 4,
      description: "Specific, actionable next steps for the care team.",
    },
    rationale: {
      type: "string",
      description:
        "1-2 sentences tying the score directly to the data. Under 60 words.",
    },
  },
  required: [
    "risk_level",
    "risk_score",
    "confidence",
    "contributing_factors",
    "protective_factors",
    "recommended_actions",
    "rationale",
  ],
};

const SYSTEM_PROMPT = `You are a clinical decision-support engine embedded in HealTrack, an addiction-treatment SaaS platform. You analyze structured, de-identified patient treatment records and estimate a patient's short-term risk of relapse into alcohol use.

Rules:
- Base your assessment ONLY on the structured data provided. Never invent facts that are not present in the data.
- Weigh these signal categories: (1) documented relapse/re-admission history (previous_patient_id chain), (2) trend in rehab indicators (craving intensity, behavioural compliance, emotional stability, sleep quality) across sessions — improving vs. worsening vs. flat, (3) withdrawal symptoms and clinical observations, (4) treatment adherence (session completion, plan goal_achievement, prescription status/changes/supersessions), (5) psychosocial risk factors from assessments (family history of use, psychiatric comorbidity, occupational/marital instability), (6) recent engagement trend — declining session frequency or worsening indicators near the most recent sessions raises risk more than the same finding early in treatment.
- If a signal category has no data, do not silently assume it's favorable or unfavorable — just reflect that gap in "confidence" instead.
- Be precise and clinically grounded. No hedging language, no generic disclaimers, no filler.
- Return only the JSON object described by the response schema. No text before or after it.`;

async function requestRelapseRiskFromAI(profile) {
  const userPrompt = `Assess this patient's risk of relapse into alcohol use from the structured record below.

PATIENT RECORD (JSON):
${JSON.stringify(profile)}`;

  const response = await axios.post(
    `${GEMINI_API_URL}/${GEMINI_MODEL}:generateContent`,
    {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: {
        // Gemini 3.x models think by default (effort defaults to "medium"),
        // and thinking tokens are drawn from the SAME maxOutputTokens budget
        // as the visible response. At 1024 tokens, "medium" effort was
        // regularly consuming the whole budget on reasoning, leaving 0 or a
        // truncated fragment of JSON for the actual answer — which parses
        // as invalid JSON even though responseSchema was honored server-side.
        // "low" is enough for this task (weighing a fixed set of signal
        // categories against structured data, not open-ended math/proofs),
        // and 8192 leaves generous headroom for both thinking + the full
        // schema payload. Do NOT combine this with the legacy
        // thinkingBudget field — Gemini 3.x rejects requests that set both.
        maxOutputTokens: 8192,
        thinkingConfig: {
          thinkingLevel: "low",
        },
        responseMimeType: "application/json",
        responseSchema: RELAPSE_RISK_SCHEMA,
      },
    },
    {
      params: { key: process.env.GEMINI_API_KEY },
      headers: { "content-type": "application/json" },
      timeout: 30000,
    },
  );

  const candidate = response.data.candidates?.[0];
  const rawText = candidate?.content?.parts?.[0]?.text;

  if (!rawText) {
    // Most common cause: safety filters blocked the output — check
    // candidate.finishReason (e.g. "SAFETY", "RECITATION") when this fires.
    throw new Error(
      `Gemini returned no output (finishReason: ${candidate?.finishReason || "unknown"}).`,
    );
  }

  try {
    return JSON.parse(rawText);
  } catch (e) {
    // Log what actually came back — if finishReason is "MAX_TOKENS", the
    // JSON was cut off mid-write (usually because thinking ate the budget);
    // logging rawText's length/tail makes that obvious at a glance instead
    // of guessing blind.
    console.error("Gemini relapse-risk JSON parse failure:", {
      finishReason: candidate?.finishReason,
      usage: response.data.usageMetadata,
      rawTextLength: rawText.length,
      rawTextTail: rawText.slice(-200),
    });

    if (candidate?.finishReason === "MAX_TOKENS") {
      throw new Error(
        "Gemini response was truncated (MAX_TOKENS) before completing the JSON — increase maxOutputTokens or lower thinkingLevel.",
      );
    }

    throw new Error(
      "Gemini response did not parse as JSON despite responseSchema.",
    );
  }
}

/* ============================================================================
 * 3. PERSISTENCE
 *    Every call to getPatientRelapseRisk overwrites this field — it's a
 *    snapshot of the most recent prediction, not a history log.
 * ========================================================================== */

async function saveRelapseAssessment(
  Patient,
  patientId,
  assessment,
  assessedAt,
) {
  try {
    await Patient.findByIdAndUpdate(patientId, {
      $set: {
        relapse_risk_assessment: {
          risk_level: assessment.risk_level,
          risk_score: assessment.risk_score,
          confidence: assessment.confidence,
          contributing_factors: assessment.contributing_factors,
          protective_factors: assessment.protective_factors,
          recommended_actions: assessment.recommended_actions,
          rationale: assessment.rationale,
          assessed_at: assessedAt,
        },
      },
    });
  } catch (err) {
    // Don't fail the request over a persistence hiccup — the assessment
    // was generated successfully and the caller still needs it. Log loudly
    // so a bad write doesn't go unnoticed.
    console.error(
      `Failed to persist relapse_risk_assessment for patient ${patientId}:`,
      err.message,
    );
  }
}

/* ============================================================================
 * 4. CONTROLLER
 * ========================================================================== */

const getPatientRelapseRisk = async (req, res) => {
  try {
    const { patientId } = req.params;
    if (!ObjectId.isValid(patientId)) {
      return res.status(400).json({ error: "Invalid Patient ID format" });
    }

    const profile = await buildRelapseProfile(req.orgDb, patientId);
    if (!profile) {
      return res.status(404).json({ error: "Patient not found" });
    }

    const Patient = getPatientModel(req.orgDb);

    const hasSignal =
      profile.sessions.length > 0 ||
      profile.assessments.length > 0 ||
      profile.relapse_history.prior_relapse_count > 0;

    if (!hasSignal) {
      const assessedAt = new Date();
      const insufficientData = {
        risk_level: "Insufficient Data",
        risk_score: null,
        confidence: "Low",
        contributing_factors: [],
        protective_factors: [],
        recommended_actions: [
          "Complete an initial clinical assessment and at least one therapy session before requesting a risk assessment.",
        ],
        rationale:
          "No session, assessment, or relapse-history data exists for this patient yet.",
      };
      await saveRelapseAssessment(
        Patient,
        patientId,
        insufficientData,
        assessedAt,
      );
      return res.status(200).json({
        success: true,
        data: { ...insufficientData, assessed_at: assessedAt },
      });
    }

    const assessment = await requestRelapseRiskFromAI(profile);
    const assessedAt = new Date();
    await saveRelapseAssessment(Patient, patientId, assessment, assessedAt);

    return res.status(200).json({
      success: true,
      data: { ...assessment, assessed_at: assessedAt },
    });
  } catch (error) {
    console.error(
      "Relapse Risk Assessment Error:",
      error?.response?.data || error.message,
    );
    return res.status(500).json({
      error: "Failed to generate relapse risk assessment",
      details: error.message,
    });
  }
};

const processRelapseRisksForCompletedPlans = async (orgDb) => {
  const Patient = getPatientModel(orgDb);
  const TherapyPlan = getTherapyPlanModel(orgDb);

  try {
    // 1. Find all patients who do NOT have an existing relapse risk assessment
    const eligiblePatients = await Patient.find({
      $or: [
        { relapse_risk_assessment: { $exists: false } },
        { relapse_risk_assessment: null },
      ],
    }).lean();

    for (const patient of eligiblePatients) {
      // 2. Fetch their therapy plans to check for completion status
      const plans = await TherapyPlan.find({
        _id: { $in: patient.therapy_plans || [] },
      }).lean();

      // Adjust the string "completed" to match your DB's exact enum/case for completed plans
      const hasCompletedPlan = plans.some(
        (p) => p.status && p.status.toLowerCase() === "completed",
      );

      if (!hasCompletedPlan) continue;

      // 3. Build profile and generate risk using existing functions
      const profile = await buildRelapseProfile(orgDb, patient._id);
      if (!profile) continue;

      const hasSignal =
        profile.sessions.length > 0 ||
        profile.assessments.length > 0 ||
        profile.relapse_history.prior_relapse_count > 0;

      const assessedAt = new Date();

      if (!hasSignal) {
        const insufficientData = {
          risk_level: "Insufficient Data",
          risk_score: null,
          confidence: "Low",
          contributing_factors: [],
          protective_factors: [],
          recommended_actions: [
            "Complete an initial clinical assessment and at least one therapy session before requesting a risk assessment.",
          ],
          rationale:
            "No session, assessment, or relapse-history data exists for this patient yet.",
        };
        await saveRelapseAssessment(
          Patient,
          patient._id,
          insufficientData,
          assessedAt,
        );
        continue;
      }

      // Generate and save AI prediction
      const assessment = await requestRelapseRiskFromAI(profile);
      await saveRelapseAssessment(Patient, patient._id, assessment, assessedAt);
    }
  } catch (error) {
    console.error("Error processing batch relapse risks:", error.message);
  }
};

module.exports = {
  getPatientRelapseRisk,
  buildRelapseProfile, // exported for reuse/testing
  processRelapseRisksForCompletedPlans,
};
