// SIP Rescue demo front end: story flow, Sarvam voice in/out, live "what changed" panel.
const $ = (id) => document.getElementById(id);
const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const GIF = (cp) => `https://fonts.gstatic.com/s/e/notoemoji/latest/${cp}/512.gif`;

// Animated Noto emoji, falling back to the plain emoji if the GIF can't load.
function hydrateGifs(root = document) {
  root.querySelectorAll("img[data-gif]:not([data-ready])").forEach((img) => {
    img.dataset.ready = "1";
    img.onerror = () => { const s = document.createElement("span"); s.className = img.className; s.textContent = img.dataset.emoji || ""; s.style.fontSize = (img.width || 40) * 0.8 + "px"; s.style.lineHeight = "1"; img.replaceWith(s); };
    img.src = GIF(img.dataset.gif);
  });
}
const gifTag = (cp, emoji, cls = "") => `<img data-gif="${cp}" data-emoji="${emoji}" class="${cls}" alt="" />`;

let cfg, lang = "hinglish", chips = {}, phase = "lock";
let busy = false, ended = false, callT0 = 0, callTimer = null;
let seenLog = 0, seenSms = 0;
const rung = {};

// ================================================================== boot + languages

async function boot() {
  cfg = await fetch("/api/config").then((r) => r.json());
  $("voiceTag").textContent = `Voice: ${cfg.sarvam ? "Sarvam AI" : "browser"}`;
  $("brainTag").textContent = `Brain: ${cfg.engine.startsWith("Claude") ? "Claude" : "guided script"}`;
  $("langs").innerHTML = cfg.langs.map((l) => `<button class="lang" data-lang="${l.id}" title="${l.english}">${l.label}</button>`).join("");
  $("langs").querySelectorAll(".lang").forEach((b) => (b.onclick = () => pickLang(b.dataset.lang)));
  renderDays();
  hydrateGifs();
  await resetAll();
  await pickLang("hinglish", true);
}

async function pickLang(id, quiet = false) {
  if (phase === "call") return; // keep one language per call
  lang = id;
  $("langs").querySelectorAll(".lang").forEach((b) => b.classList.toggle("on", b.dataset.lang === id));
  const meta = cfg.langs.find((l) => l.id === id);
  $("callLang").textContent = meta.english;
  if (cfg.sarvam) {
    let p = await post("/api/lang/prepare", { lang: id });
    if (!p.ready) {
      $("prepTitle").textContent = `Teaching Sia ${meta.english}`;
      $("prep").hidden = false;
      while (!p.ready && !p.error) {
        $("prepFill").style.width = `${Math.round((p.done / p.total) * 100)}%`;
        await sleep(500);
        p = await post("/api/lang/progress", { lang: id });
      }
      $("prepFill").style.width = "100%";
      await sleep(250);
      $("prep").hidden = true;
    }
  }
  chips = await post("/api/chips", { lang: id });
}

// ================================================================== act 1: tonight's check

function renderDays() {
  const days = [
    ["10 Oct", "ok", "2705", "✅"], ["11 Oct", "ok", "2705", "✅"], ["12 Oct", "miss", "274c", "❌"], ["13 Oct", "miss", "274c", "❌"], ["Tomorrow", "next", "1f914", "🤔"],
  ];
  $("days").innerHTML = days.map(([d, c, cp, e]) => `<div class="day ${c}">${gifTag(cp, e)}${d}</div>`).join("");
}

async function runCheck() {
  $("checkBtn").disabled = true;
  for (const el of document.querySelectorAll(".reveal")) {
    el.classList.add("show");
    await sleep(30);
    el.classList.add("in");
    if (el.dataset.step === "2") animateGauge();
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    await sleep(900);
  }
  $("checkBtn").hidden = true;
  setAct(2);
  $("callBtn").hidden = false;
}
function animateGauge() {
  const pct = 149 / 600;
  $("gFill").style.strokeDasharray = `${pct * 100} 100`;
  $("needle").style.transform = `rotate(${-90 + pct * 180}deg)`;
}
function setAct(n) {
  document.querySelectorAll(".act").forEach((a) => {
    const k = Number(a.dataset.act);
    a.classList.toggle("on", k === n);
    a.classList.toggle("done", k < n);
  });
}

