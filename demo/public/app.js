// SIP Rescue demo front end. Browser speech in and out, server-side agent, mocked APIs.
const $ = (id) => document.getElementById(id);
const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }).then((r) => r.json());

let fixture;
let inCall = false, busy = false, ended = false;
let callStart = 0, timerHandle = null;
let seenLog = 0, seenSms = 0;
let rungState = {};

// ------------------------------------------------------------------ boot

async function boot() {
  const r = await fetch("/api/fixture").then((x) => x.json());
  fixture = r.fixture;
  const engine = $("engine");
  engine.textContent = r.engine;
  if (r.engine === "Scripted") { engine.classList.add("scripted"); engine.title = "Set ANTHROPIC_API_KEY and restart to use Claude"; }

  const latest = fixture.balance_sms.at(-1);
  $("smsBody").innerHTML = latest.body.replace("AvlBal:Rs149.54", "<mark>AvlBal:Rs149.54</mark>");
  $("decisionReason").textContent = fixture.decision.reason;
  $("history").innerHTML = fixture.debit_history.map((d) => {
    const day = new Date(d.debit_date + "T00:00:00").getDate();
    const cls = d.status === "SUCCESS" ? "ok" : d.status === "FAILED" ? "fail" : "next";
    const icon = d.status === "SUCCESS" ? "✓" : d.status === "FAILED" ? "✗" : "?";
    const label = d.status === "SCHEDULED" ? "tmrw" : `${day} Oct`;
    return `<div class="day ${cls}" title="${d.failure_reason || d.status}"><b>${icon}</b>${label}</div>`;
  }).join("");

  setupVoices();
  await resetDemo();
  tickClock();
  setInterval(tickClock, 1000);
}

function tickClock() {
  const secs = Math.floor((Date.now() - (window.__demoT0 ??= Date.now())) / 1000);
  const m = 0 + Math.floor(secs / 60), s = secs % 60;
  $("clock").textContent = `Mon 13 Oct 2026 · 19:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")} IST`;
}

async function resetDemo() {
  stopListening(); speechSynthesis.cancel();
  const st = await post("/api/reset");
  inCall = false; busy = false; ended = false; seenLog = 0; seenSms = 0; rungState = {};
  clearInterval(timerHandle); $("timer").textContent = "00:00";
  document.querySelectorAll(".step").forEach((s) => s.classList.remove("on"));
  $("scanBtn").disabled = false; $("startBtn").disabled = true;
  $("transcript").innerHTML = `<div class="empty">Run the scan, then start the voice agent. Speak in Hindi, English or Hinglish, or tap a reply below.</div>`;
  $("log").innerHTML = `<div class="muted small">The agent's tool calls appear here with full request and response.</div>`;
  $("smsOut").innerHTML = `<div class="muted small">None yet</div>`;
  $("outcome").hidden = true;
  setCallUi(false);
  setStatus("idle");
  renderRungs();
  renderChips(null);
  renderState(st);
}

// ------------------------------------------------------------------ scan

async function runScan() {
  $("scanBtn").disabled = true;
  const steps = [...document.querySelectorAll(".step")];
  for (const s of steps) {
    s.classList.add("on");
    s.scrollIntoView({ block: "nearest", behavior: "smooth" });
    await sleep(650);
  }
  $("startBtn").disabled = false;
}

// ------------------------------------------------------------------ call

async function startCall() {
  $("startBtn").disabled = true;
  if (!$("transcript").querySelector(".msg")) $("transcript").innerHTML = "";
  inCall = true; ended = false;
  setCallUi(true);
  setStatus("ringing…");
  callStart = Date.now();
  timerHandle = setInterval(() => {
    const s = Math.floor((Date.now() - callStart) / 1000);
    $("timer").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }, 500);
  await sleep(900);
  addMsg("user", "Hello?");
  setStatus("live", true);
  await handleReply(post("/api/call/start"));
}

