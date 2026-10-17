// SIP Rescue front end: dark premium UI driving the real Claude + Sarvam backend.
const $ = (id) => document.getElementById(id);
const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

let cfg, phase = "lock";
let busy = false, ended = false, callT0 = 0, callTimer = null;
let seenLog = 0, seenSms = 0, lastLang = null;
let transcript = []; // {speaker:'agent'|'user', text, pending?}
const rung = {};

// ================================================================== boot

async function boot() {
  cfg = await fetch("/api/config").then((r) => r.json());
  $("voiceTag").textContent = `Voice: ${cfg.sarvam ? "Sarvam AI" : "browser"}`;
  $("brainTag").textContent = `Brain: ${cfg.claude ? "Claude" : "Claude · no key"}`;
  $("langs").innerHTML = cfg.languages.map((l) => `<span class="lang" data-code="${l.code}" title="${l.name}">${l.native}</span>`).join("");
  renderCheckRows();
  await resetAll();
}

function showLanguage(code) {
  const l = cfg.languages.find((x) => x.code === code);
  if (!l) return;
  lastLang = l;
  $("langs").querySelectorAll(".lang").forEach((b) => b.classList.toggle("on", b.dataset.code === code));
  $("heardLang").hidden = false;
  $("heardLangName").textContent = l.code === "en-IN" ? "English" : `${l.native} · ${l.name}`;
  $("convoLang").textContent = l.code === "en-IN" ? "English" : l.name;
}

// ================================================================== left column: tonight's check

function renderCheckRows() {
  const f = cfg.fixture;
  const balance = Math.round(f.latest_balance.balance_inr);
  const shortfall = Math.max(0, Math.round(f.bank.min_balance_floor_inr - f.latest_balance.balance_inr));
  const rows = [
    ["SIP due", `Tomorrow, 8 am · ₹${f.sip.amount_inr}`, false],
    [`Balance in ••${f.bank.acct_last4}`, `₹${balance}`, false],
    ["Shortfall to stay safe", `₹${shortfall}`, true],
    ["Last 2 debits", "Failed · balance too low", true],
  ];
  $("checkRows").innerHTML = rows.map(([label, value, danger]) => `<div class="check-row${danger ? " danger" : ""}"><span>${label}</span><b>${value}</b></div>`).join("");
}

async function runCheck() {
  $("checkBtn").disabled = true;
  $("checkCard").hidden = false;
  await sleep(120);
  for (const row of $("checkRows").children) {
    row.classList.add("in");
    await sleep(650);
  }
  await sleep(300);
  $("checkBtn").hidden = true;
  $("dangerCallout").hidden = false;
  await sleep(200);
  $("callBtn").hidden = false;
  setStep(2);
}
function setStep(n) {
  document.querySelectorAll(".step").forEach((s) => {
    const k = Number(s.dataset.step);
    s.classList.toggle("on", k === n);
    s.classList.toggle("done", k < n);
  });
}

// ================================================================== center column: the call

let ringCtx = null, ringStop = false;
async function ringtone() {
  ringStop = false;
  try { ringCtx ??= new AudioContext(); } catch { return; }
  while (!ringStop) {
    for (let i = 0; i < 2 && !ringStop; i++) {
      const o1 = ringCtx.createOscillator(), o2 = ringCtx.createOscillator(), g = ringCtx.createGain();
      o1.frequency.value = 440; o2.frequency.value = 480; g.gain.value = 0.05;
      o1.connect(g); o2.connect(g); g.connect(ringCtx.destination);
      o1.start(); o2.start(); await sleep(400); o1.stop(); o2.stop(); await sleep(200);
    }
    await sleep(1200);
  }
}

let greeting = null; // Sia's greeting is prepared while the phone rings, so she speaks the moment he answers
function callMurari() {
  $("callBtn").hidden = true;
  $("convoCard").hidden = false;
  setPhase("incoming");
  greeting = fetch("/api/call/start", { method: "POST" });
  ringtone();
}