// ================================================================== act 2: the call

let ringCtx = null, ringStop = false;
async function ringtone() {
  ringStop = false;
  ringCtx ??= new AudioContext();
  while (!ringStop) {
    for (let i = 0; i < 2 && !ringStop; i++) {
      const o1 = ringCtx.createOscillator(), o2 = ringCtx.createOscillator(), g = ringCtx.createGain();
      o1.frequency.value = 440; o2.frequency.value = 480; g.gain.value = 0.06;
      o1.connect(g); o2.connect(g); g.connect(ringCtx.destination);
      o1.start(); o2.start(); await sleep(400); o1.stop(); o2.stop(); await sleep(200);
    }
    await sleep(1200);
  }
}

function callMurari() {
  $("callBtn").hidden = true;
  setPhase("incoming");
  ringtone();
}

async function answer() {
  ringStop = true;
  setPhase("call");
  ended = false;
  callT0 = Date.now();
  callTimer = setInterval(() => { const s = Math.floor((Date.now() - callT0) / 1000); $("callTime").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }, 500);
  micReady = ensureMic(); // don't block the call on the permission prompt
  setSia("thinking");
  showYou("Hello?");
  const r = await post("/api/call/start", { lang });
  await handleAgent(r);
}

async function decline() {
  ringStop = true;
  setPhase("lock");
  $("callBtn").hidden = false;
}

async function userSays(text, english) {
  if (busy || ended || !text?.trim()) return;
  stopListening();
  busy = true;
  setChipsEnabled(false);
  showYou(text);
  setSia("thinking");
  let r;
  try { r = await post("/api/call/turn", { text, english }); } catch (e) { r = { error: e.message }; }
  busy = false;
  if (r.error) { $("micHint").textContent = "Something went wrong. Tap the mic and try again."; setChipsEnabled(true); return; }
  await handleAgent(r);
}

async function handleAgent(r) {
  $("capSia").textContent = r.say || "";
  $("capYou").textContent = "";
  updateLadder(r);
  renderState(r.state, r.actions || []);
  if (r.ended) ended = true;
  renderChips(ended ? null : r.offer);
  setSia(r.lineId === "hello" ? "hello" : "speaking");
  await speak(r.audio, r.say);
  setSia(ended ? "bye" : "idle");
  if (ended) return finishCall(r.state);
  setChipsEnabled(true);
  listen();
}

function finishCall(state) {
  clearInterval(callTimer);
  stopListening();
  $("endedTime").textContent = `Call lasted ${$("callTime").textContent}`;
  setTimeout(() => setPhase("ended"), 700);
  setAct(3);
  setTimeout(() => celebrate(state), 1300);
}

async function hangUp() {
  if (ended) return;
  ended = true;
  stopSpeaking(); stopListening();
  const st = await post("/api/call/end");
  renderState(st, []);
  finishCall(st);
}

function setPhase(p) {
  phase = p;
  $("phone").dataset.phase = p;
  hydrateGifs($("phone"));
}

const FACES = { hello: ["1f44b", "👋"], speaking: ["1f60a", "😊"], thinking: ["1f914", "🤔"], idle: ["1f60c", "😌"], bye: ["1f64f", "🙏"] };
function setSia(mood) {
  const [cp, e] = FACES[mood] || FACES.idle;
  const old = $("siaFace");
  if (old.dataset.gif === cp) return;
  const img = document.createElement("img");
  img.id = "siaFace"; img.className = "sia-face"; img.dataset.gif = cp; img.dataset.emoji = e; img.alt = "Sia";
  old.replaceWith(img);
  hydrateGifs($("sia"));
}
function showYou(text, pending = false) {
  $("capYou").textContent = text;
  $("capYou").classList.toggle("pending", pending);
}