async function say(text) {
  if (!inCall || ended || busy || !text.trim()) return;
  stopListening();
  addMsg("user", text.trim());
  await handleReply(post("/api/call/turn", { text: text.trim() }));
}

async function handleReply(promise) {
  busy = true;
  setCallUi(true);
  const thinking = addMsg("agent", "…", "interim");
  let r;
  try { r = await promise; } catch (e) { r = { error: e.message }; }
  thinking.remove();
  busy = false;
  if (r.error) { addMsg("tool", "error: " + r.error); setCallUi(true); return; }
  if (r.engine === "scripted" && r.fallbackReason && !window.__warned) {
    window.__warned = true;
    addMsg("tool", "Claude unavailable, continuing with the scripted agent");
  }
  if (r.say) addMsg("agent", r.say);
  for (const a of r.actions || []) {
    if (a.tool === "end_call") continue;
    addMsg("tool", `⚙ ${a.tool}(${JSON.stringify(a.input)}) → ${a.result.ok === false ? "error" : "ok"}`);
    markRung(a.tool);
  }
  detectOffer(r.say || "");
  renderState(r.state);
  if (r.ended) ended = true;
  setCallUi(true);
  await speak(r.say || "");
  if (ended) finishCall(r.state);
  else if ($("handsFree").checked) startListening();
}

