// SIP Rescue demo server: static site + agent endpoints + mocked Bachatt internal APIs.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { api, fixture, reset, snapshot } from "./mockApi.mjs";
import { startCall, turn, endCallManually, engineName } from "./agent.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5173);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

const routes = {
  "GET /api/fixture": () => ({ fixture, engine: engineName() }),
  "GET /api/state": () => snapshot(),
  "POST /api/reset": () => { reset(); return snapshot(); },
  "POST /api/call/start": async () => ({ ...(await startCall()), state: snapshot() }),
  "POST /api/call/turn": async (body) => ({ ...(await turn(String(body.text || ""))), state: snapshot() }),
  "POST /api/call/end": () => { endCallManually(); return snapshot(); },
};

// The same mocked internal APIs, reachable over HTTP too (curl-able during the demo).
const sipId = () => snapshot().plans.at(-1).sip_plan_id;
const internal = [
  [/^POST \/internal\/v1\/users\/\d+\/topup-link$/, (b) => api.topupLink(b)],
  [/^POST \/internal\/v1\/sips\/\d+\/modify$/, (b) => api.reduceSip(b)],
  [/^POST \/internal\/v1\/sips\/\d+\/change-bank$/, (b) => api.changeBank(b)],
  [/^POST \/internal\/v1\/sips\/\d+\/pause$/, (b) => api.pauseSip(b)],
  [/^POST \/internal\/v1\/sips\/\d+\/cancel$/, (b) => api.cancelSip(b)],
  [/^POST \/internal\/v1\/callbacks$/, (b) => api.scheduleCallback(b)],
  [/^GET \/internal\/v1\/users\/\d+\/sips$/, () => ({ sips: snapshot().plans, active_sip_plan_id: sipId() })],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const key = `${req.method} ${url.pathname}`;
  try {
    if (routes[key]) return send(res, 200, await routes[key](req.method === "POST" ? await readJson(req) : {}));
    const hit = internal.find(([rx]) => rx.test(key));
    if (hit) return send(res, 200, hit[1](req.method === "POST" ? await readJson(req) : {}));

    const file = path.join(here, "public", url.pathname === "/" ? "index.html" : url.pathname);
    if (!file.startsWith(path.join(here, "public")) || !fs.existsSync(file)) return send(res, 404, { error: "not found" });
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    console.error(err);
    send(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`SIP Rescue demo on http://localhost:${PORT}  (agent engine: ${engineName()})`);
});