async function answer() {
  ringStop = true;
  setPhase("call");
  ended = false;
  callT0 = Date.now();
  callTimer = setInterval(() => { const s = Math.floor((Date.now() - callT0) / 1000); $("callTime").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }, 500);
  getCtx().resume().catch(() => {}); // unlock audio on this click
  micReady = ensureMic();             // don't block the call on the permission prompt
  pushUser("Hello?");
  await runTurn(greeting || fetch("/api/call/start", { method: "POST" }));
  greeting = null;
}

function decline() {
  ringStop = true;
  greeting = null;
  setPhase("lock");
  $("callBtn").hidden = false;
  $("convoCard").hidden = true;
}

// Plays one streamed turn: captions and audio arrive sentence by sentence.
async function runTurn(responsePromise, { fromVoice = false } = {}) {
  busy = true;
  setInputs(false);
  $("phone").classList.add("thinking");
  let agentStarted = false, gotHeard = !fromVoice, error = null, sawEnd = false, finalState = null;
  let playing = Promise.resolve();
  const enqueue = (item) => { playing = playing.then(() => playItem(item)); };

  try {
    const res = await responsePromise;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        switch (ev.type) {
          case "heard":
            gotHeard = true;
            resolvePendingUser(ev.transcript || "");
            if (ev.language_code) showLanguage(ev.language_code);
            break;
          case "nothing":
            resolvePendingUser("");
            break;
          case "stage": updateLadder(ev.stage); break;
          case "say":
            $("phone").classList.remove("thinking");
            if (!agentStarted) { pushAgentTurn(); agentStarted = true; }
            enqueue(ev);
            break;
          case "action":
            markDone(ev.tool, ev.result);
            renderState(ev.state);
            break;
          case "ended": sawEnd = true; break;
          case "error": error = ev.message; break;
          case "state": finalState = ev.state; break;
        }
      }
    }
  } catch (e) {
    error = "Connection dropped. Tap the mic and try again.";
  }
  await playing;
  $("phone").classList.remove("thinking");
  if (finalState) renderState(finalState);
  busy = false;
  if (error) {
    $("capText").textContent = error;
    $("capText").classList.add("err");
    $("capWho").textContent = "SIA"; $("capWho").className = "cap-who agent";
    setInputs(true);
    $("micHint").textContent = "Tap the mic to try again";
    return;
  }
  $("capText").classList.remove("err");
  if (sawEnd || finalState?.outcome) { ended = true; return finishCall(finalState); }
  setInputs(true);
  if (!gotHeard) $("micHint").textContent = "Didn't catch that. Speak again";
  listen();
}

async function playItem(item) {
  appendAgent(item.text);
  await speak(item.audio, item.text, item.lang);
}

function finishCall(state) {
  clearInterval(callTimer);
  stopListening(true);
  stopWaveform();
  $("endedTime").textContent = `Call lasted ${$("callTime").textContent}`;
  setTimeout(() => setPhase("ended"), 600);
  setStep(3);
  $("checkBtn").hidden = true;
  $("convoCard").hidden = true;
  $("againBtn").hidden = false;
  setTimeout(() => celebrate(state), 1100);
}

async function hangUp() {
  if (ended) return;
  ended = true;
  stopSpeaking(); stopListening(true);
  const st = await post("/api/call/end");
  renderState(st);
  finishCall(st);
}

function setPhase(p) { phase = p; $("phone").dataset.phase = p; }

function setInputs(on) {
  $("micBtn").disabled = !on;
  $("typeIn").disabled = !on;
}

// ----------------------------------------------------------------- transcript (left card + phone caption)

