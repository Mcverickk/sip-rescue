// SIP Rescue demo front end: story flow, streamed Claude replies voiced by Sarvam, live "what changed".
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

let cfg, phase = "lock";
let busy = false, ended = false, callT0 = 0, callTimer = null;
let seenLog = 0, seenSms = 0, lastLang = null;
const rung = {};

// ================================================================== boot

async function boot() {
  cfg = await fetch("/api/config").then((r) => r.json());
  $("voiceTag").textContent = `Voice: ${cfg.sarvam ? "Sarvam AI" : "browser"}`;
  $("brainTag").textContent = `Brain: ${cfg.claude ? "Claude" : "Claude (no key)"}`;
  $("langs").innerHTML = cfg.languages.map((l) => `<span class="lang" data-code="${l.code}" title="${l.name}">${l.native}</span>`).join("");
  renderDays();
  hydrateGifs();
  await resetAll();
}

function showLanguage(code) {
  const l = cfg.languages.find((x) => x.code === code);
  if (!l) return;
  lastLang = l;
  $("langs").querySelectorAll(".lang").forEach((b) => b.classList.toggle("on", b.dataset.code === code));
  $("heardLang").hidden = false;
  $("heardLangName").textContent = l.code === "en-IN" ? "English" : `${l.native} · ${l.name}`;
}

// ================================================================== act 1: tonight's check

function renderDays() {
  const days = [["10 Oct", "ok", "2705", "✅"], ["11 Oct", "ok", "2705", "✅"], ["12 Oct", "miss", "274c", "❌"], ["13 Oct", "miss", "274c", "❌"], ["Tomorrow", "next", "1f914", "🤔"]];
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
    await sleep(800);
  }
  $("checkBtn").hidden = true;
  setAct(2);
  if (phase === "lock") $("callBtn").hidden = false;
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
  try { ringCtx ??= new AudioContext(); } catch { return; }
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

let greeting = null; // Sia's greeting is prepared while the phone rings, so she speaks the moment he answers
function callMurari() {
  $("callBtn").hidden = true;
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
  showYou("Hello?");
  await runTurn(greeting || fetch("/api/call/start", { method: "POST" }));
  greeting = null;
}

function decline() {
  ringStop = true;
  greeting = null;
  setPhase("lock");
  $("callBtn").hidden = false;
}

// Plays one streamed turn: captions and audio arrive sentence by sentence.
async function runTurn(responsePromise, { fromVoice = false } = {}) {
  busy = true;
  setInputs(false);
  setSia("thinking");
  let firstSay = true, gotHeard = !fromVoice, error = null, sawEnd = false, finalState = null;
  const queue = [];
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
            showYou(ev.transcript || "…");
            if (ev.language_code) showLanguage(ev.language_code);
            break;
          case "nothing":
            showYou("");
            break;
          case "stage": updateLadder(ev.stage); break;
          case "say":
            if (firstSay) { $("capSia").textContent = ""; firstSay = false; }
            enqueue(ev);
            break;
          case "action":
            markDone(ev.tool);
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
  if (finalState) renderState(finalState);
  busy = false;
  if (error) {
    $("capSia").innerHTML = `<span class="cap-err">${esc(error)}</span>`;
    setSia("idle"); setInputs(true);
    $("micHint").textContent = "Tap the mic to try again";
    return;
  }
  if (sawEnd || finalState?.outcome) { ended = true; setSia("bye"); return finishCall(finalState); }
  setSia("idle");
  setInputs(true);
  if (!gotHeard || $("capYou").textContent === "") $("micHint").textContent = "Didn't catch that. Speak again";
  listen();
}

async function playItem(item) {
  setSia($("capSia").textContent === "" && phase === "call" && !lastLang ? "hello" : "speaking");
  $("capSia").textContent = ($("capSia").textContent + " " + item.text).trim();
  requestAnimationFrame(() => ($("captions").scrollTop = $("captions").scrollHeight));
  await speak(item.audio, item.text, item.lang);
}

