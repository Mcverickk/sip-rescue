// Mocked Bachatt internal APIs. Everything lives in memory and every call is logged
// so the demo can show the exact request and response on screen.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const fixture = JSON.parse(fs.readFileSync(path.join(here, "data", "murari.json"), "utf8"));

let state;
let seq = 0;

function demoClock() {
  // Freeze the demo on 13 Oct 2026, starting at 19:00 IST, advancing with real time.
  const start = Date.parse(fixture.demo_now);
  const elapsed = Date.now() - state.startedAt;
  return new Date(start + elapsed);
}
function ist(d = demoClock()) {
  return new Date(d.getTime() + 5.5 * 3600e3).toISOString().replace("T", " ").slice(0, 19);
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function newId() {
  return String(898000000000000000n + BigInt(Math.floor(Math.random() * 1e12)));
}

export function reset() {
  const s = fixture.sip;
  state = {
    startedAt: Date.now(),
    plans: [{ ...s, updated_at: s.activated_at }],
    log: [],
    sms: [],
    outcome: null,
  };
  seq = 0;
}
reset();

export function snapshot() {
  return { plans: state.plans, log: state.log, sms: state.sms, outcome: state.outcome, now: ist() };
}

function activePlan() {
  return state.plans.find((p) => p.status === "ACTIVE" || p.status === "PAUSED") ?? state.plans[0];
}

function record(method, pathStr, request, response, status = 200) {
  const entry = { id: ++seq, at: ist(), method, path: pathStr, status, request, response };
  state.log.push(entry);
  return entry;
}

function sendSms(text) {
  const u = fixture.user;
  const msg = { to: u.mobile_masked, sender: "AX-BACHTT-S", text, at: ist() };
  state.sms.push(msg);
  record("POST", "/internal/v1/notifications/sms", { user_id: u.user_id, to: u.mobile_masked, template: "SIP_RESCUE_CONFIRMATION", text },
    { message_id: "sms_" + Math.random().toString(36).slice(2, 10), status: "QUEUED" }, 202);
  return msg;
}

// --- the actual mocked endpoints -------------------------------------------------------

export const api = {
  topupLink({ amount_inr }) {
    const u = fixture.user, b = fixture.bank;
    const amount = Math.max(1, Math.round(Number(amount_inr) || fixture.decision.suggested_topup_inr));
    const link = `https://bachatt.app/t/${Math.random().toString(36).slice(2, 8)}`;
    const res = record("POST", "/internal/v1/users/" + u.user_id + "/topup-link",
      { amount_inr: amount, bank: b.name, acct_last4: b.acct_last4, reason: "SIP_PRE_DEBIT_LOW_BALANCE" },
      { link_id: "tl_" + Math.random().toString(36).slice(2, 10), deeplink: link, upi_intent: `upi://pay?am=${amount}&tn=Add%20money%20to%20BOB%20XX${b.acct_last4}`, expires_at: addDays("2026-10-13", 1) + " 08:00:00", follow_up: "VERIFY_DEBIT_2026-10-14" });
    sendSms(`Murari ji, ${b.name} a/c XX${b.acct_last4} mein ${amount} rupaye add karein taaki kal subah ka 100 rupaye ka Smart Deposit SIP safal ho. Link: ${link} - Bachatt`);
    return { ok: true, link, amount_inr: amount, note: "Link sent by SMS. Debit will be verified tomorrow morning." };
  },

  reduceSip({ new_amount_inr }) {
    const old = activePlan();
    const amt = Math.round(Number(new_amount_inr));
    const min = fixture.sip.min_sip_amount_inr;
    if (!(amt >= min) || amt >= old.amount_inr) {
      const err = { error: "INVALID_AMOUNT", message: `New amount must be between ${min} and ${old.amount_inr - 1} rupees.` };
      record("POST", `/internal/v1/sips/${old.sip_plan_id}/modify`, { new_amount_inr: amt }, err, 422);
      return { ok: false, ...err };
    }
    const now = ist();
    const fresh = { ...old, sip_plan_id: newId(), amount_inr: amt, plan_type: "MODIFY", replaces_sip_plan_id: old.sip_plan_id, status: "ACTIVE", created_at: now, activated_at: now, first_debit_date: "2026-10-14", updated_at: now };
    Object.assign(old, { status: "CANCELLED", cancelled_at: now, cancellation_reason: "MODIFIED", updated_at: now });
    state.plans.push(fresh);
    record("POST", `/internal/v1/sips/${old.sip_plan_id}/modify`, { new_amount_inr: amt, effective_from: "2026-10-14", source: "SIP_RESCUE_AGENT" },
      { old_plan: { sip_plan_id: old.sip_plan_id, status: old.status, cancellation_reason: old.cancellation_reason }, new_plan: fresh, pre_debit_notice: "Re-issued for 2026-10-14 at the new amount" });
    sendSms(`Murari ji, aapka Smart Deposit SIP ab roz ${amt} rupaye ka hai, kal 14 Oct se. Kabhi bhi app mein badal sakte hain. - Bachatt`);
    return { ok: true, new_sip_plan_id: fresh.sip_plan_id, new_amount_inr: amt, effective_from: "2026-10-14" };
  },

  changeBank() {
    const old = activePlan();
    const link = `https://bachatt.app/m/${Math.random().toString(36).slice(2, 8)}`;
    const now = ist();
    const pending = { ...old, sip_plan_id: newId(), plan_type: "MODIFY", replaces_sip_plan_id: old.sip_plan_id, status: "INITIATED", created_at: now, activated_at: "", first_debit_date: "", updated_at: now, note: "Waiting for UPI AutoPay approval on the new bank account" };
    state.plans.push(pending);
    record("POST", `/internal/v1/sips/${old.sip_plan_id}/change-bank`, { reason: "REPEATED_INSUFFICIENT_FUNDS", source: "SIP_RESCUE_AGENT" },
      { new_plan: pending, mandate_setup_link: link, old_plan_status: "ACTIVE until new mandate is approved" });
    sendSms(`Murari ji, naye bank account se SIP jodne ke liye yeh link kholein aur UPI AutoPay approve karein: ${link} - Bachatt`);
    return { ok: true, mandate_setup_link: link, note: "Old plan keeps running until the new mandate is approved." };
  },

  pauseSip({ days }) {
    const p = activePlan();
    const d = [7, 15, 30].includes(Number(days)) ? Number(days) : 15;
    const now = ist();
    const resumes = addDays("2026-10-14", d);
    Object.assign(p, { status: "PAUSED", paused_at: now, resumes_on: resumes, updated_at: now });
    record("POST", `/internal/v1/sips/${p.sip_plan_id}/pause`, { days: d, source: "SIP_RESCUE_AGENT" },
      { sip_plan_id: p.sip_plan_id, status: "PAUSED", paused_at: now, resumes_on: resumes, skipped_debits: d, pre_debit_notice: "Revoked for 2026-10-14" });
    sendSms(`Murari ji, aapka Smart Deposit SIP ${d} din ke liye pause hai. ${resumes} se apne aap shuru hoga. - Bachatt`);
    return { ok: true, days: d, resumes_on: resumes };
  },

  cancelSip({ reason }) {
    const p = activePlan();
    const now = ist();
    Object.assign(p, { status: "CANCELLED", cancelled_at: now, cancellation_reason: "USER_CANCELLED", updated_at: now });
    record("POST", `/internal/v1/sips/${p.sip_plan_id}/cancel`, { reason: reason || "USER_REQUESTED_ON_CALL", source: "SIP_RESCUE_AGENT" },
      { sip_plan_id: p.sip_plan_id, status: "CANCELLED", cancellation_reason: "USER_CANCELLED", cancelled_at: now, mandate_revoked: true });
    sendSms(`Murari ji, aapka Smart Deposit SIP band kar diya gaya hai. Aapke 140 rupaye invested rahenge. - Bachatt`);
    return { ok: true, status: "CANCELLED" };
  },

  scheduleCallback({ when }) {
    const u = fixture.user;
    const at = when || "tomorrow 19:00";
    record("POST", "/internal/v1/callbacks", { user_id: u.user_id, requested_time: at, call_type: "CONVERSATION_CALL" },
      { callback_id: "cb_" + Math.random().toString(36).slice(2, 10), scheduled_for: at, status: "SCHEDULED" });
    return { ok: true, scheduled_for: at };
  },

  endCall({ outcome, summary }) {
    const u = fixture.user;
    state.outcome = { outcome, summary, at: ist() };
    record("POST", "/internal/v1/call-outcomes", { user_id: u.user_id, call_type: "CONVERSATION_CALL", outcome, summary },
      { recorded: true });
    return { ok: true };
  },
};
