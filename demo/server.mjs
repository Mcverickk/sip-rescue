// SIP Rescue demo server: static site, agent + voice endpoints, mocked Bachatt internal APIs.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sarvamEnabled, prepareLanguage, render, stt, tts, ttsPath, SPEAKER } from "./sarvam.mjs";
import { LANGS, CHIPS, langById } from "./lines.mjs";
import { api, fixture, reset, snapshot } from "./mockApi.mjs";
import { startCall, turn, endCallManually, engineName, currentLang } from "./agent.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5173);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".wav": "audio/wav" };

const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
async function readBody(req) { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks); }
async function readJson(req) { const b = await readBody(req); return b.length ? JSON.parse(b.toString("utf8")) : {}; }

// Language warm-up progress, polled by the UI while it shows the "getting ready" screen.
const progress = {};
function prepare(lang) {
  progress[lang] ??= { done: 0, total: 1, ready: false, error: null };
  prepareLanguage(lang, (done, total) => Object.assign(progress[lang], { done, total }))
    .then(() => Object.assign(progress[lang], { ready: true }))
    .catch((e) => Object.assign(progress[lang], { error: e.message }));
  return progress[lang];
}

async function chipsFor(lang) {
  const out = {};
  for (const [stage, list] of Object.entries(CHIPS)) out[stage] = await Promise.all(list.map(async (c) => ({ text: (await render(c, lang)).text, en: c.en })));
  return out;
}

// Speak a reply: make sure Sarvam audio exists and hand back its URL (null = browser voice fallback).
async function withAudio(r, lang) {
  if (!sarvamEnabled() || !r.speak) return { ...r, audio: null };
  try { return { ...r, audio: `/api/audio/${await tts(r.speak, lang)}.wav` }; }
  catch (e) { console.error("[tts]", e.message); return { ...r, audio: null, ttsError: e.message }; }
}

const routes = {
  "GET /api/config": () => ({ fixture, engine: engineName(), voice: sarvamEnabled() ? `Sarvam (${SPEAKER})` : "Browser", sarvam: sarvamEnabled(), langs: LANGS.map(({ id, label, english }) => ({ id, label, english })) }),
  "GET /api/state": () => snapshot(),
  "POST /api/reset": () => { reset(); return snapshot(); },
  "POST /api/lang/prepare": (b) => ({ lang: langById(b.lang).id, ...prepare(langById(b.lang).id) }),
  "POST /api/lang/progress": (b) => progress[langById(b.lang).id] ?? { done: 0, total: 1, ready: false },
  "POST /api/chips": async (b) => chipsFor(langById(b.lang).id),
  "POST /api/call/start": async (b) => { const lang = langById(b.lang).id; return { ...(await withAudio(await startCall(lang), lang)), state: snapshot() }; },
  "POST /api/call/turn": async (b) => ({ ...(await withAudio(await turn(String(b.text || ""), b.english ? String(b.english) : ""), currentLang())), state: snapshot() }),
  "POST /api/call/end": () => { endCallManually(); return snapshot(); },
};

const internal = [
  [/^POST \/internal\/v1\/users\/\d+\/topup-link$/, (b) => api.topupLink(b)],
  [/^POST \/internal\/v1\/sips\/\d+\/modify$/, (b) => api.reduceSip(b)],
  [/^POST \/internal\/v1\/sips\/\d+\/change-bank$/, (b) => api.changeBank(b)],
  [/^POST \/internal\/v1\/sips\/\d+\/pause$/, (b) => api.pauseSip(b)],
  [/^POST \/internal\/v1\/sips\/\d+\/cancel$/, (b) => api.cancelSip(b)],
  [/^POST \/internal\/v1\/callbacks$/, (b) => api.scheduleCallback(b)],
  [/^GET \/internal\/v1\/users\/\d+\/sips$/, () => ({ sips: snapshot().plans })],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const key = `${req.method} ${url.pathname}`;
  try {
    if (key === "POST /api/stt") {
      if (!sarvamEnabled()) return send(res, 503, { error: "Sarvam key not set" });
      const audio = await readBody(req);
      const t0 = Date.now();
      const r = await stt(audio, req.headers["content-type"] || "audio/webm", langById(url.searchParams.get("lang")).id);
      return send(res, 200, { ...r, ms: Date.now() - t0 });
    }
    const audioMatch = /^GET \/api\/audio\/([0-9a-f]{16})\.wav$/.exec(key);
    if (audioMatch) {
      const f = ttsPath(audioMatch[1]);
      if (!fs.existsSync(f)) return send(res, 404, { error: "no audio" });
      res.writeHead(200, { "content-type": "audio/wav", "cache-control": "public, max-age=86400" });
      return fs.createReadStream(f).pipe(res);
    }
    if (routes[key]) return send(res, 200, await routes[key](req.method === "POST" ? await readJson(req) : {}));
    const hit = internal.find(([rx]) => rx.test(key));
    if (hit) return send(res, 200, hit[1](req.method === "POST" ? await readJson(req) : {}));

    const file = path.join(here, "public", url.pathname === "/" ? "index.html" : url.pathname);
    if (!file.startsWith(path.join(here, "public")) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, { error: "not found" });
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    console.error(err);
    send(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`SIP Rescue demo on http://localhost:${PORT}  (brain: ${engineName()}, voice: ${sarvamEnabled() ? "Sarvam" : "browser"})`);
  if (sarvamEnabled()) for (const l of ["hinglish", "hi"]) prepare(l); // warm the default languages
});