function pushUser(text) {
  transcript.push({ speaker: "user", text });
  renderTranscript();
}
function pushPendingUser() {
  transcript.push({ speaker: "user", text: "…", pending: true });
  renderTranscript();
}
function resolvePendingUser(text) {
  const last = transcript.at(-1);
  if (last && last.speaker === "user" && last.pending) { last.text = text; last.pending = false; }
  else transcript.push({ speaker: "user", text });
  renderTranscript();
}
function pushAgentTurn() {
  transcript.push({ speaker: "agent", text: "" });
  renderTranscript();
}
function appendAgent(text) {
  const last = transcript.at(-1);
  if (last && last.speaker === "agent") last.text = (last.text + " " + text).trim();
  else transcript.push({ speaker: "agent", text });
  renderTranscript();
}
function renderTranscript() {
  $("transcript").innerHTML = transcript.map((t) => `<div class="turn ${t.speaker}"><span class="turn-who">${t.speaker === "agent" ? "SIA" : "MURARI"}</span><span class="turn-text">${esc(t.text)}</span></div>`).join("");
  $("transcript").scrollTop = $("transcript").scrollHeight;
  const last = transcript.at(-1);
  if (last) {
    $("capWho").textContent = last.speaker === "agent" ? "SIA" : "MURARI";
    $("capWho").className = "cap-who " + last.speaker;
    $("capText").textContent = last.text;
  }
}

// ----------------------------------------------------------------- Sia's plan (ladder)

const ORDER = ["topup", "reduce", "bank", "pause"];
function updateLadder(stage) {
  const s = { cancel_pushback: "pause", explain: "topup" }[stage] || stage;
  if (!ORDER.includes(s)) return;
  if ($("actionsPlaceholder")) { $("actionsPlaceholder").hidden = true; $("ladderCard").hidden = false; }
  ORDER.slice(0, ORDER.indexOf(s)).forEach((k) => { if (rung[k]?.status === "offered") rung[k].status = "declined"; });
  if (!rung[s]) rung[s] = { status: "offered" };
  paintLadder();
}
const TOOL_RUNG = { send_topup_link: "topup", reduce_sip_amount: "reduce", change_bank_account: "bank", pause_sip: "pause" };
function markDone(tool, result) {
  const key = TOOL_RUNG[tool];
  if (key) { rung[key] = { status: "done", sub: resultSub(tool, result) }; paintLadder(); return; }
  if (tool === "cancel_sip" && rung.pause?.status === "offered") { rung.pause.status = "declined"; paintLadder(); }
}
function resultSub(tool, r) {
  const f = cfg.fixture;
  if (!r || r.ok === false) return null;
  if (tool === "send_topup_link") return `Link sent · add ₹${r.amount_inr} before 8 am`;
  if (tool === "reduce_sip_amount") return `Now ₹${r.new_amount_inr} a day from ${fmtDate(r.effective_from)}`;
  if (tool === "change_bank_account") return "Link sent to move the mandate";
  if (tool === "pause_sip") return `Paused ${r.days} days · restarts ${fmtDate(r.resumes_on)}`;
  return null;
}
const TAG_TEXT = { offered: "ASKING", declined: "DECLINED", done: "AGREED" };
function paintLadder() {
  document.querySelectorAll("#ladder li").forEach((li) => {
    const r = rung[li.dataset.rung];
    li.className = r?.status || "";
    li.querySelector(".ladder-tag").textContent = r ? TAG_TEXT[r.status] : "";
    if (r?.sub) li.querySelector(".ladder-text span").textContent = r.sub;
  });
}

// ================================================================== voice out (Sarvam audio, browser fallback)

let audioCtx = null, currentAudio = null, levelRaf = 0;
function getCtx() { audioCtx ??= new AudioContext(); return audioCtx; }

