// SIP Rescue voice agent, powered by Claude.
// Sarvam detects the language Murari speaks; Claude understands him, decides what to do (calling the
// mocked Bachatt APIs as tools) and replies in the same language. Replies are streamed and cut into
// sentences so each one can be voiced while Claude is still writing the next.
import "./env.mjs";
import Anthropic from "@anthropic-ai/sdk";
import { api } from "./mockApi.mjs";
import { LANGUAGES } from "./sarvam.mjs";

const MODEL = process.env.SIP_RESCUE_MODEL || "claude-opus-5";
const EFFORT = process.env.SIP_RESCUE_EFFORT || "low"; // voice needs fast turns

export const claudeReady = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
export const engineName = () => `Claude (${MODEL})`;

let client = null;
function getClient() {
  if (client) return client;
  const ws = process.env.ANTHROPIC_WORKSPACE_ID;
  client = new Anthropic(ws ? { defaultHeaders: { "anthropic-workspace-id": ws } } : {});
  return client;
}

// ---------------------------------------------------------------------------- tools (mocked APIs)
// Inputs are tiny, so tool-input streaming stays off and the API validates them for us.

const smsField = { type: "string", description: "Confirmation SMS to Murari, in the language of the call, under 140 characters, signed '- Bachatt'. Do not write any link or URL; the real link is added automatically." };
const TOOLS = [
  {
    name: "send_topup_link",
    description: "Offer 1. Texts Murari a link to add money to his Bank of Baroda account XX9428 tonight. Call it as soon as he agrees to add money.",
    input_schema: { type: "object", properties: { amount_inr: { type: "integer", description: "Rupees he agreed to add, 500 unless he named another amount." }, sms_text: smsField }, required: ["amount_inr", "sms_text"], additionalProperties: false },
  },
  {
    name: "reduce_sip_amount",
    description: "Offer 2. Lowers his daily SIP from 100 rupees, starting with tomorrow's debit. Minimum 50. Call it as soon as he agrees to a lower amount.",
    input_schema: { type: "object", properties: { new_amount_inr: { type: "integer", description: "New daily amount, 50 to 99." }, sms_text: smsField }, required: ["new_amount_inr", "sms_text"], additionalProperties: false },
  },
  {
    name: "change_bank_account",
    description: "Offer 3. Texts him a link to move the UPI AutoPay to another bank account where he keeps money. Call it as soon as he agrees.",
    input_schema: { type: "object", properties: { sms_text: smsField }, required: ["sms_text"], additionalProperties: false },
  },
  {
    name: "pause_sip",
    description: "Offer 4. Pauses the SIP for 7, 15 or 30 days; it restarts automatically (15 days restarts on 29 Oct). Call it as soon as he agrees.",
    input_schema: { type: "object", properties: { days: { type: "integer", enum: [7, 15, 30] }, sms_text: smsField }, required: ["days", "sms_text"], additionalProperties: false },
  },
  {
    name: "cancel_sip",
    description: "Stops the SIP. Never offer it. Only when he insists on cancelling a second time after you offered a pause.",
    input_schema: { type: "object", properties: { reason: { type: "string" }, sms_text: smsField }, required: ["reason", "sms_text"], additionalProperties: false },
  },
  {
    name: "schedule_callback",
    description: "Books a callback when he is busy or asks to talk later.",
    input_schema: { type: "object", properties: { when: { type: "string", description: "e.g. 'tomorrow 7 pm'" } }, required: ["when"], additionalProperties: false },
  },
  {
    name: "end_call",
    description: "Hangs up and records the outcome. Call it in the same turn as your goodbye.",
    input_schema: {
      type: "object",
      properties: {
        outcome: { type: "string", enum: ["TOPUP_COMMITTED", "SIP_REDUCED", "BANK_CHANGE_LINK_SENT", "SIP_PAUSED", "SIP_CANCELLED", "CALLBACK_SCHEDULED", "NO_CHANGE", "WRONG_PERSON"] },
        summary: { type: "string", description: "One English sentence for the ops team." },
      },
      required: ["outcome", "summary"],
      additionalProperties: false,
    },
  },
];

