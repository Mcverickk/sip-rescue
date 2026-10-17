// SIP Rescue conversation agent.
// Two engines share the same mocked tools:
//   - "claude": Claude Opus 5 with tool use (needs ANTHROPIC_API_KEY or another SDK credential)
//   - "scripted": a deterministic ladder state machine, so the demo always works offline
import Anthropic from "@anthropic-ai/sdk";
import { api, fixture } from "./mockApi.mjs";

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

Language: Hinglish in Latin script (for example "Namaste Murari ji, main Bachatt se Sia bol rahi hoon"). Switch to simple English if the customer speaks English. Say amounts as "500 rupaye", never with the rupee symbol. Keep every turn to one to three short sentences and end with one clear question, except the goodbye.

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
      system: SYSTEM,
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

const RX = {
  yes: /\b(haan|haa|han|ha|hanji|haanji|ji haan|yes|yeah|yup|ok|okay|theek|thik|sure|kar do|kardo|karo|chalega|bilkul|zaroor|jaroor|done|agree|sahi|accha|achha)\b/i,
  no: /\b(nahi|nahin|nhi|no|nope|mat|not|mushkil|don'?t|do not|can'?t|cannot|won'?t)\b/i,
  busy: /\b(busy|baad mein|baad me|later|abhi nahi baat|call back|callback|kal baat)\b/i,
  wrong: /\b(wrong number|galat number|murari nahi|not murari)\b/i,
  cancel: /\b(cancel|band kar|bandh|close the sip|stop kar|stop the sip|khatam)/i,
  pause: /\b(pause|rok|ruk|break|hold)\b/i,
  reduce: /\b(kam kar|kam karo|kam kardo|amount kam|ghata|reduce|lower|50|pachas|fifty|chhota)\b/i,
  bank: /\b(bank|account|khata|dusra|doosra|another|other)\b/i,
  topup: /\b(daal|dal|add|jama|top ?up|transfer|paise|rupaye|deposit)\b/i,
};
const days = (t) => (/\b30|tees|thirty|mahina|month\b/i.test(t) ? 30 : /\b7\b|saat|seven|hafta|week/i.test(t) ? 7 : 15);

const L = {
  hello: `Namaste ${f.user.display_name}, main Bachatt se Sia bol rahi hoon, aapke Smart Deposit savings ke baare mein. Kya abhi do minute baat kar sakte hain?`,
  explain: `Shukriya. Aapka 100 rupaye ka roz ka SIP pichhle do din, 12 aur 13 October ko, ${f.bank.name} account mein kam balance ki wajah se fail hua. Koi penalty nahi lagti, bas us din ki bachat chhoot jaati hai. Kal subah phir 100 rupaye katenge, aur abhi balance sirf 149 rupaye dikh raha hai. Kya aap aaj raat account ending ${f.bank.acct_last4} mein kam se kam 500 rupaye daal sakte hain?`,
  offerReduce: `Koi baat nahi. Toh kya hum aapka SIP 100 se ghata kar 50 rupaye roz kar dein? Bachat chalti rahegi aur debit fail nahi hoga.`,
  offerBank: `Samajh gayi. Kya aap kisi doosre bank account mein paise rakhte hain? Main ek link bhej sakti hoon jisse AutoPay us account par shift ho jaaye.`,
  offerPause: `Theek hai. Toh kya hum SIP ko 15 din ke liye pause kar dein? Woh apne aap 29 October se phir shuru ho jaayega. Aap chahein toh 7 ya 30 din bhi kar sakte hain.`,
  cancelPushback: `Main samajh sakti hoon. Band karne ki jagah hum ise 15 din ke liye pause kar sakte hain, aapke paise invested rahenge aur baad mein bina kisi jhanjhat ke shuru ho jaayega. Kya pause kar dein?`,
};

function scripted(session, text) {
  const t = (text || "").toLowerCase();
  const out = [];
  const act = (tool, input) => {
    const result = runTool(tool, input);
    session.actionsThisTurn.push({ tool, input, result });
    return result;
  };
  const finish = (line, outcome, summary) => {
    out.push(line);
    act("end_call", { outcome, summary });
    session.ended = true;
  };
  session.actionsThisTurn = [];
  const s = session.stage;

  if (s === "start") { session.stage = "consent"; return L.hello; }
  if (RX.wrong.test(t)) { finish("Maaf kijiye, galat number lag gaya. Aapka din shubh ho.", "WRONG_PERSON", "Wrong person picked up."); return out.join(" "); }
  if (RX.busy.test(t) && !/\bnahi\b.*\bbusy\b/.test(t)) {
    act("schedule_callback", { when: "tomorrow 19:00" });
    finish("Bilkul, main kal shaam 7 baje phir call karti hoon. Dhanyavaad Murari ji.", "CALLBACK_SCHEDULED", "Customer was busy; callback scheduled for tomorrow 19:00.");
    return out.join(" ");
  }
  if (RX.cancel.test(t)) {
    if (session.cancelAsked) {
      act("cancel_sip", { reason: "Customer insisted on cancelling after a pause was offered." });
      finish("Theek hai, maine aapka SIP band kar diya hai. Aapke invested paise surakshit rahenge, SMS se confirmation aa jaayega. Dhanyavaad Murari ji.", "SIP_CANCELLED", "Customer insisted on cancelling after being offered a pause.");
      return out.join(" ");
    }
    session.cancelAsked = true; session.stage = "pause"; return L.cancelPushback;
  }
  // direct jumps to a later ladder option
  if (s !== "consent" && RX.pause.test(t) && !RX.no.test(t)) session.stage = "pause";
  if (s !== "consent" && RX.reduce.test(t) && !RX.no.test(t) && s !== "reduce" && s !== "pause") { session.stage = "reduce"; }

  const yes = RX.yes.test(t) && !RX.no.test(t);
  const no = !yes && (RX.no.test(t) || /mushkil|paise nahi|nahi hai|nahi hain|can't|cannot/.test(t));

  switch (session.stage) {
    case "consent":
      if (no && !/\bbaat\b/.test(t)) { act("schedule_callback", { when: "tomorrow 19:00" }); finish("Koi baat nahi, main kal shaam 7 baje call karti hoon. Dhanyavaad.", "CALLBACK_SCHEDULED", "Customer could not talk; callback scheduled."); return out.join(" "); }
      session.stage = "topup"; return L.explain;
    case "topup":
      if (yes || (RX.topup.test(t) && !no)) {
        act("send_topup_link", { amount_inr: 500 });
        finish("Bahut badhiya! Maine aapko SMS par ek link bhej diya hai, aaj raat 500 rupaye daal dijiye. Kal subah ka debit hum check kar lenge. Dhanyavaad Murari ji, aapka din shubh ho.", "TOPUP_COMMITTED", "Customer agreed to add 500 rupees tonight; top-up link sent.");
        return out.join(" ");
      }
      session.stage = "reduce"; return L.offerReduce;
    case "reduce":
      if (yes || (RX.reduce.test(t) && !no)) {
        const amt = /\b(70|75|80)\b/.exec(t)?.[1] ?? 50;
        act("reduce_sip_amount", { new_amount_inr: Number(amt) });
        finish(`Ho gaya! Kal se aapka SIP ${amt} rupaye roz ka hai. SMS se confirmation aa jaayega. Dhanyavaad Murari ji, bachat jaari rakhiye.`, "SIP_REDUCED", `Customer agreed to reduce the daily SIP from 100 to ${amt} rupees.`);
        return out.join(" ");
      }
      session.stage = "bank"; return L.offerBank;
    case "bank":
      if (yes || (RX.bank.test(t) && !no)) {
        act("change_bank_account", {});
        finish("Maine SMS par link bhej diya hai. Usse kholkar naye account par UPI AutoPay approve kar dijiye, tab tak purana SIP chalta rahega. Dhanyavaad Murari ji.", "BANK_CHANGE_LINK_SENT", "Customer will move the AutoPay mandate to another bank; link sent.");
        return out.join(" ");
      }
      session.stage = "pause"; return L.offerPause;
    case "pause":
      if (yes || RX.pause.test(t) || /\b(7|15|30)\b/.test(t)) {
        const d = days(t);
        const r = act("pause_sip", { days: d });
        finish(`Theek hai, aapka SIP ${d} din ke liye pause kar diya hai, ${r.resumes_on} se apne aap shuru hoga. SMS se confirmation aa jaayega. Dhanyavaad Murari ji.`, "SIP_PAUSED", `Customer chose to pause the SIP for ${d} days.`);
        return out.join(" ");
      }
      finish("Koi baat nahi, aapka SIP jaisa hai waisa chalta rahega. Koi bhi badlav app mein kabhi bhi kar sakte hain. Dhanyavaad Murari ji.", "NO_CHANGE", "Customer declined every option; SIP continues unchanged.");
      return out.join(" ");
    default:
      return "Ji, main sun rahi hoon.";
  }
}

// ---------------------------------------------------------------------------- sessions

let session = null;

export function engineName() {
  return claudeAvailable() ? `Claude (${MODEL})` : "Scripted";
}

export async function startCall() {
  session = { messages: [], stage: "start", ended: false, engine: claudeAvailable() ? "claude" : "scripted" };
  return turn("Hello?");
}

export async function turn(text) {
  if (!session) throw new Error("No active call. Start a call first.");
  if (session.ended) return { say: "", actions: [], ended: true, engine: session.engine };
  if (session.engine === "claude") {
    try {
      const r = await claudeTurn(session, text);
      return { ...r, engine: session.engine };
    } catch (err) {
      console.error("[agent] Claude error, switching this call to the scripted engine:", err.message);
      session.engine = "scripted";
      session.stage = session.messages.length > 2 ? "topup" : "start";
      session.fallbackReason = err.message;
    }
  }
  const say = scripted(session, text);
  return { say, actions: session.actionsThisTurn ?? [], ended: session.ended, engine: session.engine, fallbackReason: session.fallbackReason };
}

export function endCallManually() {
  if (session && !session.ended) {
    api.endCall({ outcome: "NO_CHANGE", summary: "Call ended from the demo screen before an outcome." });
    session.ended = true;
  }
}