// ----------------------------------------------------------------- ladder + chips

const TOOL_RUNG = { send_topup_link: "topup", reduce_sip_amount: "reduce", change_bank_account: "bank", pause_sip: "pause" };
const ORDER = ["topup", "reduce", "bank", "pause"];
function updateLadder(r) {
  if (r.offer && ORDER.includes(r.offer)) {
    const idx = ORDER.indexOf(r.offer);
    ORDER.slice(0, idx).forEach((k) => { if (rung[k] === "offered") rung[k] = "declined"; });
    if (!rung[r.offer]) rung[r.offer] = "offered";
  }
  for (const a of r.actions || []) if (TOOL_RUNG[a.tool]) rung[TOOL_RUNG[a.tool]] = "done";
  document.querySelectorAll("#ladder li").forEach((li) => (li.className = rung[li.dataset.rung] || ""));
}
function renderChips(stage) {
  const list = (stage && chips[stage === "start" ? "start" : stage]) || [];
  $("chips").innerHTML = list.map((c, i) => `<button class="chip" data-i="${i}">${esc(c.text)}</button>`).join("");
  $("chips").querySelectorAll(".chip").forEach((b) => (b.onclick = () => { const c = list[Number(b.dataset.i)]; userSays(c.text, c.en); }));
  setChipsEnabled(false);
}
function setChipsEnabled(on) {
  $("chips").querySelectorAll(".chip").forEach((c) => (c.disabled = !on));
  $("micBtn").disabled = !on;
}

// ================================================================== voice out (Sarvam audio, browser fallback)

let audioCtx = null, currentAudio = null, levelRaf = 0;
function getCtx() { audioCtx ??= new AudioContext(); return audioCtx; }

function speak(url, text) {
  return new Promise(async (resolve) => {
    if (url) {
      const a = new Audio(url);
      currentAudio = a;
      // Route through an analyser for the live visuals only when audio output is unlocked;
      // otherwise play directly so a locked AudioContext can never silence or stall Sia.
      const ctx = getCtx(); ctx.resume().catch(() => {});
      if (ctx.state === "running") {
        try {
          const src = ctx.createMediaElementSource(a), an = ctx.createAnalyser();
          an.fftSize = 256; src.connect(an); an.connect(ctx.destination);
          drive(an, "speak");
        } catch { fakeLevels(); }
      } else fakeLevels();
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(guard); stopLevels(); currentAudio = null; resolve(); };
      // Never let a stalled audio element freeze the call: give up after the clip's length plus a margin.
      let guard = setTimeout(finish, 25000);
      a.onloadedmetadata = () => { clearTimeout(guard); guard = setTimeout(finish, (a.duration || 20) * 1000 + 2000); };
      a.onended = a.onerror = finish;
      a.play().catch(finish);
      return;
    }
    // Browser voice fallback when Sarvam is unavailable.
    if (!("speechSynthesis" in window) || !text) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = { hinglish: "hi-IN", en: "en-IN" }[lang] || `${lang}-IN`;
    u.onend = u.onerror = () => { stopLevels(); resolve(); };
    fakeLevels();
    speechSynthesis.speak(u);
  });
}
function stopSpeaking() { currentAudio?.pause(); speechSynthesis.cancel(); stopLevels(); }