const str = (v) => (typeof v === "string" ? v : "");
function runTool(name, input) {
  const i = input && typeof input === "object" ? input : {};
  switch (name) {
    case "send_topup_link": return api.topupLink({ amount_inr: Number(i.amount_inr) || 500, _sms: str(i.sms_text) });
    case "reduce_sip_amount": return api.reduceSip({ new_amount_inr: Number(i.new_amount_inr), _sms: str(i.sms_text) });
    case "change_bank_account": return api.changeBank({ _sms: str(i.sms_text) });
    case "pause_sip": return api.pauseSip({ days: Number(i.days), _sms: str(i.sms_text) });
    case "cancel_sip": return api.cancelSip({ reason: str(i.reason), _sms: str(i.sms_text) });
    case "schedule_callback": return api.scheduleCallback({ when: str(i.when) });
    case "end_call": return api.endCall({ outcome: str(i.outcome) || "NO_CHANGE", summary: str(i.summary) });
    default: return { ok: false, error: "unknown tool " + name };
  }
}

// ---------------------------------------------------------------------------- prompt

const SYSTEM = `You are Sia, a warm and upbeat savings assistant from Bachatt, on a live phone call. Everything you write is spoken aloud by a text-to-speech voice.

# How you sound
- Talk like a friendly person from a local bank branch: warm, quick, natural. Use small spoken touches like "जी", "अच्छा", "बिल्कुल" where they fit.
- Keep each reply to one or two short sentences, at most about 25 words, ending with one simple question. Short replies keep the call fast.
- Open every reply with a tiny sentence of two to five words, like "अच्छा जी।", "कोई बात नहीं जी।" or "बिल्कुल!", so the customer hears you right away. Then say the rest.
- Write for the ear: no lists, no symbols, no emoji, no brackets except the stage tag below. Write money as "500 रुपये" or "500 rupees", never with the rupee sign.

# Language
- Each customer message arrives as <customer lang="xx-IN">…</customer>; the language was detected from his voice. Always reply in that same language, and switch the moment he switches. If the words clearly belong to another language than the tag (for example typed English), follow the words.
- Write in that language's own script so the voice pronounces it well (Devanagari for Hindi, Tamil script for Tamil, and so on), keeping everyday English words such as SIP, account, balance, app, link and AutoPay in English letters. Hindi should sound like everyday Hinglish, not formal Hindi.
- Write every word of a reply in one script, including Murari's name (मुरारी in Hindi, முராரி in Tamil, and so on); only the everyday English words stay in English letters.
- Open the call in Hindi, because Murari is from Pali, Rajasthan.

# Stage tag
Start every reply with exactly one tag naming what this reply does: [greet], [explain], [topup], [reduce], [bank], [pause], [cancel_pushback] or [close]. It is removed before speaking.

# The situation (it is Monday 13 October 2026, 7 pm)
- Murari saves 100 rupees every day in Bachatt's Smart Deposit (two liquid funds). He has about 140 rupees saved so far.
- Tomorrow morning 100 rupees will be debited from his Bank of Baroda account ending 9428.
- The last two debits, on 12 and 13 October, bounced for low balance. His balance is now 149 rupees and the bank keeps a minimum balance aside, so tomorrow's debit will likely bounce too.
- A bounced debit has no penalty or charge. He only misses that day's saving. Say this early so he isn't worried.

# The call
1. Greet him by name, say you're Sia from Bachatt calling about his savings, and ask if it's a good time. Wrong person: apologise and end. Busy: book a callback and end.
2. In one or two sentences: praise his daily saving habit, say two debits bounced for low balance, say there's no penalty, then make offer 1.
3. Offers, strictly one per reply and in this order, moving on only when he declines:
   1) add at least 500 rupees to the account tonight so his saving streak doesn't break,
   2) save 50 rupees a day instead of 100,
   3) move the AutoPay to another bank account where he keeps money,
   4) a short break of 7, 15 or 30 days (suggest 15) that restarts on its own.
   If he asks for a later option directly, go straight to it.
4. When he agrees to the offer you just described, that is his confirmation, so act at once without asking again. In that same reply, first write what you say (it's done, an SMS is on its way, a warm one-line goodbye), then call the offer's tool and end_call. Speaking first means he hears you without waiting.
5. Never offer cancellation. If he asks to cancel, offer the break once ([cancel_pushback]). Cancel only if he insists again.
6. If he declines everything, say his saving continues as it is, thank him, and end the call with NO_CHANGE.
7. If you can't make out what he said, ask him to repeat it, briefly.

# Rules
Never ask for OTP, PIN, card or account numbers. Never invent penalties, charges, credit-score effects or returns. Never pressure him.`;

// ---------------------------------------------------------------------------- streaming turn