function finishCall(state) {
  clearInterval(callTimer);
  stopListening(true);
  $("endedTime").textContent = `Call lasted ${$("callTime").textContent}`;
  setTimeout(() => setPhase("ended"), 600);
  setAct(3);
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
function setInputs(on) {
  $("micBtn").disabled = !on;
  $("typeIn").disabled = !on;
}

// ----------------------------------------------------------------- Sia's plan strip

const ORDER = ["topup", "reduce", "bank", "pause"];
function updateLadder(stage) {
  const s = { cancel_pushback: "pause", explain: "topup" }[stage] || stage; // the explanation ends with offer 1
  if (!ORDER.includes(s)) return;
  ORDER.slice(0, ORDER.indexOf(s)).forEach((k) => { if (rung[k] === "offered") rung[k] = "declined"; });
  if (!rung[s]) rung[s] = "offered";
  paintLadder();
}
const TOOL_RUNG = { send_topup_link: "topup", reduce_sip_amount: "reduce", change_bank_account: "bank", pause_sip: "pause" };
function markDone(tool) { if (TOOL_RUNG[tool]) { rung[TOOL_RUNG[tool]] = "done"; paintLadder(); } }
function paintLadder() { document.querySelectorAll("#ladder li").forEach((li) => (li.className = rung[li.dataset.rung] || "")); }

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
          drive(an, "speak");
        } catch { fakeLevels(); }
      } else fakeLevels();
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(guard); stopLevels(); currentAudio = null; resolve(); };
      let guard = setTimeout(finish, 20000); // a stalled audio element must never freeze the call
      a.onloadedmetadata = () => { clearTimeout(guard); guard = setTimeout(finish, (a.duration || 15) * 1000 + 1500); };
      a.onended = a.onerror = finish;
      a.play().catch(finish);
      return;
    }
    if (!("speechSynthesis" in window) || !text) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang || "hi-IN"; u.rate = 1.1;
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
  cancelAnimationFrame(levelRaf);
  const loop = () => { bars().forEach((b) => (b.style.height = `${6 + Math.random() * 22}px`)); levelRaf = requestAnimationFrame(() => setTimeout(loop, 80)); };
  loop();
}
function stopLevels() {
  cancelAnimationFrame(levelRaf);
  bars().forEach((b) => (b.style.height = "6px"));
  $("siaGlow").style.setProperty("--lvl", 1);
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
  drive(micAnalyser, "mic");

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
  stopLevels();
  if (recorder.state !== "inactive") recorder.stop();
  await stopped;
  if (abortRec || busy || ended) return;
  if (!spoke) { $("micHint").textContent = "Tap the mic and speak"; return; }

  $("micHint").textContent = "Speak in any Indian language";
  showYou("…", true);
  const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
  await runTurn(fetch("/api/call/voice", { method: "POST", headers: { "content-type": blob.type }, body: blob }), { fromVoice: true });
}
function stopListening(abort = false) { if (abort) abortRec = true; listening = false; }

async function sendTyped(text) {
  if (!text.trim() || busy || ended) return;
  stopListening(true);
  showYou(text);
  await runTurn(fetch("/api/call/text", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }));
}

// ================================================================== act 3: what changed

const ACTION_CARD = {
  "topup-link": ["1f48c", "💌", "Top-up link sent", "Murari will add money to his Bank of Baroda account tonight."],
  modify: ["1f4c9", "📉", "Daily saving lowered", "Smaller daily amount from tomorrow. No more bounces."],
  "change-bank": ["1f680", "🚀", "Moving to another bank", "A link to set up AutoPay on his other account is on his phone."],
  pause: ["23f0", "⏰", "Short break", "Savings paused. They restart on their own."],
  cancel: ["1f622", "😢", "SIP stopped", "His ₹140 stays invested. The team can follow up."],
  callbacks: ["1f514", "🔔", "Callback booked", "Sia will call again at the time Murari chose."],
};

