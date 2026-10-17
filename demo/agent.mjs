// SIP Rescue conversation agent.
// Two engines share the same mocked tools:
//   - "claude": Claude Opus 5 with tool use (needs ANTHROPIC_API_KEY or another SDK credential)
//   - "scripted": a deterministic ladder state machine, so the demo always works offline
import Anthropic from "@anthropic-ai/sdk";
import { api, fixture } from "./mockApi.mjs";
import { LINES, SMS, langById } from "./lines.mjs";
import { render } from "./sarvam.mjs";

const MODEL = process.env.SIP_RESCUE_MODEL || "claude-opus-5";
const f = fixture;

// ---------------------------------------------------------------------------- tools

const TOOLS = [
  {
    name: "send_topup_link",
    description: "Ladder step 1. Sends the customer an SMS with a link to add money to the Bank of Baroda account the SIP debits. Use only after the customer agrees to add money tonight.",
    input_schema: { type: "object", properties: { amount_inr: { type: "integer", description: "Rupees the customer agreed to add. Suggest 500." } }, required: ["amount_inr"], additionalProperties: false },
  },
  {
    name: "reduce_sip_amount",
    description: "Ladder step 2. Lowers the daily SIP amount from tomorrow's debit onward. Minimum is 50 rupees. Use only after the customer clearly agrees to the new amount.",
    input_schema: { type: "object", properties: { new_amount_inr: { type: "integer", description: "New daily amount in rupees, at least 50 and below the current 100." } }, required: ["new_amount_inr"], additionalProperties: false },
  },
  {
    name: "change_bank_account",
    description: "Ladder step 3. Sends a link to move the SIP's UPI AutoPay mandate to another bank account the customer keeps money in. Use only after the customer agrees.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "pause_sip",
    description: "Ladder step 4. Pauses the SIP for 7, 15 or 30 days; it resumes automatically. Use only after the customer agrees to a duration.",
    input_schema: { type: "object", properties: { days: { type: "integer", enum: [7, 15, 30] } }, required: ["days"], additionalProperties: false },
  },
  {
    name: "cancel_sip",
    description: "Cancels the SIP. Never offer this. Use only if the customer insists on cancelling a second time after you have offered a pause.",
    input_schema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"], additionalProperties: false },
  },
  {
    name: "schedule_callback",
    description: "Schedules a callback when the customer is busy or asks to talk later.",
    input_schema: { type: "object", properties: { when: { type: "string", description: "When to call back, e.g. 'tomorrow 19:00'." } }, required: ["when"], additionalProperties: false },
  },
  {
    name: "end_call",
    description: "Records the outcome and hangs up. Call it right after your final goodbye sentence.",
    input_schema: {
      type: "object",
      properties: {
        outcome: { type: "string", enum: ["TOPUP_COMMITTED", "SIP_REDUCED", "BANK_CHANGE_LINK_SENT", "SIP_PAUSED", "SIP_CANCELLED", "CALLBACK_SCHEDULED", "NO_CHANGE", "WRONG_PERSON"] },
        summary: { type: "string", description: "One English sentence for the ops dashboard." },
      },
      required: ["outcome", "summary"],
      additionalProperties: false,
    },
  },
];

function runTool(name, input) {
  switch (name) {
    case "send_topup_link": return api.topupLink(input);
    case "reduce_sip_amount": return api.reduceSip(input);
    case "change_bank_account": return api.changeBank(input);
    case "pause_sip": return api.pauseSip(input);
    case "cancel_sip": return api.cancelSip(input);
    case "schedule_callback": return api.scheduleCallback(input);
    case "end_call": return api.endCall(input);
    default: return { ok: false, error: "unknown tool " + name };
  }
}

