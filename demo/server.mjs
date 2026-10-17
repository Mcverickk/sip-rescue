// SIP Rescue demo server: static site, streaming voice-agent endpoints, mocked Bachatt internal APIs.
import "./env.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sarvamEnabled, stt, tts, ttsPath, languageOfText, LANGUAGES, NATIVE } from "./sarvam.mjs";
import { api, fixture, reset, snapshot } from "./mockApi.mjs";
import { startSession, turn, endCallManually, engineName, claudeReady, currentLang } from "./agent.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5173);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".wav": "audio/wav" };

const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
async function readBody(req) { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks); }
async function readJson(req) { const b = await readBody(req); return b.length ? JSON.parse(b.toString("utf8")) : {}; }

// Streams one conversational turn to the browser as newline-delimited JSON.
// Sentences are voiced in parallel but delivered in order, each with its audio URL.
async function streamTurn(res, makeInput) {
  res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
  const t0 = Date.now();
  const write = (o) => res.write(JSON.stringify({ ...o, ms: Date.now() - t0 }) + "\n");
  let chain = Promise.resolve();
  const emit = (ev) => {
    if (ev.type === "sentence") {
      const lang = languageOfText(ev.text, currentLang());
      const audio = sarvamEnabled() ? tts(ev.text, lang).then((id) => `/api/audio/${id}.wav`).catch((e) => (console.error("[tts]", e.message), null)) : Promise.resolve(null);
      chain = chain.then(async () => write({ type: "say", text: ev.text, lang, audio: await audio }));
    } else if (ev.type === "action") {
      write({ type: "action", tool: ev.tool, input: ev.input, result: ev.result, state: snapshot() });
    } else {
      chain = chain.then(() => write(ev));
    }
  };
  try {
    const input = await makeInput(write);
    if (input) await turn(input, emit);
  } catch (err) {
    console.error("[turn]", err.message);
    chain = chain.then(() => write({ type: "error", message: friendlyError(err) }));
  }
  await chain;
  write({ type: "state", state: snapshot() });
  write({ type: "done" });
  res.end();
}
function friendlyError(err) {
  const m = String(err?.message || err);
  if (/workspace/i.test(m)) return "Claude needs a workspace ID. Add ANTHROPIC_WORKSPACE_ID to demo/.env.local and restart.";
  if (/api.?key|auth|401/i.test(m)) return "Claude key was rejected. Check ANTHROPIC_API_KEY in demo/.env.local.";
  return "Sia lost the connection for a moment. Please say that again.";
}

const routes = {
  "GET /api/config": () => ({ fixture, engine: engineName(), claude: claudeReady(), sarvam: sarvamEnabled(), languages: Object.entries(LANGUAGES).map(([code, name]) => ({ code, name, native: NATIVE[code] })) }),
  "GET /api/state": () => snapshot(),
  "POST /api/reset": () => { reset(); startSession(); return snapshot(); },
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
    // Call opens: Murari says "Hello?" and Sia greets him (in Hindi; she follows his language after).
    if (key === "POST /api/call/start") {
      startSession();
      return streamTurn(res, async () => ({ text: "Hello?", lang: "hi-IN" }));
    }
    // Murari speaks: Sarvam transcribes and detects the language, then Claude answers in it.
    if (key === "POST /api/call/voice") {
      const audio = await readBody(req);
      return streamTurn(res, async (write) => {
        const heard = await stt(audio, req.headers["content-type"]);
        write({ type: "heard", ...heard });
        if (!heard.transcript) { write({ type: "nothing" }); return null; }
        return { text: heard.transcript, lang: heard.language_code };
      });
    }
    // Typed fallback: language comes from the script typed (Latin keeps the current language).
    if (key === "POST /api/call/text") {
      const { text } = await readJson(req);
      return streamTurn(res, async (write) => {
        const scriptLang = languageOfText(String(text || ""), currentLang());
        const lang = scriptLang === "en-IN" ? currentLang() : scriptLang;
        write({ type: "heard", transcript: String(text || ""), language_code: lang, language: LANGUAGES[lang], native: NATIVE[lang], typed: true });
        return { text: String(text || ""), lang };
      });
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
    if (!res.headersSent) send(res, 500, { error: err.message });
    else res.end();
  }
});

server.listen(PORT, () => {
  const ws = process.env.ANTHROPIC_WORKSPACE_ID ? "set" : "MISSING";
  console.log(`SIP Rescue demo on http://localhost:${PORT}  (brain: ${engineName()}${claudeReady() ? "" : " - no key"}, workspace id: ${ws}, voice: ${sarvamEnabled() ? "Sarvam" : "browser"})`);
});
