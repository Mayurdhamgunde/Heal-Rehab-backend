// utils/deepTranslate.js
//
// Recursively translates ANY JSON-serializable value (object, array,
// nested mix of both) into a target language, using Google Translate.
// This is generic on purpose — you can point it at the assessment print
// payload, the aftercare report, a therapy plan, etc.
//
// It intentionally leaves alone: _id/id-style keys, dates, phone/email,
// image/logo tokens, URLs, and pure numbers — even though they're
// strings — so IDs and SAS-token URLs never get corrupted by translation.

const { batchTranslate } = require("./batchtranslate");

// Keys that should never be translated even if their value is a string.
const DEFAULT_SKIP_KEYS = new Set([
  "_id",
  "id",
  "assessment_id",
  "question_id",
  "row_id",
  "col_id",
  "blank_id",
  "doctor_id",
  "patient_id",
  "tenant_id",
  "UHID",
  "sr_no",
  "date_taken",
  "date_of_birth",
  "created_at",
  "updated_at",
  "image",
  "logo",
  "phone",
  "guardian_phone",
  "email",
  "website",
  "registration_number",
  "col_type",
  "cell_type",
  "type",
  "answer_raw",
]);

// Skip strings that are obviously not natural-language text.
function looksNonTranslatable(text) {
  if (!text || !text.trim()) return true;
  if (/^https?:\/\//i.test(text)) return true; // URLs / SAS tokens
  if (/^[\d\s.,:/+-]+$/.test(text)) return true; // pure numbers/phone-ish
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return true; // ISO dates
  return false;
}

// Protect template placeholders like {{blank_1}} or __BLANK_1__ so Google
// Translate doesn't rewrite/mangle them; restored after translation.
const PLACEHOLDER_REGEX = /\{\{.*?\}\}|__[A-Z0-9_]+__|\[blank\]/g;

function protectPlaceholders(text) {
  const found = [];
  const safe = text.replace(PLACEHOLDER_REGEX, (match) => {
    const token = `@@PH${found.length}@@`;
    found.push(match);
    return token;
  });
  return { safe, found };
}

function restorePlaceholders(text, found) {
  return text.replace(/@@PH(\d+)@@/g, (_, i) => found[Number(i)] ?? "");
}

function collectStrings(value, key, skipKeys, bucket) {
  if (value === null || value === undefined) return;

  if (typeof value === "string") {
    if (skipKeys.has(key) || looksNonTranslatable(value)) return;
    const { safe } = protectPlaceholders(value);
    bucket.add(safe);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((v) => collectStrings(v, key, skipKeys, bucket));
    return;
  }

  if (typeof value === "object") {
    Object.entries(value).forEach(([k, v]) =>
      collectStrings(v, k, skipKeys, bucket),
    );
  }
}

function applyTranslations(value, key, skipKeys, translations) {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    if (skipKeys.has(key) || looksNonTranslatable(value)) return value;
    const { safe, found } = protectPlaceholders(value);
    const translatedSafe = translations.get(safe) ?? safe;
    return restorePlaceholders(translatedSafe, found);
  }

  if (Array.isArray(value)) {
    return value.map((v) => applyTranslations(v, key, skipKeys, translations));
  }

  if (typeof value === "object") {
    const out = {};
    Object.entries(value).forEach(([k, v]) => {
      out[k] = applyTranslations(v, k, skipKeys, translations);
    });
    return out;
  }

  return value;
}

/**
 * Deep-translates any JSON-serializable value into `targetLang`.
 * Returns the input unchanged if targetLang is missing or 'en'.
 *
 * @param {*} data
 * @param {string} targetLang - e.g. 'hi', 'mr', 'kn', 'ta'
 * @param {object} [options]
 * @param {string[]} [options.extraSkipKeys] - additional keys to never translate
 * @param {string} [options.sourceLang='en']
 */
async function deepTranslate(data, targetLang, options = {}) {
  if (!targetLang || targetLang === "en") return data;

  const skipKeys = new Set([
    ...DEFAULT_SKIP_KEYS,
    ...(options.extraSkipKeys || []),
  ]);

  const bucket = new Set();
  collectStrings(data, null, skipKeys, bucket);
  if (bucket.size === 0) return data;

  const translations = await batchTranslate(
    [...bucket],
    targetLang,
    options.sourceLang || "en",
  );

  return applyTranslations(data, null, skipKeys, translations);
}

module.exports = { deepTranslate };