const STAGE_TAG = /^\s*\[(greet|explain|topup|reduce|bank|pause|cancel_pushback|close)\]\s*/i;
const SENTENCE_END = /([.!?।॥]+["'”’)]?)(\s+|$)/;

// Cuts streamed text into speakable chunks: full sentences, or long clauses at a comma.
function makeSplitter(onChunk) {
  let buf = "";
  const flush = (force = false) => {
    for (;;) {
      const m = SENTENCE_END.exec(buf);
      if (m && m.index + m[1].length >= 2 && (m[2] || force)) {
        const end = m.index + m[1].length;
        const chunk = buf.slice(0, end).trim();
        buf = buf.slice(end + m[2].length);
        if (chunk) onChunk(chunk);
        continue;
      }
      if (buf.length > 140) {
        const cut = buf.lastIndexOf(",", 120);
        if (cut > 30) { onChunk(buf.slice(0, cut + 1).trim()); buf = buf.slice(cut + 1); continue; }
      }
      break;
    }
    if (force && buf.trim()) { onChunk(buf.trim()); buf = ""; }
  };
  return { push: (t) => { buf += t; flush(); }, end: () => flush(true) };
}

let session = null;

export function startSession() {
  session = { messages: [], lang: "hi-IN", ended: false, outcome: null };
  return session;
}
export const currentLang = () => session?.lang ?? "hi-IN";

/**
 * Runs one customer turn and streams what happens through emit(event):
 *   {type:"stage", stage}  {type:"sentence", text}  {type:"action", tool, input, result}  {type:"ended"}
 */
export async function turn({ text, lang }, emit) {
  if (!session) startSession();
  if (session.ended) return;
  if (lang && LANGUAGES[lang]) session.lang = lang;
  session.messages.push({ role: "user", content: `<customer lang="${session.lang}">${text}</customer>` });

  let spoke = false, endPending = false;
  for (let hop = 0; hop < 4 && !session.ended; hop++) {
    let tagChecked = false, head = "";
    const splitter = makeSplitter((s) => { spoke = true; emit({ type: "sentence", text: s }); });

    const stream = getClient().beta.messages.stream({
      model: MODEL,
      max_tokens: 2000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: EFFORT },
      system: SYSTEM,
      tools: TOOLS,
      messages: session.messages,
    });

    for await (const ev of stream) {
      if (ev.type !== "content_block_delta" || ev.delta.type !== "text_delta") continue;
      let t = ev.delta.text;
      if (!tagChecked) {
        // Hold back the first characters until we know whether they are a stage tag.
        head += t;
        if (head.length < 24 && !head.includes("]") && head.trimStart().startsWith("[")) continue;
        if (!head.trim()) continue;
        const m = STAGE_TAG.exec(head);
        if (m) emit({ type: "stage", stage: m[1].toLowerCase() });
        t = m ? head.slice(m[0].length) : head;
        tagChecked = true;
      }
      splitter.push(t);
    }
    if (!tagChecked && head.trim()) splitter.push(head.replace(STAGE_TAG, ""));
    splitter.end();

    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") throw new Error("Claude declined this turn.");
    session.messages.push({ role: "assistant", content: msg.content });
    if (msg.stop_reason === "max_tokens") throw new Error("Reply was cut off.");

    const toolUses = msg.content.filter((b) => b.type === "tool_use");
    if (msg.stop_reason !== "tool_use" || toolUses.length === 0) { if (endPending) session.ended = true; break; }

    const results = [];
    for (const tu of toolUses) {
      if (tu.name === "end_call" && endPending) { results.push({ type: "tool_result", tool_use_id: tu.id, content: '{"ok":true}' }); continue; }
      const result = runTool(tu.name, tu.input);
      emit({ type: "action", tool: tu.name, input: tu.input, result });
      let content = JSON.stringify(result);
      if (tu.name === "end_call") {
        session.outcome = tu.input?.outcome;
        // Never hang up in silence: if nothing was said this turn, get the goodbye spoken first.
        if (spoke) session.ended = true;
        else { endPending = true; content = JSON.stringify({ ok: true, note: "Recorded. Now say your short confirmation and goodbye to Murari in his language. Do not call any tool." }); }
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content, is_error: result.ok === false });
    }
    session.messages.push({ role: "user", content: results });
    if (endPending && hop >= 2) session.ended = true;
  }
  if (endPending) session.ended = true;
  if (session.ended) emit({ type: "ended" });
}

export function endCallManually() {
  if (session && !session.ended) {
    api.endCall({ outcome: "NO_CHANGE", summary: "Call ended from the demo screen before an outcome." });
    session.ended = true;
  }
}