const SYSTEM = `You are Sia, Bachatt's savings assistant, on a live outbound phone call. Your words are converted to speech, so write exactly what you would say: plain sentences, no lists, no markdown, no emoji.

Language: speak LANGUAGE_PLACEHOLDER, the way people talk every day, mixing in common English words like SIP, account and balance. For Hinglish use Devanagari script for Hindi words so the voice engine pronounces them well. If the customer switches language, follow them. Say amounts as "500 rupaye", never with the rupee symbol. Keep every turn to one to three short sentences and end with one clear question, except the goodbye.

Why you are calling. It is Monday 13 October 2026, 7 pm.
- Customer: ${f.user.first_name} from ${f.user.city}. Address him as "${f.user.display_name}".
- SIP: ${f.sip.product_label}, ${f.sip.amount_inr} rupaye every day, into two liquid funds. He has about 140 rupaye invested so far.
- Tomorrow morning, 14 October, 100 rupaye will be debited from his ${f.bank.name} account ending ${f.bank.acct_last4}.
- The last two debits, on 12 and 13 October, failed because of low balance, even though the balance then was 270 and 212 rupaye. The bank keeps a minimum balance aside.
- His latest balance from bank SMS is 149 rupaye. So tomorrow's debit will most likely fail again.
- There is no penalty or charge for a failed debit. Say this early so he is not worried. He only misses that day's savings.

How the call goes:
1. Greet, say who you are and that this is about his Smart Deposit savings, and check it is a good time. If it is a wrong person, apologise and end the call. If he is busy, offer a callback and schedule it.
2. Explain the situation in one or two sentences: two debits bounced, balance is low, no penalty.
3. Walk this ladder strictly in order, one offer per turn, moving down only when he declines:
   a. Add money tonight: ask him to keep at least 500 rupaye in the account ending ${f.bank.acct_last4}. If yes, send the top-up link.
   b. Lower the daily amount: offer 50 rupaye a day instead of 100. If yes, reduce it.
   c. Change the bank: ask if he keeps money in another account and offer a link to move the AutoPay there. If yes, send it.
   d. Pause: offer a pause of 7, 15 or 30 days, 15 suggested; it restarts on its own.
   If he asks for a later option directly, go straight to it.
4. Before any tool call that changes his SIP, repeat the change in one sentence and get a clear yes. Accepting the top-up link counts as a yes.
5. Never offer cancellation. If he asks to cancel, first offer a pause once. Cancel only if he insists again.
6. After a change succeeds, tell him he will get an SMS confirmation, say a warm goodbye, and call end_call in the same turn.
7. If he declines everything, say the SIP will continue as is, thank him, and call end_call with NO_CHANGE.

Safety: never ask for OTP, PIN, card or full account numbers. Never threaten or invent penalties, charges or credit-score effects. Never promise returns.`;

// ---------------------------------------------------------------------------- Claude engine

let client = null;
export function claudeAvailable() {
  if (process.env.SIP_RESCUE_ENGINE === "scripted") return false;
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

async function claudeTurn(session, userText) {
  client ??= new Anthropic();
  const system = SYSTEM.replace("LANGUAGE_PLACEHOLDER", langById(session.lang).english);
  session.messages.push({ role: "user", content: userText });
  const spoken = [];
  const actions = [];
  for (let hop = 0; hop < 6; hop++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system,
      tools: TOOLS,
      messages: session.messages,
    });
    if (response.stop_reason === "refusal") {
      session.messages.pop();
      throw new Error("Claude declined this turn (refusal).");
    }
    session.messages.push({ role: "assistant", content: response.content });
    for (const block of response.content) if (block.type === "text" && block.text.trim()) spoken.push(block.text.trim());

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

    const results = [];
    for (const tu of toolUses) {
      const input = typeof tu.input === "object" && tu.input ? tu.input : {};
      const result = runTool(tu.name, input);
      actions.push({ tool: tu.name, input, result });
      if (tu.name === "end_call") session.ended = true;
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result), is_error: result.ok === false });
    }
    session.messages.push({ role: "user", content: results });
    if (session.ended) break;
  }
  return { say: spoken.join(" "), actions, ended: session.ended };
}