function speak(url, text, lang) {
  return new Promise((resolve) => {
    if (url) {
      const a = new Audio(url);
      currentAudio = a;
      const ctx = getCtx(); ctx.resume().catch(() => {});
      if (ctx.state === "running") {
        try {
          const src = ctx.createMediaElementSource(a), an = ctx.createAnalyser();
          an.fftSize = 256; src.connect(an); an.connect(ctx.destination);
          drive(an, "agent");
        } catch { fakeLevels("agent"); }
      } else fakeLevels("agent");
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(guard); stopWaveform(); currentAudio = null; resolve(); };
      let guard = setTimeout(finish, 20000); // a stalled audio element must never freeze the call
      a.onloadedmetadata = () => { clearTimeout(guard); guard = setTimeout(finish, (a.duration || 15) * 1000 + 1500); };
      a.onended = a.onerror = finish;
      a.play().catch(finish);
      return;
    }
    if (!("speechSynthesis" in window) || !text) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang || "hi-IN"; u.rate = 1.1;
    u.onend = u.onerror = () => { stopWaveform(); resolve(); };
    fakeLevels("agent");
    speechSynthesis.speak(u);
  });
}
function stopSpeaking() { currentAudio?.pause(); speechSynthesis.cancel(); stopWaveform(); }

const bars = () => [...document.querySelectorAll("#bars i")];
function drive(an, speaker) {
  $("waveform").dataset.speaker = speaker;
  bars().forEach((b) => (b.style.animationPlayState = "running"));
  const data = new Uint8Array(an.frequencyBinCount);
  const loop = () => {
    an.getByteFrequencyData(data);
    const bs = bars();
    let sum = 0;
    bs.forEach((b, i) => { const v = data[2 + i * 2] / 255; sum += v; b.style.height = `${5 + v * 24}px`; });
    const lvl = sum / bs.length;
    if (speaker === "agent") $("orbWrap").style.setProperty("--glow", (1 + lvl * 1.4).toFixed(2));
    else $("phone").style.setProperty("--mic", `${Math.round(lvl * 22)}px`);
    levelRaf = requestAnimationFrame(loop);
  };
  cancelAnimationFrame(levelRaf);
  loop();
}
function fakeLevels(speaker) {
  $("waveform").dataset.speaker = speaker;
  bars().forEach((b) => (b.style.animationPlayState = "running"));
  cancelAnimationFrame(levelRaf);
  const loop = () => { bars().forEach((b) => (b.style.height = `${5 + Math.random() * 20}px`)); levelRaf = requestAnimationFrame(() => setTimeout(loop, 90)); };
  loop();
}
function stopWaveform() {
  cancelAnimationFrame(levelRaf);
  delete $("waveform").dataset.speaker;
  bars().forEach((b) => { b.style.height = "5px"; b.style.animationPlayState = "paused"; });
  $("orbWrap").style.setProperty("--glow", 1);
}

// ================================================================== voice in (mic -> Sarvam, auto language)

let micStream = null, recorder = null, listening = false, micAnalyser = null, finishNow = false, abortRec = false, micReady = null;
async function ensureMic() {
  if (micStream || !cfg.sarvam) return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const ctx = getCtx();
    micAnalyser = ctx.createAnalyser(); micAnalyser.fftSize = 512;
    ctx.createMediaStreamSource(micStream).connect(micAnalyser);
  } catch {
    $("micHint").textContent = "Microphone is off. Type what Murari says instead.";
  }
}

