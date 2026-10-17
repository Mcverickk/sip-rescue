# SIP Rescue: design, data review and task split

As of 2026-10-17. Hackathon build, team of two. Data: `buildathon-data/` from the organisers.

## TL;DR

Every evening at 19:00 IST the system finds every SIP that debits tomorrow morning, reads the
user's latest bank balance from their bank SMS, and if the balance won't cover the debit it
places an AI voice call. First-time shortfall gets a 30-second heads-up. Repeat failers get a
conversation that walks the ladder: top up, lower the amount, change bank, pause. A prototype
pipeline already produces tonight's call list from the hackathon CSVs
(`pipeline/build_call_list.py`).

## 1. Why it matters (from the data)

| Metric | Value |
| --- | --- |
| SIP debits that failed for insufficient funds, 15 Jul to 13 Oct | 18,129 of 33,434 failures (54%) |
| Insufficient-funds failures per day | 291 on 29 Sep rising to 447 on 13 Oct |
| Last night's failure rate (debit on 14 Oct) | 447 of ~2,700 attempts (16%) |
| Due tomorrow (15 Oct) | 1,471 plans, 1,320 users, ₹2.36 lakh |
| Of those, failed last night for insufficient funds | 204 plans |
| Of those, failed 3+ times in the last 14 days | 255 plans |
| Plans already cancelled | 3,185 of 6,246 (51%) |

Each failed daily instalment is lost AUM, and repeated failures precede cancellation. There is
no penalty to the user, so nobody is nudging them today.

## 2. Product design

### Actors and timing

- Investor: Bachatt user with a UPI AutoPay SIP (daily, weekly or monthly).
- SIP Rescue agent: outbound voice agent, Hinglish by default.
- Ops: dashboard to watch the queue, outcomes and money rescued.

UPI AutoPay is two-step. The bank sends a pre-debit notice one morning and debits the next
morning. In the data, orders are created 07:00 to 11:00 and the money lands the next day
08:00 to 12:00. So the evening before, 19:00 to 20:00, is the right window: the user has all
evening to top up and we are inside the 09:00 to 21:00 calling window.

### The two call types

| | INFO_CALL | CONVERSATION_CALL |
| --- | --- | --- |
| Trigger | Balance below tomorrow's debit, no recent insufficient-funds history | Balance below debit AND (failed last night for insufficient funds OR streak of 2+ OR 3+ fails in 14 days). Also: no fresh balance but chronic failures |
| Length | Under 30 seconds | 2 to 4 minutes |
| Content | "Tomorrow morning ₹{amount} for your {product} SIP will be debited from your {bank} account ending {acct}. Your balance looks low, please keep ₹{amount} in it tonight. No penalty if it fails, but you miss a day of savings." | Agent explains the pattern ("your last 3 instalments bounced") and walks the ladder below |
| Inputs | Press 1 acknowledged, press 2 call back later | Free conversation with tool calls |
| Outcome | ACK, NO_ANSWER, CALLBACK | Ladder step reached + action taken |

### Priority ladder for the conversation call

1. Top up tonight. "Can you add ₹X to the {bank} account tonight?" Agent sends a UPI or app
   deep link by SMS/WhatsApp, marks FOLLOW_UP, outcome verified next morning from the order.
