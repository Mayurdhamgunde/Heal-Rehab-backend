// controllers/translateAssessmentPrintController.js
//
// Fired as a SECOND api call, after the UI already has the payload from
// getSingleAssessmentForPrint. It does not re-query the DB — it just
// takes the payload the client already has and returns a translated copy.
//
//   1. GET  /assessments/:assessmentId/print          -> getSingleAssessmentForPrint (unchanged)
//   2. POST /assessments/print/translate               -> this function, fired on language change

const { deepTranslate } = require("../utils/deepTranslate");

const translateAssessmentPrint = async (req, res) => {
  try {
    const { data, targetLang } = req.body;

    if (!data || typeof data !== "object") {
      return res.status(400).json({
        error:
          "`data` (the payload returned by getSingleAssessmentForPrint) is required",
      });
    }
    if (!targetLang) {
      return res
        .status(400)
        .json({ error: "`targetLang` is required, e.g. 'hi', 'mr', 'kn'" });
    }
    if (!data.assessment) {
      return res.status(400).json({
        error: "`data.assessment` is missing — is this a valid print payload?",
      });
    }

    // Only the assessment content (question text, answers, general notes)
    // gets translated. Patient/org identity fields (names, addresses,
    // phone/email/UHID) travel through untouched — deepTranslate already
    // skips those by key, but we scope to `data.assessment` anyway so we
    // never even attempt to touch patient/org objects.
    const translatedAssessment = await deepTranslate(
      data.assessment,
      targetLang,
      {
        // 'status' (Active/Completed/etc.) and 'doctor' (a proper name)
        // shouldn't be machine-translated.
        extraSkipKeys: ["status", "doctor"],
      },
    );

    return res.status(200).json({
      ...data,
      assessment: translatedAssessment,
      language: targetLang,
    });
  } catch (error) {
    console.error("Error translating assessment print payload:", error);

    // Fail soft: let the UI fall back to the original (untranslated) data
    // it already has, instead of blocking the print flow entirely.
    return res.status(500).json({
      error: "Translation failed",
      language: "en",
    });
  }
};

module.exports = { translateAssessmentPrint };