// ---------------------------------------------------------------------------- scripted engine
// Deterministic ladder. Intent is read from the English translation of what the customer said
// (Sarvam STT translate mode), plus the raw text for typed Hinglish.

const RX = {
  yes: /\b(haan|haa|han|hanji|haanji|ji haan|yes|yeah|yep|yup|ok|okay|theek|thik|sure|kar do|kardo|karo|chalega|bilkul|zaroor|jaroor|done|agree|sahi|accha|achha|go ahead|tell me|speak|please do|alright|of course|fine|will add|i will|i'll|हाँ|हां|ठीक)\b/i,
  no: /\b(nahi|nahin|nhi|no|nope|mat|not|mushkil|don'?t|do not|can'?t|cannot|won'?t|unable|नहीं)\b/i,
  busy: /\b(busy|baad mein|baad me|later|call back|callback|call me tomorrow|kal baat|not a good time)\b/i,
  wrong: /\b(wrong number|galat number|not murari|murari nahi)\b/i,
  cancel: /\b(cancel|band kar|bandh|close the sip|stop the sip|stop my sip|stop sip|stop it|khatam|बंद)/i,
  pause: /\b(pause|rok|ruk|break|hold|रोक)/i,
  reduce: /\b(kam kar|kam karo|kam kardo|amount kam|ghata|reduce|lower|decrease|50|pachas|fifty|chhota)\b/i,
  bank: /\b(bank|account|khata|dusra|doosra|another|other|sbi|hdfc|icici|axis|kotak|अकाउंट)\b/i,
  topup: /\b(daal|dal|add|jama|top ?up|transfer|deposit|put money)\b/i,
};
const pauseDays = (t) => (/\b(30|thirty|tees|month|mahina)\b/i.test(t) ? 30 : /\b(7|seven|saat|week|hafta)\b/i.test(t) ? 7 : 15);

function decide(session, raw, english) {
  const t = `${english || ""} | ${raw || ""}`.toLowerCase();
  const s = session.stage;
  const act = [];
  const end = (line, outcome, summary, extra = []) => ({ line, act: [...extra, ["end_call", { outcome, summary }]], ended: true });

  if (s === "start") { session.stage = "consent"; return { line: "hello", act }; }
  if (RX.wrong.test(t)) return end("wrong_person", "WRONG_PERSON", "Wrong person picked up.");
  if (RX.busy.test(t) && s === "consent") return end("busy", "CALLBACK_SCHEDULED", "Customer was busy; callback scheduled for tomorrow 19:00.", [["schedule_callback", { when: "tomorrow 19:00" }]]);

  if (RX.cancel.test(t)) {
    if (session.cancelAsked) return end("cancel_yes", "SIP_CANCELLED", "Customer insisted on cancelling after being offered a pause.", [["cancel_sip", { reason: "Customer insisted after a pause was offered" }, "cancel"]]);
    session.cancelAsked = true; session.stage = "pause"; return { line: "cancel_pushback", act };
  }
  const no = RX.no.test(t);
  const yes = RX.yes.test(t) && !no;
  if (s !== "consent" && RX.pause.test(t) && !no) session.stage = "pause";
  else if (s !== "consent" && s !== "pause" && RX.reduce.test(t) && !no && !/\b500\b/.test(t)) session.stage = "reduce";

  switch (session.stage) {
    case "consent":
      if (no && !yes && !/\bbaat\b|talk/.test(t)) return end("busy", "CALLBACK_SCHEDULED", "Customer could not talk; callback scheduled.", [["schedule_callback", { when: "tomorrow 19:00" }]]);
      session.stage = "topup"; session.unclearCount = 0; return { line: "explain", act };
    case "topup":
      if (yes || (RX.topup.test(t) && !no)) return end("topup_yes", "TOPUP_COMMITTED", "Customer agreed to add 500 rupees tonight; top-up link sent.", [["send_topup_link", { amount_inr: 500 }, "topup"]]);
      if (!no && session.unclearCount < 1) { session.unclearCount++; return { line: "unclear", act }; }
      session.stage = "reduce"; session.unclearCount = 0; return { line: "offer_reduce", act };
    case "reduce":
      if (yes || (RX.reduce.test(t) && !no)) return end("reduce_yes", "SIP_REDUCED", "Customer agreed to lower the daily SIP from 100 to 50 rupees.", [["reduce_sip_amount", { new_amount_inr: 50 }, "reduce"]]);
      if (!no && session.unclearCount < 1) { session.unclearCount++; return { line: "unclear", act }; }
      session.stage = "bank"; session.unclearCount = 0; return { line: "offer_bank", act };
    case "bank":
      if (yes) return end("bank_yes", "BANK_CHANGE_LINK_SENT", "Customer will move AutoPay to another bank; link sent.", [["change_bank_account", {}, "bank"]]);
      if (!no && session.unclearCount < 1) { session.unclearCount++; return { line: "unclear", act }; }
      session.stage = "pause"; session.unclearCount = 0; return { line: "offer_pause", act };
    case "pause": {
      if (yes || (RX.pause.test(t) && !no) || /\b(7|15|30)\b/.test(t) && !no) {
        const d = pauseDays(t);
        return end(`pause_${d}`, "SIP_PAUSED", `Customer chose to pause the SIP for ${d} days.`, [["pause_sip", { days: d }, `pause_${d}`]]);
      }
      if (!no && session.unclearCount < 1) { session.unclearCount++; return { line: "unclear", act }; }
      return end("no_change", "NO_CHANGE", "Customer declined every option; SIP continues unchanged.");
    }
  }
  return { line: "unclear", act };
}

const STAGE_OF_LINE = { hello: "start", explain: "topup", offer_reduce: "reduce", offer_bank: "bank", offer_pause: "pause", cancel_pushback: "pause" };

async function scriptedTurn(session, raw, english) {
  const prevStage = session.stage;
  const d = decide(session, raw, english);
  const actions = [];
  for (const [tool, input, smsKey] of d.act) {
    const args = { ...input };
    if (smsKey && SMS[smsKey]) args._sms = (await render(SMS[smsKey], session.lang)).text;
    const result = runTool(tool, args);
    actions.push({ tool, input, result });
  }
  if (d.ended) session.ended = true;
  const r = await render(LINES[d.line], session.lang);
  const offer = d.line === "unclear" ? session.lastOffer : STAGE_OF_LINE[d.line] ?? null;
  if (offer) session.lastOffer = offer;
  return { say: r.text, speak: r.speak, actions, ended: session.ended, offer: session.ended ? null : offer, lineId: d.line, prevStage };
}

// ---------------------------------------------------------------------------- sessions

let session = null;

export function engineName() {
  return claudeAvailable() ? `Claude (${MODEL})` : "Scripted";
}

export async function startCall(lang = "hinglish") {
  session = { messages: [], stage: "start", ended: false, lang, unclearCount: 0, engine: claudeAvailable() ? "claude" : "scripted" };
  return turn("Hello?", "Hello?");
}

export async function turn(text, english) {
  if (!session) throw new Error("No active call. Start a call first.");
  if (session.ended) return { say: "", actions: [], ended: true, engine: session.engine };
  if (session.engine === "claude") {
    try {
      const r = await claudeTurn(session, text);
      return { ...r, speak: r.say, engine: session.engine };
    } catch (err) {
      console.error("[agent] Claude error, switching this call to the scripted engine:", err.message);
      session.engine = "scripted";
      session.stage = session.messages.length > 2 ? "topup" : "start";
      session.fallbackReason = err.message;
    }
  }
  const r = await scriptedTurn(session, text, english);
  return { ...r, engine: session.engine, fallbackReason: session.fallbackReason };
}

export function currentLang() { return session?.lang ?? "hinglish"; }

export function endCallManually() {
  if (session && !session.ended) {
    api.endCall({ outcome: "NO_CHANGE", summary: "Call ended from the demo screen before an outcome." });
    session.ended = true;
  }
}