2. Lower the SIP amount. Offer the next step down (₹151 to ₹100, ₹100 to ₹50, never below the
   fund's minimum). Maps to `sip_plans.plan_type = MODIFY` with `replaces_sip_plan_id`.
3. Change the bank account. "Is there another account you usually keep money in?" Agent sends
   a link to set up a new mandate. Maps to a new plan in INITIATED replacing the old one.
4. Pause the SIP for 7, 15 or 30 days. Maps to `status = PAUSED`, `paused_at`, `resumes_on`.
5. Never offer cancellation. If the user insists, point them to the app.

All four outcomes already exist in the `sip_plans` schema, so the mock backend can write rows
that look exactly like production data.

### Guardrails

- At most one CONVERSATION_CALL per user per 7 days, at most two INFO_CALLs per week.
- No dialling after 20:45. One retry after 20 minutes on no-answer.
- Suppress calls while a pause or reduction from the last 7 days is in effect.
- The agent identifies as Bachatt, states there is no penalty, never asks for OTP, PIN or
  account numbers, reads back any change and gets an explicit yes before executing it, and
  confirms every change by SMS.
- Honour DND and an opt-out ("don't call me about this").

### Decision logic (as implemented in the prototype)

```
due tomorrow?
  └─ balance known, fresh (≤72h) and from the mandate-linked account?
       ├─ yes: balance ≥ amount + ₹20 buffer + ₹500 bank minimum-balance floor → NO_CALL
       │        balance ≥ amount but inside the floor (thin): chronic → CONVERSATION_CALL, else NO_CALL
       │        balance < amount: chronic → CONVERSATION_CALL, otherwise INFO_CALL
       └─ no (unknown or stale):
                chronic → CONVERSATION_CALL
                failed once recently → INFO_CALL
                otherwise → NO_CALL
chronic = failed last night for insufficient funds OR streak ≥ 2 OR ≥ 3 fails in 14 days
```

## 3. Data: what we use and how

| Signal | Source | How |
| --- | --- | --- |
| Debit due tomorrow | `orders.csv` rows with `buy_mode=SIP`, `status=INITIATED`, created today, plus `sip_plans.csv` ACTIVE plans whose schedule says tomorrow (DAILY; WEEKLY where `debit_day` is tomorrow's weekday; MONTHLY where `debit_day` is tomorrow's day) | Sum amount per plan, then aggregate per user |
| Debit amount | `orders.csv` / `sip_plans.csv` | Never from SMS. SMS amounts don't match the orders, the two datasets were synthesised independently |
| Bank balance | `sms.csv` bank alerts: "Bal INR 21.88", "AvlBal:Rs685.78", "Available balance Rs. 5,490.73", "Avl bal: 0.93", "Total Bal:Rs.14208.47CR" | Regex in the prototype, LLM fallback for unparsed bank-sender SMS |
| Which account the mandate debits | `sms.csv` Bachatt mandate SMS: "Sent Rs.200.00 from HDFC Bank A/c 7350 To bachatt", "E-Mandate! Rs.251.00 will be deducted on 07/10/26 For bachatt mandate" | Most frequent account last-4 per user |
| Failure history and streak | `orders.csv` with `status=FAILED`, `failure_reason=insufficient_funds`, per plan per day | Trailing streak, count in 14 days, failed last night |
| Name and phone | `loan/customers.csv` (`first_name`, `mobile`, `city`) | 11k users, covers all 24 SMS users |
| Optional extras | `emails.csv` "Payment failed for bachatt" receipts, bank "Average Monthly Balance" alerts, password-protected statements | Skip for the hackathon |

### Coverage, the main caveat

SMS exists for only 24 users. 21 have parseable balances, 13 have a mandate-to-account link,
and only 7 of tomorrow's 1,320 users have any balance signal. So the system has to be two-tier:

- Tier A, balance-aware: users whose bank SMS we can read. Precise shortfall, best messaging.
- Tier B, behaviour-based: everyone else, scored on insufficient-funds history. This is where
  the volume is tonight (394 of 395 calls in the prototype run).

In production Tier A grows with SMS-read consent in the Android app, which is exactly what the
SMS dataset simulates.

### Data quirks the team should know

- `sms.csv` has multiline bodies and NUL bytes. Strip NULs before parsing and keep only rows
  whose `user_id` is all digits.
- The orders snapshot ends on 14 Oct 21:57, so "tonight" for a demo is 14 Oct 19:00. SMS and
  email run to 16 Oct.
- 47 plans due tomorrow by schedule have no INITIATED order on 14 Oct, including the best demo
  user. Keep the schedule fallback.
- Balances in SMS can be weeks old. Treat anything older than 72 hours as low confidence.
- Several users have two plans debiting the same day. One call must cover the total.

## 4. Tech design

```
 CSVs: sms, orders, sip_plans, customers
        │  ingest (pandas → SQLite)
        ▼
 ┌───────────────────────────────┐
 │ Signal extractors             │
 │  due_tomorrow()               │
 │  balance_from_sms()           │
 │  mandate_account()            │
 │  failure_history()            │
 └──────────────┬────────────────┘
                ▼
 ┌───────────────────────────────┐      ┌─────────────────────┐
 │ Decision engine (rules + cfg) │─────▶│ call_tasks (SQLite) │
 │ NO_CALL / INFO / CONVERSATION │      └──────────┬──────────┘
 └───────────────────────────────┘                 │ 19:00 cron or "Run tonight" button
                                                   ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ Dispatcher → voice platform (Vapi / Retell / Bland, or      │
 │ Twilio + LLM). Two assistants:                              │
 │   INFO (scripted, DTMF)   CONVERSATION (ladder + tools)     │
 │ tools → send_topup_link, reduce_sip, change_bank_link,      │
 │         pause_sip, schedule_callback                        │
 └──────────────────────────┬──────────────────────────────────┘
                            │ webhooks: outcome, transcript, tool calls
                            ▼
 ┌───────────────────────────────┐      ┌─────────────────────┐
 │ Bachatt mock API (FastAPI)    │◀────▶│ Ops dashboard       │
 │ mutates sip_plans in SQLite   │      │ (Streamlit)         │
 └───────────────────────────────┘      └─────────────────────┘
```

### Components

1. Ingest and signals. Python, pandas, SQLite. Prototyped in `pipeline/build_call_list.py`.
2. Decision engine. Pure function `decide(row)` returning decision and reason. Thresholds in a
   config file. Cooldown check against the call log. One task per user, not per plan.
3. Call task store. SQLite tables `call_tasks`, `call_events`, `actions`.
4. Bachatt mock API. FastAPI. `GET /users/{id}/sips`, `POST /sips/{id}/reduce`,
   `POST /sips/{id}/pause`, `POST /sips/{id}/change-bank`, `POST /users/{id}/topup-link`,
   `POST /callbacks`, `POST /call-events`. Writes MODIFY and PAUSED rows in the `sip_plans` shape.
   `send_sms` is a stub that logs.
5. Voice agent. Two assistants on the chosen platform. Tool definitions map one-to-one to the
   mock API. End-of-call summary JSON: ladder step reached, outcome, commitment.
6. Dispatcher. Reads the queue, enforces window, cooldown and concurrency, places calls with
   the task payload as variables, retries once, writes `call_events`.
7. Dashboard. Streamlit. Tonight's queue with filters, per-user drawer (balance timeline from
   SMS, SIP history), outcome funnel, transcript viewer, "simulate next morning" button that
   marks debits success or fail and shows rupees rescued.

