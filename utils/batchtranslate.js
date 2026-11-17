// services/translationService.js
//
// Thin wrapper around the Google Cloud Translation API (v2, API-key auth).
// Requires GOOGLE_TRANSLATE_API_KEY in your env. Enable the "Cloud
// Translation API" on your GCP project and create a restricted API key.
//
// Note on cost: Translation API v2 bills per character translated
// (~$20 / 1M chars after the first 500k/month free). The in-memory cache
// below avoids re-billing identical strings (e.g. repeated question text
// across assessments) within the process lifetime.

const GOOGLE_TRANSLATE_URL =
  "https://translation.googleapis.com/language/translate/v2";
const API_KEY = process.env.Google_Translate_APIKey;

// Stay comfortably under Google's per-request limits (128 strings /
// ~30k chars for v2 POST requests).
const MAX_BATCH_SIZE = 80;
const MAX_BATCH_CHARS = 20000;

// Simple in-memory LRU-ish cache: key = `${targetLang}::${text}`.
// Swap this for Redis or a Mongo collection if you want translations to
// survive a server restart / be shared across instances.
const translationCache = new Map();
const MAX_CACHE_SIZE = 5000;

function cacheGet(key) {
  return translationCache.get(key);
}

function cacheSet(key, value) {
  if (translationCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = translationCache.keys().next().value;
    translationCache.delete(oldestKey);
  }
  translationCache.set(key, value);
}

function chunkTexts(texts) {
  const batches = [];
  let current = [];
  let currentChars = 0;

  for (const text of texts) {
    const len = text.length;
    if (
      current.length >= MAX_BATCH_SIZE ||
      currentChars + len > MAX_BATCH_CHARS
    ) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(text);
    currentChars += len;
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * Translates a list of strings (deduped + cached) via Google Translate.
 * Returns Map<originalText, translatedText>.
 */
async function batchTranslate(texts, targetLang, sourceLang = "en") {
  if (!API_KEY) {
    throw new Error("GOOGLE_TRANSLATE_API_KEY is not configured");
  }

  const uniqueTexts = [...new Set(texts.filter((t) => t && t.trim()))];
  const result = new Map();
  const toFetch = [];

  for (const text of uniqueTexts) {
    const cached = cacheGet(`${targetLang}::${text}`);
    if (cached !== undefined) {
      result.set(text, cached);
    } else {
      toFetch.push(text);
    }
  }

  if (toFetch.length === 0) return result;

  for (const batch of chunkTexts(toFetch)) {
    const params = new URLSearchParams();
    params.append("key", API_KEY);
    params.append("target", targetLang);
    params.append("source", sourceLang);
    params.append("format", "text");
    batch.forEach((t) => params.append("q", t));

    const response = await fetch(GOOGLE_TRANSLATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(
        `Google Translate API error (${response.status}): ${errBody}`,
      );
    }

    const data = await response.json();
    const translations = data?.data?.translations || [];

    translations.forEach((t, idx) => {
      const original = batch[idx];
      const translated = t.translatedText;
      result.set(original, translated);
      cacheSet(`${targetLang}::${original}`, translated);
    });
  }

  return result;
}

module.exports = { batchTranslate };