// Record until Murari pauses (voice activity detection), then send to Sarvam + Claude in one request.
async function listen() {
  if (micReady) await micReady;
  if (!micStream || listening || busy || ended) return;
  listening = true; finishNow = false; abortRec = false;
  $("phone").classList.add("listening");
  $("micHint").textContent = "Listening… speak in any language";
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
  recorder = new MediaRecorder(micStream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((r) => (recorder.onstop = r));
  recorder.start(200);
  drive(micAnalyser, "user");

  const buf = new Uint8Array(micAnalyser.fftSize);
  const t0 = Date.now();
  let voicedMs = 0, lastVoice = 0, last = Date.now();
  while (listening && !abortRec) {
    micAnalyser.getByteTimeDomainData(buf);
    let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
    const now = Date.now();
    if (peak > 14) { voicedMs += now - last; lastVoice = now; }
    last = now;
    const spoke = voicedMs > 180; // ignore clicks and short noises
    if (finishNow) break;
    if (spoke && now - lastVoice > 750) break;   // he paused: send it
    if (!spoke && now - t0 > 10000) break;       // nobody spoke
    if (now - t0 > 15000) break;                 // hard cap
    await sleep(40);
  }
  const spoke = voicedMs > 180 || finishNow;
  listening = false;
  $("phone").classList.remove("listening");
  stopWaveform();
  if (recorder.state !== "inactive") recorder.stop();
  await stopped;
  if (abortRec || busy || ended) return;
  if (!spoke) { $("micHint").textContent = "Tap the mic and speak"; return; }

  $("micHint").textContent = "Speak in any Indian language";
  pushPendingUser();
  const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
  await runTurn(fetch("/api/call/voice", { method: "POST", headers: { "content-type": blob.type }, body: blob }), { fromVoice: true });
}
function stopListening(abort = false) { if (abort) abortRec = true; listening = false; }

async function sendTyped(text) {
  if (!text.trim() || busy || ended) return;
  stopListening(true);
  pushUser(text);
  await runTurn(fetch("/api/call/text", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }));
}

// ================================================================== right column: what changed