### The shared contract: call_task

Agree this in the first hour. Person A produces it, Person B consumes it.

```json
{
  "task_id": "2026-10-13:1752215809777244",
  "call_type": "CONVERSATION_CALL",
  "user": {"user_id": "1752215809777244", "name": "Murari", "mobile": "9405108927", "lang": "hi"},
  "debit": {
    "date": "2026-10-14", "total_amount": 100,
    "plans": [{"sip_plan_id": "896084020824906105", "product": "Smart Deposit",
               "frequency": "DAILY", "amount": 100, "min_amount": 50}]
  },
  "bank": {"name": "Bank of Baroda", "acct_last4": "9428", "balance": 149.54,
           "balance_as_of": "2026-10-12T14:13", "confidence": "linked_account"},
  "history": {"streak": 2, "fails_14d": 2, "attempts_14d": 4, "failed_last_night": true},
  "offers": {"reduce_to": [50], "pause_days": [7, 15, 30]},
  "window": {"not_before": "19:00", "not_after": "20:45"},
  "decision_reason": "short by 70; chronic (streak=2)"
}
```

### Conversation agent prompt, skeleton

- You are Bachatt's savings assistant calling {name}. Speak Hinglish unless they answer in English.
- Open with who you are and why: the last {streak} instalments of ₹{amount} bounced for low
  balance in the {bank} account ending {acct}. There is no penalty.
- Walk the ladder in order. Make one offer at a time. Accept the first yes. Never skip ahead
  unless the user asks for a later option.
- Before any tool call, read back the change and get a clear yes.
- Never ask for OTP, PIN, card or account numbers. Never claim penalties or threats.
- If the user is busy, offer a callback window. If wrong person, apologise and end.
- End with a one-line summary and "you'll get an SMS confirming this".

### Demo script (3 minutes)

1. Dashboard shows the numbers in section 1.
2. Click "Run 19:00 job". The queue appears with decisions and reasons.
3. Open Murari: ₹100 daily Smart Deposit, failed three nights running, Bank of Baroda balance
   ₹149. Live call on speaker. Agent walks the ladder, user agrees to drop to ₹50. Dashboard
   shows the MODIFY row and the confirmation SMS.
4. Open an INFO_CALL user. 30-second heads-up call.
5. Click "Next morning". Rupees rescued appears.

Note for the demo. At 19:00 on 14 Oct Murari had just received a ₹4,603 NEFT credit at 18:37,
so the prototype correctly marks him NO_CALL that night. Run the job for 13 Oct instead: his
balance was ₹149, above the ₹100 debit but inside the bank's minimum-balance floor, and he had
bounced two nights running, so he lands in CONVERSATION_CALL. Two talking points: reading the
balance at 19:00 avoids a wasted call, and "balance above the debit" is not the same as "debit
will succeed".

## 5. Review of the idea: risks and recommendations

1. Coverage. Only 7 of 1,320 users tonight have a balance signal. Without Tier B the product
   covers almost nobody in this dataset. Build both tiers from the start.
