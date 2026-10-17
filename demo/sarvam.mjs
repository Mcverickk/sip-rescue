// Sarvam AI client: text-to-speech (bulbul:v3), speech-to-text (saaras:v3) and translation
// (mayura:v1). Results are cached on disk so the stage demo replays instantly.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { LANGS, LINES, CHIPS, SMS, langById } from "./lines.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// Minimal .env loader (no dependency): demo/.env holds SARVAM_API_KEY.
const envFile = path.join(here, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const KEY = () => process.env.SARVAM_API_KEY;
export const sarvamEnabled = () => Boolean(KEY());
export const SPEAKER = process.env.SARVAM_SPEAKER || "priya";
const BASE = "https://api.sarvam.ai";

const cacheDir = path.join(here, ".cache");
const ttsDir = path.join(cacheDir, "tts");
fs.mkdirSync(ttsDir, { recursive: true });
const trFile = path.join(cacheDir, "translations.json");
const trCache = fs.existsSync(trFile) ? JSON.parse(fs.readFileSync(trFile, "utf8")) : {};
const saveTr = () => fs.writeFileSync(trFile, JSON.stringify(trCache, null, 1));
const hash = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

async function call(pathname, init) {
  const res = await fetch(BASE + pathname, { ...init, headers: { "api-subscription-key": KEY(), ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`Sarvam ${pathname} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// ------------------------------------------------------------------ translate

export async function translate(text, langId) {
  const lang = langById(langId);
  const k = `${lang.code}|${text}`;
  if (trCache[k]) return trCache[k];
  const d = await call("/translate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: text, source_language_code: "en-IN", target_language_code: lang.code, model: "mayura:v1", mode: "modern-colloquial", speaker_gender: "Female", numerals_format: "international" }),
  });
  trCache[k] = d.translated_text;
  saveTr();
  return d.translated_text;
}

// Text for display (caption) and for speech, for any entry of LINES / CHIPS / SMS.
export async function render(entry, langId) {
  if (langId === "hinglish") return { text: entry.hinglish, speak: entry.hi };
  if (langId === "hi") return { text: entry.hi, speak: entry.hi };
  if (langId === "en") return { text: entry.en, speak: entry.en };
  const t = await translate(entry.en, langId);
  return { text: t, speak: t };
}

// ------------------------------------------------------------------ text to speech

const inflight = new Map();
export function ttsId(text, langId) {
  return hash(`${SPEAKER}|${langById(langId).code}|${text}`);
}
export function ttsPath(id) {
  return path.join(ttsDir, `${id}.wav`);
}
export async function tts(text, langId) {
  const id = ttsId(text, langId);
  const file = ttsPath(id);
  if (fs.existsSync(file)) return id;
  if (inflight.has(id)) return inflight.get(id);
  const p = (async () => {
    const d = await call("/text-to-speech", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, language_code: langById(langId).code, model: "bulbul:v3", speaker: SPEAKER, pace: 1.05, speech_sample_rate: 22050 }),
    });
    fs.writeFileSync(file, Buffer.from(d.audios.join(""), "base64"));
    return id;
  })().finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

// ------------------------------------------------------------------ speech to text

async function sttOnce(buf, mime, code, mode) {
  const form = new FormData();
  mime = (mime || "audio/webm").split(";")[0];
  form.append("file", new Blob([buf], { type: mime }), mime.includes("wav") ? "speech.wav" : "speech.webm");
  form.append("model", "saaras:v3");
  form.append("language_code", code);
  form.append("mode", mode);
  const d = await call("/speech-to-text", { method: "POST", body: form });
  return d.transcript || "";
}

// Returns the caption in the user's language plus an English version for intent matching.
export async function stt(buf, mime, langId) {
  const lang = langById(langId);
  if (lang.id === "en") {
    const t = await sttOnce(buf, mime, "en-IN", "transcribe");
    return { transcript: t, english: t };
  }
  const [transcript, english] = await Promise.all([
    sttOnce(buf, mime, lang.code, lang.sttMode),
    sttOnce(buf, mime, lang.code, "translate"),
  ]);
  return { transcript, english };
}

// ------------------------------------------------------------------ warm-up per language

const prepared = new Map();
export function prepareLanguage(langId, onProgress = () => {}) {
  if (!sarvamEnabled()) return Promise.resolve({ ok: false, reason: "no key" });
  if (prepared.has(langId)) return prepared.get(langId);
  const p = (async () => {
    const lineEntries = Object.values(LINES);
    const chipEntries = Object.values(CHIPS).flat();
    const smsEntries = Object.values(SMS);
    const total = lineEntries.length * 2 + chipEntries.length + smsEntries.length;
    let done = 0;
    const tick = () => onProgress(++done, total);
    const pool = async (items, fn, n = 4) => {
      const q = [...items];
      await Promise.all(Array.from({ length: n }, async () => { while (q.length) await fn(q.shift()); }));
    };
    const rendered = [];
    await pool([...lineEntries, ...chipEntries, ...smsEntries], async (e) => {
      const r = await render(e, langId);
      if (lineEntries.includes(e)) rendered.push(r);
      tick();
    });
    await pool(rendered, async (r) => { await tts(r.speak, langId); tick(); }, 3);
    return { ok: true };
  })().catch((err) => { prepared.delete(langId); throw err; });
  prepared.set(langId, p);
  return p;
}

export { LANGS };