function renderState(st) {
  if (!st) return;
  const first = st.plans[0], last = st.plans.at(-1);
  const card = $("planCard");
  card.classList.remove("success", "danger");
  if (last !== first && last.status === "ACTIVE") {
    $("amtOld").classList.add("struck");
    $("amtNew").hidden = false; $("amtNew").textContent = `₹${last.amount_inr}`;
    $("planStatus").textContent = "Active from tomorrow, 14 Oct";
    card.classList.add("success");
  } else if (last.status === "PAUSED") {
    card.classList.add("success"); $("planStatus").textContent = `Paused, restarts ${fmtDate(last.resumes_on)}`;
  } else if (last.status === "CANCELLED") {
    card.classList.add("danger"); $("amtOld").classList.add("struck"); $("planStatus").textContent = "Stopped by Murari on the call";
  } else if (last.status === "INITIATED") {
    card.classList.add("success"); $("planStatus").textContent = "Moving to his new bank once he approves";
  }

  const newEntries = st.log.slice(seenLog);
  for (const e of newEntries) {
    const row = document.createElement("div");
    row.className = "log-row";
    const call = e.path.replace(/^\/internal\/v1\//, "");
    row.innerHTML = `<div class="log-line"><span class="log-time">${e.at.slice(11)}</span><span class="log-call">${e.method} ${esc(call)}</span><span class="log-status">${e.status}</span></div>
      <details><summary>view request / response</summary><pre>${esc(JSON.stringify({ request: e.request, response: e.response }, null, 2))}</pre></details>`;
    $("log").prepend(row);
  }
  seenLog = st.log.length;
  $("logCount").textContent = `${seenLog} call${seenLog === 1 ? "" : "s"}`;

  if (st.sms.length !== seenSms) {
    $("smsCard").hidden = st.sms.length === 0;
    $("smsBubbles").innerHTML = st.sms.map((m) => `<div class="sms-bubble">${esc(m.text)}</div>`).join("");
    seenSms = st.sms.length;
  }
}
const fmtDate = (d) => (d ? new Date(d + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "");

// ================================================================== outcome overlay

const OUTCOME = {
  SIP_REDUCED: ["Murari keeps saving", "Sia lowered his daily saving so it fits his balance.", "Tomorrow 8 am: the smaller saving goes through", true],
  TOPUP_COMMITTED: ["Murari will top up tonight", "He got a link to add money, so tomorrow's saving won't bounce.", "Tomorrow 8 am: ₹100 goes through", true],
  BANK_CHANGE_LINK_SENT: ["Savings move to a better account", "Murari will approve AutoPay on the account where he keeps money.", "Next saving comes from his new bank", true],
  SIP_PAUSED: ["A short break, not a goodbye", "Murari's savings rest for a while and restart on their own.", "No bounce tomorrow, restarts automatically", true],
  SIP_CANCELLED: ["Murari stopped his SIP", "Sia offered every option first. His ₹140 stays invested.", "Flagged for a follow-up", false],
  CALLBACK_SCHEDULED: ["Sia will call back", "Murari was busy, so Sia booked a better time.", "Reminder set", false],
  NO_CHANGE: ["No change this time", "Murari kept his plan as it is.", "Tomorrow's debit may still bounce", false],
  WRONG_PERSON: ["Wrong person picked up", "Sia apologised and ended the call.", "Number flagged for checking", false],
};
function celebrate(state) {
  const o = state?.outcome; if (!o) return;
  const [title, text, tomorrow, happy] = OUTCOME[o.outcome] || OUTCOME.NO_CHANGE;
  $("celTitle").textContent = title;
  $("celText").textContent = text;
  $("celTomorrow").textContent = tomorrow;
  $("celTomorrow").classList.toggle("warn", !happy);
  $("celStats").innerHTML = [[$("callTime").textContent, "on the call"], [lastLang ? (lastLang.code === "en-IN" ? "English" : lastLang.name) : "Hindi", "language"], [state.sms.length, "SMS sent"]].map(([b, s]) => `<div><b>${esc(b)}</b><span>${s}</span></div>`).join("");
  $("celebrate").hidden = false;
}

// ================================================================== reset + wiring

async function resetAll() {
  ringStop = true; ended = false; busy = false; stopSpeaking(); stopListening(true); clearInterval(callTimer);
  const st = await post("/api/reset");
  seenLog = 0; seenSms = 0; lastLang = null; transcript = [];
  for (const k of Object.keys(rung)) delete rung[k];
  document.querySelectorAll(".check-row").forEach((r) => r.classList.remove("in"));
  $("checkCard").hidden = true; $("dangerCallout").hidden = true;
  $("checkBtn").hidden = false; $("checkBtn").disabled = false; $("callBtn").hidden = true;
  $("convoCard").hidden = true; $("againBtn").hidden = true;
  setPhase("lock"); setStep(1);
  renderTranscript();
  $("capWho").textContent = ""; $("capText").textContent = ""; $("capText").classList.remove("err");
  $("callTime").textContent = "0:00";
  $("heardLang").hidden = true; $("langs").querySelectorAll(".lang").forEach((b) => b.classList.remove("on"));
  $("convoLang").textContent = "";
  $("amtOld").classList.remove("struck"); $("amtNew").hidden = true; $("planStatus").textContent = "Active · next debit tomorrow 8 am";
  $("planCard").classList.remove("success", "danger");
  $("actionsPlaceholder").hidden = false; $("ladderCard").hidden = true;
  paintLadder();
  $("log").innerHTML = ""; $("logCount").textContent = "0 calls";
  $("smsCard").hidden = true; $("smsBubbles").innerHTML = "";
  $("celebrate").hidden = true;
  renderState(st);
}

$("checkBtn").onclick = runCheck;
$("callBtn").onclick = callMurari;
$("answerBtn").onclick = answer;
$("declineBtn").onclick = decline;
$("hangBtn").onclick = hangUp;
$("micBtn").onclick = () => (listening ? (finishNow = true) : listen());
$("typeForm").onsubmit = (e) => { e.preventDefault(); const v = $("typeIn").value; $("typeIn").value = ""; sendTyped(v); };
$("resetBtn").onclick = resetAll;
$("againBtn").onclick = resetAll;
$("celClose").onclick = () => ($("celebrate").hidden = true);

boot();