2. Timing of balance. Salary and transfer credits land in the evening. Use the latest SMS up to
   dial time and re-check right before dialling. A second sweep at 21:00 can push a notification
   but not call.
3. Over-calling. Daily SIPs mean the same user is flagged every night. The prototype produced
   395 calls for one night, 394 of them conversation calls, because a single failure last night
   qualifies. Recommend: a single failure gets INFO_CALL, CONVERSATION_CALL needs streak of 2 or
   3 fails in 14 days, and the cooldowns above. Keep thresholds in config and show them to judges.
4. Source of truth. Amount and schedule come from orders and sip_plans, never from SMS.
5. INFO_CALL as a voice call. A call for a ₹100 heads-up may annoy. Suggest WhatsApp or push as
   the default for INFO, with a call only when the shortfall is large or the user hasn't opened
   the app recently. Judges will ask this. Keep the voice version for the demo.
6. Balance just above the amount can still bounce because of bank minimum-balance rules. Murari
   had ₹149 against a ₹100 debit and still bounced. The prototype uses a ₹20 buffer plus a flat
   ₹500 floor. A per-bank floor table would be better.
7. Trust and compliance. The agent must never ask for credentials, and every change must be
   confirmed by SMS. Record consent in `call_events`.
8. Success metric. Rescue rate = debits that succeeded next morning among called users versus
   a matched uncalled group, plus ladder outcomes and cancellations avoided.

## 6. Task split for two people

Person A owns data, decision engine, backend and dashboard. Person B owns the voice agent,
conversation design, dispatcher and the demo. Phase 0 is done together.

### Phase 0, first hour, together

- Run the prototype, read this document, agree the `call_task` contract.
- Pick the voice platform (criteria: Indian numbers, Hinglish speech in and out, tool calling,
  webhooks, free credits). Make one test call.
- Pick the demo users: Murari (conversation, 13 Oct), one INFO user, one NO_CALL user.

### Person A

| # | Task | Done when |
| --- | --- | --- |
| A1 | SQLite loader for sms, orders, sip_plans, customers. Strip NULs, filter bad rows | `make load` builds `sip_rescue.db` |
| A2 | Harden extractors: balance regex coverage on unparsed bank SMS, LLM fallback, bank name from sender code, freshness flag | Balance found for all 21 users, confidence column populated |
| A3 | Decision engine v2: thresholds in config, cooldown via call log, one task per user, emits `call_task` JSON | `run_night --date 2026-10-13` writes tasks to SQLite |
| A4 | Bachatt mock API: the seven endpoints, mutates `sip_plans` in schema shape, `send_sms` stub, idempotent | B's tool calls change the DB and return confirmations |
| A5 | Call log: `call_tasks`, `call_events`, `actions` tables, `/call-events` webhook | B's webhooks land as rows |
| A6 | Streamlit dashboard: queue, per-user drawer with balance timeline, outcome funnel, transcript, "simulate next morning" | Full loop visible on one screen |
| A7 | Pitch numbers: section 1 plus amount lost per month and cancellations after N failures | Slide-ready table |

### Person B

| # | Task | Done when |
| --- | --- | --- |
| B1 | Platform choice and first call, Indian test number, Hinglish voice | A real phone rings and the agent speaks |
| B2 | INFO assistant: scripted prompt with variables, DTMF 1 and 2, under 30 seconds, outcome webhook | Outcome row appears in A5 |
| B3 | CONVERSATION assistant: ladder prompt, objection handling, guardrails, five tools calling A4, end-of-call summary JSON | Murari payload produces a reduce-to-50 action end to end |
| B4 | Dispatcher: pulls tasks, enforces window, cooldown and concurrency, passes payload as variables, one retry, writes events | `dispatch --date` places calls for the queue |
| B5 | Confirmation messages: SMS/WhatsApp text after each action, top-up deep link text | Texts logged via A4 stub |
| B6 | Eval harness: ten scripted personas (agrees to top up, refuses everything, wants to cancel, asks about penalty, wrong person, busy) against the conversation agent | Ladder adherence and zero invented penalties |
| B7 | Demo: script, rehearsal calls to a team phone, backup recording, pitch slides from A7 | Three clean rehearsals |

### Integration checkpoints

1. End of hour 1: contract agreed, platform picked, prototype running on both machines.
2. End of Phase 1 (about a third of the way): A3 produces tasks, B3 dials one real call with
   the Murari payload, outcome lands in A5. That is the vertical slice.
3. End of Phase 2 (two thirds): dashboard shows the full loop, eval harness passes.
4. Last four to six hours: polish, three rehearsals, backup recording.