function finishCall(state) {
  inCall = false;
  clearInterval(timerHandle);
  setStatus("call ended");
  setCallUi(false);
  renderChips(null);
  const o = state?.outcome;
  if (!o) return;
  const titles = {
    TOPUP_COMMITTED: "Top-up committed", SIP_REDUCED: "SIP lowered, not lost", BANK_CHANGE_LINK_SENT: "Moving to a new bank",
    SIP_PAUSED: "SIP paused, not cancelled", SIP_CANCELLED: "SIP cancelled", CALLBACK_SCHEDULED: "Callback scheduled",
    NO_CHANGE: "No change", WRONG_PERSON: "Wrong person",
  };
  $("outcomeTitle").textContent = titles[o.outcome] || o.outcome;
  $("outcomeSum").textContent = o.summary;
  const apiCalls = state.log.filter((l) => !l.path.includes("call-outcomes")).length;
  $("outcomeStats").innerHTML = [
    [$("timer").textContent, "call length"],
    [apiCalls, "API calls"],
    [state.sms.length, "SMS sent"],
  ].map(([b, s]) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`).join("");
  setTimeout(() => ($("outcome").hidden = false), 600);
}

async function endCall() {
  speechSynthesis.cancel(); stopListening();
  const st = await post("/api/call/end");
  ended = true; renderState(st); finishCall(st);
}

// ------------------------------------------------------------------ ladder + chips

const CHIPS = {
  start: ["Haan, boliye", "Abhi busy hoon, baad mein call karo"],
  topup: ["Haan, aaj raat 500 daal dunga", "Abhi paise nahi hain, salary 1 tareekh ko aayegi"],
  reduce: ["Haan, 50 rupaye kar do", "Nahi, amount kam nahi karna"],
  bank: ["Haan, mera SBI account hai", "Nahi, doosra account nahi hai"],
  pause: ["Haan, 15 din pause kar do", "Nahi, mujhe SIP band karna hai"],
};
let currentOffer = null;

function detectOffer(text) {
  const t = text.toLowerCase();
  let offer = null;
  if (/pause/.test(t)) offer = "pause";
  else if (/(doosr|dusr|another|other|kisi aur).{0,30}(bank|account|khat)|(bank|account).{0,30}(doosr|dusr|another|other|shift)/.test(t)) offer = "bank";
  else if (/\b50\b/.test(t)) offer = "reduce";
  else if (/\b500\b/.test(t)) offer = "topup";
  else if (!currentOffer) offer = "start";
  if (offer) currentOffer = offer;
  if (offer && offer !== "start") { rungState[offer] = rungState[offer] || "offered"; renderRungs(); }
  renderChips(ended ? null : currentOffer);
}
function markRung(tool) {
  const map = { send_topup_link: "topup", reduce_sip_amount: "reduce", change_bank_account: "bank", pause_sip: "pause" };
  if (map[tool]) { rungState[map[tool]] = "done"; renderRungs(); }
}
function renderRungs() {
  document.querySelectorAll(".rung").forEach((r) => { r.className = "rung " + (rungState[r.dataset.rung] || ""); });
}
function renderChips(stage) {
  currentOffer = stage === null ? null : currentOffer;
  $("chips").innerHTML = (CHIPS[stage] || []).map((c) => `<button class="chip">${c}</button>`).join("");
  $("chips").querySelectorAll(".chip").forEach((b) => (b.onclick = () => say(b.textContent)));
}

// ------------------------------------------------------------------ rendering

function addMsg(kind, text, extra = "") {
  const el = document.createElement("div");
  el.className = `msg ${kind} ${extra}`;
  if (kind === "tool") el.textContent = text;
  else el.innerHTML = `<div class="who">${kind === "agent" ? "Sia (agent)" : "Murari"}</div>${escapeHtml(text)}`;
  $("transcript").appendChild(el);
  $("transcript").scrollTop = $("transcript").scrollHeight;
  return el;
}

function renderState(st) {
  if (!st) return;
  $("plans").innerHTML = [...st.plans].reverse().map((p, i) => `
    <div class="plan ${i === 0 && st.plans.length > 1 ? "flash" : ""}">
      <div class="plan-top"><span class="plan-amt">₹${p.amount_inr} <span class="muted small">/ day</span></span><span class="status ${p.status}">${p.status}</span></div>
      <div class="plan-meta">${p.sip_plan_id} · ${p.plan_type}${p.replaces_sip_plan_id ? " · replaces …" + p.replaces_sip_plan_id.slice(-6) : ""}</div>
      <div class="plan-meta">${p.status === "PAUSED" ? `paused · resumes ${p.resumes_on}` : p.status === "CANCELLED" ? `cancelled · ${p.cancellation_reason}` : p.status === "INITIATED" ? "awaiting AutoPay approval on new bank" : `${p.basket_name} · next debit 2026-10-14`}</div>
    </div>`).join("");
  setTimeout(() => document.querySelectorAll(".plan.flash").forEach((e) => e.classList.remove("flash")), 1500);

  if (st.sms.length && st.sms.length !== seenSms) {
    $("smsOut").innerHTML = st.sms.map((m) => `<div class="sms"><div class="sms-from">${m.sender} → ${m.to} · ${m.at.slice(11, 16)}</div>${escapeHtml(m.text)}</div>`).join("");
    seenSms = st.sms.length;
  }
  if (st.log.length && st.log.length !== seenLog) {
    if (seenLog === 0) $("log").innerHTML = "";
    for (const e of st.log.slice(seenLog)) {
      const d = document.createElement("details");
      d.className = "call-entry";
      d.open = true;
      d.innerHTML = `<summary><span class="method">${e.method}</span><span class="path" title="${e.path}">${e.path}</span><span class="code ${e.status < 300 ? "ok" : "err"}">${e.status}</span></summary>
        <div class="pre-label">request · ${e.at.slice(11)}</div><pre>${escapeHtml(JSON.stringify(e.request, null, 2))}</pre>
        <div class="pre-label">response</div><pre>${escapeHtml(JSON.stringify(e.response, null, 2))}</pre>`;
      $("log").prepend(d);
      [...$("log").children].slice(2).forEach((x) => (x.open = false));
    }
    seenLog = st.log.length;
  }
}

function setCallUi(live) {
  const canTalk = live && inCall && !ended && !busy;
  $("micBtn").disabled = !canTalk || !Recognition;
  $("textIn").disabled = !canTalk;
  $("sendBtn").disabled = !canTalk;
  $("endBtn").disabled = !(inCall && !ended);
  $("chips").querySelectorAll(".chip").forEach((c) => (c.disabled = !canTalk));
}
function setStatus(text, live = false) {
  $("callStatus").textContent = text;
  $("callStatus").classList.toggle("live", live);
}

// ------------------------------------------------------------------ speech out

let voice = null;
function setupVoices() {
  const fill = () => {
    const all = speechSynthesis.getVoices();
    const ranked = [
      ...all.filter((v) => v.lang === "en-IN"),
      ...all.filter((v) => v.lang === "hi-IN"),
      ...all.filter((v) => v.lang.startsWith("en") && v.lang !== "en-IN"),
    ];
    if (!ranked.length) return;
    const sel = $("voiceSel");
    sel.innerHTML = ranked.slice(0, 25).map((v, i) => `<option value="${i}">${v.name} (${v.lang})</option>`).join("");
    const female = ranked.findIndex((v) => v.lang === "en-IN" && /veena|female|heera|neerja|google/i.test(v.name));
    sel.value = String(female >= 0 ? female : 0);
    voice = ranked[Number(sel.value)];
    sel.onchange = () => (voice = ranked[Number(sel.value)]);
  };
  fill();
  speechSynthesis.onvoiceschanged = fill;
}

function speak(text) {
  return new Promise((resolve) => {
    if (!$("speakOut").checked || !text.trim() || !("speechSynthesis" in window)) return resolve();
    speechSynthesis.cancel();
    const parts = text.match(/[^.!?।]+[.!?।]?/g) || [text];
    let i = 0;
    $("agentAv").classList.add("speaking");
    const next = () => {
      if (i >= parts.length) { $("agentAv").classList.remove("speaking"); return resolve(); }
      const u = new SpeechSynthesisUtterance(parts[i++].trim());
      if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = "en-IN";
      u.rate = 1.02;
      u.onend = next;
      u.onerror = next;
      speechSynthesis.speak(u);
    };
    next();
  });
}

// ------------------------------------------------------------------ speech in

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, listening = false, interimEl = null;

function startListening() {
  if (!Recognition || !inCall || ended || busy || listening) return;
  rec = new Recognition();
  rec.lang = "en-IN";
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  let finalText = "";
  rec.onresult = (ev) => {
    let interim = "";
    for (const res of ev.results) (res.isFinal ? (finalText = res[0].transcript) : (interim += res[0].transcript));
    if (!interimEl) interimEl = addMsg("user", "", "interim");
    interimEl.lastChild.textContent = finalText || interim;
  };
  rec.onend = () => {
    listening = false;
    $("micBtn").classList.remove("on");
    $("agentAv").classList.remove("listening");
    interimEl?.remove(); interimEl = null;
    if (finalText.trim()) say(finalText);
  };
  rec.onerror = () => {};
  try {
    rec.start();
    listening = true;
    $("micBtn").classList.add("on");
    $("agentAv").classList.add("listening");
  } catch { listening = false; }
}
function stopListening() {
  if (rec && listening) { try { rec.abort(); } catch {} }
  listening = false;
  $("micBtn")?.classList.remove("on");
  $("agentAv")?.classList.remove("listening");
}

// ------------------------------------------------------------------ wiring

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }

$("scanBtn").onclick = runScan;
$("startBtn").onclick = startCall;
$("endBtn").onclick = endCall;
$("resetBtn").onclick = resetDemo;
$("outcomeClose").onclick = () => ($("outcome").hidden = true);
$("micBtn").onclick = () => (listening ? stopListening() : startListening());
$("textForm").onsubmit = (e) => { e.preventDefault(); const v = $("textIn").value; $("textIn").value = ""; say(v); };
if (!Recognition) $("micBtn").title = "Speech recognition needs Chrome or Edge. Use the text box or reply chips.";

boot();