const bars = () => [...document.querySelectorAll("#bars i")];
function drive(an, mode) {
  const data = new Uint8Array(an.frequencyBinCount);
  const loop = () => {
    an.getByteFrequencyData(data);
    const bs = bars();
    let sum = 0;
    bs.forEach((b, i) => { const v = data[2 + i * 3] / 255; sum += v; b.style.height = `${6 + v * 26}px`; });
    const lvl = sum / bs.length;
    if (mode === "speak") $("siaGlow").style.setProperty("--lvl", (1 + lvl * 0.6).toFixed(2));
    else $("phone").style.setProperty("--mic", `${Math.round(lvl * 22)}px`);
    levelRaf = requestAnimationFrame(loop);
  };
  cancelAnimationFrame(levelRaf);
  loop();
}
function fakeLevels() {
  const loop = () => { bars().forEach((b) => (b.style.height = `${6 + Math.random() * 22}px`)); levelRaf = requestAnimationFrame(() => setTimeout(loop, 80)); };
  loop();
}
function stopLevels() {
  cancelAnimationFrame(levelRaf);
  bars().forEach((b) => (b.style.height = "6px"));
  $("siaGlow").style.setProperty("--lvl", 1);
}

// ================================================================== voice in (mic -> Sarvam STT)

let micStream = null, recorder = null, listening = false, micAnalyser = null, finishNow = false, micReady = null;
async function ensureMic() {
  if (micStream || !cfg.sarvam) return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const ctx = getCtx();
    micAnalyser = ctx.createAnalyser(); micAnalyser.fftSize = 512;
    ctx.createMediaStreamSource(micStream).connect(micAnalyser);
  } catch {
    $("micHint").textContent = "Microphone is off. Tap a reply instead.";
  }
}

