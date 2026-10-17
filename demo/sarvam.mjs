// Sarvam AI: speech-to-text with automatic language detection (saaras:v4) and fast text-to-speech
// (bulbul:v4-flash) with a warm, conversational female voice per language. Audio is cached on disk.
import "./env.mjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const KEY = () => process.env.SARVAM_API_KEY;
export const sarvamEnabled = () => Boolean(KEY());
const BASE = "https://api.sarvam.ai";
const PACE = Number(process.env.SARVAM_PACE || 1.12);

const ttsDir = path.join(here, ".cache", "tts");
fs.mkdirSync(ttsDir, { recursive: true });
const hash = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

export const LANGUAGES = {
  "hi-IN": "Hindi", "en-IN": "English", "bn-IN": "Bengali", "mr-IN": "Marathi", "ta-IN": "Tamil", "te-IN": "Telugu",
  "gu-IN": "Gujarati", "kn-IN": "Kannada", "ml-IN": "Malayalam", "pa-IN": "Punjabi", "od-IN": "Odia",
};
export const NATIVE = {
  "hi-IN": "हिन्दी", "en-IN": "English", "bn-IN": "বাংলা", "mr-IN": "मराठी", "ta-IN": "தமிழ்", "te-IN": "తెలుగు",
  "gu-IN": "ગુજરાતી", "kn-IN": "ಕನ್ನಡ", "ml-IN": "മലയാളം", "pa-IN": "ਪੰਜਾਬੀ", "od-IN": "ଓଡ଼ିଆ",
};

// Female customer-care / conversational personas (bulbul:v4-flash). Languages without one use bulbul:v3.
const VOICES = {
  "hi-IN": ["bulbul:v4-flash", "ishita_enhi_customer"], // Hindi + English code-mixed: ideal for Hinglish
  "en-IN": ["bulbul:v4-flash", "simran_en_conversation"],
  "bn-IN": ["bulbul:v4-flash", "roopa_bn_conversational"],
  "gu-IN": ["bulbul:v4-flash", "pooja_gu_customer"],
  "kn-IN": ["bulbul:v4-flash", "chaitra_kn_conversation"],
  "te-IN": ["bulbul:v4-flash", "kavitha_te_conversation"],
  "pa-IN": ["bulbul:v4-flash", "anand_pa_customer"],
  default: ["bulbul:v3", "priya"],
};
export const voiceFor = (code) => VOICES[code] || VOICES.default;

async function call(pathname, init) {
  const res = await fetch(BASE + pathname, { ...init, headers: { "api-subscription-key": KEY(), ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`Sarvam ${pathname} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// Which language is a piece of text written in? Used to pick the voice for each sentence Claude says.
const SCRIPTS = [
  [/[ঀ-৿]/, "bn-IN"], [/[਀-੿]/, "pa-IN"], [/[઀-૿]/, "gu-IN"], [/[଀-୿]/, "od-IN"],
  [/[஀-௿]/, "ta-IN"], [/[ఀ-౿]/, "te-IN"], [/[ಀ-೿]/, "kn-IN"], [/[ഀ-ൿ]/, "ml-IN"],
];
export function languageOfText(text, hint = "hi-IN") {
  for (const [rx, code] of SCRIPTS) if (rx.test(text)) return code;
  if (/[ऀ-ॿ]/.test(text)) return hint === "mr-IN" ? "mr-IN" : "hi-IN";
  return "en-IN";
}

// ------------------------------------------------------------------ text to speech

const inflight = new Map();
export const ttsPath = (id) => path.join(ttsDir, `${id}.wav`);
export async function tts(text, code) {
  const [model, speaker] = voiceFor(code);
  const id = hash(`${model}|${speaker}|${PACE}|${code}|${text}`);
  if (fs.existsSync(ttsPath(id))) return id;
  if (inflight.has(id)) return inflight.get(id);
  const p = (async () => {
    const d = await call("/text-to-speech", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, language_code: code, model, speaker, pace: PACE, speech_sample_rate: 24000 }),
    });
    fs.writeFileSync(ttsPath(id), Buffer.from(d.audios.join(""), "base64"));
    return id;
  })().finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

// ------------------------------------------------------------------ speech to text (auto language)

export async function stt(buf, mime) {
  mime = (mime || "audio/webm").split(";")[0];
  const form = new FormData();
  form.append("file", new Blob([buf], { type: mime }), mime.includes("wav") ? "speech.wav" : "speech.webm");
  form.append("model", "saaras:v4");
  form.append("language_code", "unknown");
  const d = await call("/speech-to-text", { method: "POST", body: form });
  const code = LANGUAGES[d.language_code] ? d.language_code : "hi-IN";
  return { transcript: (d.transcript || "").trim(), language_code: code, language: LANGUAGES[code], native: NATIVE[code], confidence: d.language_probability ?? null };
}

// Language of typed text (tells English apart from romanized Hindi like "haan boliye").
export async function textLanguage(text) {
  const d = await call("/text-lid", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: text }) });
  return LANGUAGES[d.language_code] ? d.language_code : null;
}