function renderState(st) {
  if (!st) return;
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

  const newEntries = st.log.slice(seenLog);
  for (const e of newEntries) {
    const key = Object.keys(ACTION_CARD).find((k) => e.path.includes(k));
    if (!key) continue;
    if ($("actions").querySelector(".empty")) $("actions").innerHTML = "";
    let [cp, emo, title, text] = ACTION_CARD[key];
    if (key === "pause") text = `Savings paused for ${e.request.days} days. They restart on ${fmtDate(e.response.resumes_on)}.`;
    if (key === "modify" && e.response?.new_plan) text = `₹100 becomes ₹${e.response.new_plan.amount_inr} a day from tomorrow. No more bounces.`;
    if (key === "topup-link") text = `Murari will add ₹${e.request.amount_inr} to his Bank of Baroda account tonight.`;
    const el = document.createElement("div");
    el.className = "action";
    el.innerHTML = `${gifTag(cp, emo)}<div><h3>${title}</h3><p>${esc(text)}</p></div>`;
    $("actions").prepend(el);
    hydrateGifs(el);
  }
  for (const e of newEntries) {
    const el = document.createElement("div");
    el.className = "log-entry";
    el.innerHTML = `<b>${e.method}</b> ${esc(e.path)} → ${e.status}<pre>${esc(JSON.stringify({ request: e.request, response: e.response }, null, 2))}</pre>`;
    $("log").prepend(el);
  }
  seenLog = st.log.length;

  if (st.sms.length !== seenSms) {
    $("smsPhone").hidden = st.sms.length === 0;
    $("smsBubbles").innerHTML = st.sms.map((m) => `<div class="sms-bubble">${esc(m.text)}</div>`).join("");
    seenSms = st.sms.length;
  }
}
const fmtDate = (d) => (d ? new Date(d + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "");

// ================================================================== celebration

const OUTCOME = {
  SIP_REDUCED: ["1f973", "🥳", "Murari keeps saving", "Sia lowered his daily saving so it fits his balance.", "Tomorrow 8 am: the smaller saving goes through", true],
  TOPUP_COMMITTED: ["1f4aa", "💪", "Murari will top up tonight", "He got a link to add money, so tomorrow's saving won't bounce.", "Tomorrow 8 am: ₹100 goes through", true],
  BANK_CHANGE_LINK_SENT: ["1f680", "🚀", "Savings move to a better account", "Murari will approve AutoPay on the account where he keeps money.", "Next saving comes from his new bank", true],
  SIP_PAUSED: ["1f60c", "😌", "A short break, not a goodbye", "Murari's savings rest for a while and restart on their own.", "No bounce tomorrow, restarts automatically", true],
  SIP_CANCELLED: ["1f622", "😢", "Murari stopped his SIP", "Sia offered every option first. His ₹140 stays invested.", "Flagged for a follow-up", false],
  CALLBACK_SCHEDULED: ["1f514", "🔔", "Sia will call back", "Murari was busy, so Sia booked a better time.", "Reminder set", false],
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
  $("celStats").innerHTML = [[$("callTime").textContent, "on the call"], [lastLang ? lastLang.native : "हिन्दी", "Murari's language"], [state.sms.length, "SMS sent"]].map(([b, s]) => `<div><b>${esc(b)}</b>${s}</div>`).join("");
  $("confetti").innerHTML = happy ? Array.from({ length: 90 }, () => `<i style="left:${Math.random() * 100}%;background:${["#f7a325", "#1fa45b", "#5b8def", "#e5484d", "#ffd84d"][Math.floor(Math.random() * 5)]};animation-duration:${2.5 + Math.random() * 2.5}s;animation-delay:${Math.random() * 0.8}s"></i>`).join("") : "";
  $("celebrate").hidden = false;
}

// ================================================================== reset + wiring

async function resetAll() {
  ringStop = true; ended = false; busy = false; stopSpeaking(); stopListening(true); clearInterval(callTimer);
  const st = await post("/api/reset");
  seenLog = 0; seenSms = 0; lastLang = null; for (const k of Object.keys(rung)) delete rung[k];
  document.querySelectorAll(".reveal").forEach((r) => r.classList.remove("show", "in"));
  $("gFill").style.strokeDasharray = "0 100"; $("needle").style.transform = "rotate(-90deg)";
  $("checkBtn").hidden = false; $("checkBtn").disabled = false; $("callBtn").hidden = true;
  setPhase("lock"); setAct(1);
  $("capSia").textContent = ""; $("capYou").textContent = ""; $("callTime").textContent = "0:00";
  $("heardLang").hidden = true; $("langs").querySelectorAll(".lang").forEach((b) => b.classList.remove("on"));
  $("amtOld").classList.remove("struck"); $("amtNew").hidden = true; $("planStatus").textContent = "Active, next debit tomorrow 8 am";
  $("planCard").classList.remove("paused", "cancelled");
  $("actions").innerHTML = `<div class="empty">${gifTag("2728", "✨")}<p>When Sia helps Murari during the call, it shows up here.</p></div>`;
  $("log").innerHTML = ""; $("smsPhone").hidden = true; $("smsBubbles").innerHTML = "";
  paintLadder();
  $("celebrate").hidden = true;
  hydrateGifs();
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
$("celClose").onclick = () => ($("celebrate").hidden = true);

boot();