// Record until the speaker pauses (voice activity detection), then transcribe with Sarvam.
async function listen() {
  if (micReady) await micReady;
  if (!micStream || listening || busy || ended) { $("micHint").textContent = micStream ? $("micHint").textContent : "Tap a reply to answer as Murari"; return; }
  listening = true; finishNow = false;
  $("phone").classList.add("listening");
  $("micHint").textContent = "Listening… speak now";
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
  recorder = new MediaRecorder(micStream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((r) => (recorder.onstop = r));
  recorder.start(250);
  drive(micAnalyser, "mic");

  const buf = new Uint8Array(micAnalyser.fftSize);
  const t0 = Date.now();
  let spoke = false, lastVoice = Date.now();
  while (listening) {
    micAnalyser.getByteTimeDomainData(buf);
    let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
    const loud = peak > 14;
    if (loud) { spoke = true; lastVoice = Date.now(); }
    if (finishNow) break;                                    // mic tapped again: send now
    if (spoke && Date.now() - lastVoice > 1100) break;      // finished a sentence
    if (!spoke && Date.now() - t0 > 9000) break;            // nobody spoke
    if (Date.now() - t0 > 15000) break;                     // hard cap
    await sleep(60);
  }
  const wasListening = listening;
  listening = false;
  $("phone").classList.remove("listening");
  stopLevels();
  if (recorder.state !== "inactive") recorder.stop();
  await stopped;
  if (!wasListening || busy || ended) return;
  if (!spoke && !finishNow) { $("micHint").textContent = "Tap the mic and speak, or tap a reply"; return; }

  $("micHint").textContent = "Got it…";
  showYou("…", true);
  setChipsEnabled(false);
  try {
    const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
    const r = await fetch(`/api/stt?lang=${lang}`, { method: "POST", headers: { "content-type": blob.type }, body: blob }).then((x) => x.json());
    if (!r.transcript?.trim()) { showYou(""); $("micHint").textContent = "Didn't catch that. Tap the mic and try again."; setChipsEnabled(true); return; }
    $("micHint").textContent = "Tap the mic and speak, or tap a reply";
    await userSays(r.transcript, r.english);
  } catch {
    showYou(""); $("micHint").textContent = "Couldn't hear that. Tap a reply instead."; setChipsEnabled(true);
  }
}
function stopListening() { listening = false; }

// ================================================================== act 3: what changed

const ACTION_CARD = {
  "topup-link": ["1f48c", "💌", "Top-up link sent", "Murari will add ₹500 to his Bank of Baroda account tonight."],
  modify: ["1f4c9", "📉", "Daily saving lowered", "₹100 becomes ₹50 a day, starting tomorrow. No more bounces."],
  "change-bank": ["1f680", "🚀", "Moving to another bank", "A link to set up AutoPay on his other account is on his phone."],
  pause: ["23f0", "⏰", "Short break", "Savings paused. They restart on their own."],
  cancel: ["1f622", "😢", "SIP stopped", "His ₹140 stays invested. The team can follow up."],
  callbacks: ["1f514", "🔔", "Callback booked", "Sia will call again tomorrow at 7 pm."],
};

function renderState(st, actions) {
  if (!st) return;
  // daily saving card
  const first = st.plans[0], last = st.plans.at(-1);
  const card = $("planCard");
  card.classList.remove("paused", "cancelled");
  if (last !== first && last.status === "ACTIVE") {
    $("amtOld").classList.add("struck");
    $("amtNew").hidden = false; $("amtNew").textContent = `₹${last.amount_inr}`;
    $("planStatus").textContent = "Active from tomorrow, 14 Oct";
  } else if (last.status === "PAUSED") {
    card.classList.add("paused"); $("planStatus").textContent = `Paused, restarts ${fmtDate(last.resumes_on)}`;
  } else if (last.status === "CANCELLED") {
    card.classList.add("cancelled"); $("amtOld").classList.add("struck"); $("planStatus").textContent = "Stopped by Murari on the call";
  } else if (last.status === "INITIATED") {
    $("planStatus").textContent = "Moving to his new bank once he approves";
  }

  // friendly action cards
  const newEntries = st.log.slice(seenLog);
  for (const e of newEntries) {
    const key = Object.keys(ACTION_CARD).find((k) => e.path.includes(k));
    if (!key) continue;
    if ($("actions").querySelector(".empty")) $("actions").innerHTML = "";
    let [cp, emo, title, text] = ACTION_CARD[key];
    if (key === "pause") text = `Savings paused for ${e.request.days} days. They restart on ${fmtDate(e.response.resumes_on)}.`;
    const el = document.createElement("div");
    el.className = "action";
    el.innerHTML = `${gifTag(cp, emo)}<div><h3>${title}</h3><p>${esc(text)}</p></div>`;
    $("actions").prepend(el);
    hydrateGifs(el);
  }
  // technical log (for judges)
  for (const e of newEntries) {
    const el = document.createElement("div");
    el.className = "log-entry";
    el.innerHTML = `<b>${e.method}</b> ${esc(e.path)} → ${e.status}<pre>${esc(JSON.stringify({ request: e.request, response: e.response }, null, 2))}</pre>`;
    $("log").prepend(el);
  }
  seenLog = st.log.length;

  // SMS on Murari's phone
  if (st.sms.length !== seenSms) {
    $("smsPhone").hidden = st.sms.length === 0;
    $("smsBubbles").innerHTML = st.sms.map((m) => `<div class="sms-bubble">${esc(m.text)}</div>`).join("");
    seenSms = st.sms.length;
  }
}
const fmtDate = (d) => (d ? new Date(d + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "");

// ================================================================== celebration

const OUTCOME = {
  SIP_REDUCED: ["1f973", "🥳", "Murari keeps saving", "Sia lowered his daily saving to ₹50 so it fits his balance.", "Tomorrow 8 am: ₹50 goes through", true],
  TOPUP_COMMITTED: ["1f4aa", "💪", "Murari will top up tonight", "He got a link to add ₹500, so tomorrow's saving won't bounce.", "Tomorrow 8 am: ₹100 goes through", true],
  BANK_CHANGE_LINK_SENT: ["1f680", "🚀", "Savings move to a better account", "Murari will approve AutoPay on the account where he keeps money.", "Next saving comes from his new bank", true],
  SIP_PAUSED: ["1f60c", "😌", "A short break, not a goodbye", "Murari's savings rest for a while and restart on their own.", "No bounce tomorrow, restarts automatically", true],
  SIP_CANCELLED: ["1f622", "😢", "Murari stopped his SIP", "Sia offered every option first. His ₹140 stays invested.", "Flagged for a follow-up", false],
  CALLBACK_SCHEDULED: ["1f514", "🔔", "Sia will call back", "Murari was busy, so Sia booked a call for tomorrow at 7 pm.", "Reminder set for tomorrow, 7 pm", false],
  NO_CHANGE: ["1f914", "🤔", "No change this time", "Murari kept his plan as it is.", "Tomorrow's debit may still bounce", false],
  WRONG_PERSON: ["1f62c", "😬", "Wrong person picked up", "Sia apologised and ended the call.", "Number flagged for checking", false],
};
function celebrate(state) {
  const o = state?.outcome; if (!o) return;
  const [cp, emo, title, text, tomorrow, happy] = OUTCOME[o.outcome] || OUTCOME.NO_CHANGE;
  const img = $("celGif"); img.removeAttribute("data-ready"); img.dataset.gif = cp; img.dataset.emoji = emo;
  hydrateGifs($("celebrate"));
  $("celTitle").textContent = title;
  $("celText").textContent = text;
  $("celTomorrow").textContent = tomorrow;
  $("celTomorrow").classList.toggle("warn", !happy);
  const meta = cfg.langs.find((l) => l.id === lang);
  $("celStats").innerHTML = [[$("callTime").textContent, "on the call"], [meta.english, "language"], [state.sms.length, state.sms.length === 1 ? "SMS sent" : "SMS sent"]].map(([b, s]) => `<div><b>${esc(b)}</b>${s}</div>`).join("");
  $("confetti").innerHTML = happy ? Array.from({ length: 90 }, () => `<i style="left:${Math.random() * 100}%;background:${["#f7a325", "#1fa45b", "#5b8def", "#e5484d", "#ffd84d"][Math.floor(Math.random() * 5)]};animation-duration:${2.5 + Math.random() * 2.5}s;animation-delay:${Math.random() * 0.8}s"></i>`).join("") : "";
  $("celebrate").hidden = false;
}

// ================================================================== reset + wiring

async function resetAll() {
  ringStop = true; ended = false; busy = false; stopSpeaking(); stopListening(); clearInterval(callTimer);
  const st = await post("/api/reset");
  seenLog = 0; seenSms = 0; for (const k of Object.keys(rung)) delete rung[k];
  document.querySelectorAll(".reveal").forEach((r) => r.classList.remove("show", "in"));
  $("gFill").style.strokeDasharray = "0 100"; $("needle").style.transform = "rotate(-90deg)";
  $("checkBtn").hidden = false; $("checkBtn").disabled = false; $("callBtn").hidden = true;
  setPhase("lock"); setAct(1);
  $("capSia").textContent = ""; $("capYou").textContent = ""; $("chips").innerHTML = ""; $("callTime").textContent = "0:00";
  $("amtOld").classList.remove("struck"); $("amtNew").hidden = true; $("planStatus").textContent = "Active, next debit tomorrow 8 am";
  $("planCard").classList.remove("paused", "cancelled");
  $("actions").innerHTML = `<div class="empty">${gifTag("2728", "✨")}<p>When Sia helps Murari during the call, it shows up here.</p></div>`;
  $("log").innerHTML = ""; $("smsPhone").hidden = true; $("smsBubbles").innerHTML = "";
  document.querySelectorAll("#ladder li").forEach((li) => (li.className = ""));
  $("celebrate").hidden = true;
  hydrateGifs();
  renderState(st, []);
}

$("checkBtn").onclick = runCheck;
$("callBtn").onclick = callMurari;
$("answerBtn").onclick = answer;
$("declineBtn").onclick = decline;
$("hangBtn").onclick = hangUp;
$("micBtn").onclick = () => (listening ? (finishNow = true) : listen());
$("resetBtn").onclick = async () => { await resetAll(); chips = await post("/api/chips", { lang }); };
$("celClose").onclick = () => ($("celebrate").hidden = true);

boot();
