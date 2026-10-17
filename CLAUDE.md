# SIP Rescue: context for development

Hackathon project, team of two. Bachatt users run small daily/weekly/monthly mutual-fund SIPs via
UPI AutoPay. Many debits fail for insufficient funds. SIP Rescue runs at 19:00 IST the evening
before a debit, reads the user's bank balance from bank SMS, and if the debit will likely fail,
an AI voice agent talks to the user.

Full design, data review and the two-person task split: `docs/DESIGN.md`
(team copy: https://claude.ai/code/artifact/197c6eac-ba17-453e-87f5-7b1cb98872bd).

## Current scope: demo only

The goal is a working demo, not production. Decisions already made:

- **One user, mocked everything.** The demo follows a single investor, Murari
  (user_id 1752215809777244), on the night of Mon 13 Oct 2026, 19:00 IST. His data is a fixed
  fixture in `demo/data/murari.json`, taken from the organisers' CSVs.
- **No phone calls.** The "call" is a browser voice agent: Web Speech API for speech in and out,
  plus typed input and quick-reply chips as a fallback.
- **All Bachatt internal APIs are mocked** in `demo/mockApi.mjs` (top-up link, modify/reduce SIP,
  change bank, pause, cancel, SMS, callbacks, call outcome). Every call is logged with request and
  response and shown on screen. They mutate an in-memory `sip_plans` list shaped like the real table.

## Layout

```
demo/                 the demo app (Node 20+, ESM, no build step)
  server.mjs          static site + /api/* for the UI + /internal/v1/* mocked Bachatt APIs
  agent.mjs           conversation agent: Claude engine + scripted fallback engine
  mockApi.mjs         in-memory mocked Bachatt APIs, request/response log
  data/murari.json    the single demo user's fixture
  public/             index.html, app.js, styles.css (vanilla JS)
pipeline/
  build_call_list.py  prototype nightly job over the full CSVs (pandas)
docs/DESIGN.md        product + tech design, data notes, task split
buildathon-data/      organisers' CSVs, ~4 GB, NOT committed (gitignored)
```

## Run

```bash
cd demo && npm install && npm start            # http://localhost:5173
ANTHROPIC_API_KEY=... npm start                # Claude-driven agent
npm run scripted                               # force the deterministic agent
```

Use Chrome or Edge for speech recognition. Demo path: Run scan, Start voice agent, then say or tap
"Haan, boliye", "Abhi paise nahi hain…", "Haan, 50 rupaye kar do".

## Agent engines

- **Claude** (`claude-opus-5`, override with `SIP_RESCUE_MODEL`): used when `ANTHROPIC_API_KEY` or
  `ANTHROPIC_AUTH_TOKEN` is set. Tool use with the mocked APIs as tools, effort `low` for latency,
  server-side refusal fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`).
  On any API error the call switches to the scripted engine mid-call.
- **Scripted**: regex intent matching over Hinglish/English and a fixed ladder state machine.
  Deterministic, so the stage demo cannot go off-script. Keep its quick-reply chips in
  `public/app.js` (`CHIPS`) in sync with the phrases its regexes understand.

## Product rules the agent must follow

- Priority ladder, one offer per turn: 1) add money tonight (suggest ₹500), 2) lower the SIP
  (₹100 to ₹50, minimum ₹50), 3) move AutoPay to another bank, 4) pause 7/15/30 days.
- Never offer cancellation. If asked, offer a pause once; cancel only if the user insists again.
- Say early that there is no penalty for a failed debit. Never ask for OTP, PIN or account numbers.
- Confirm every change by SMS. Hinglish in Latin script, amounts spoken as "500 rupaye".

## Data facts worth knowing

- Debit amounts and schedule come from `investment/orders.csv` and `sip_plans.csv`, never from SMS
  (SMS amounts were synthesised independently and don't match).
- Murari's balance was ₹149.54 (BOB a/c 9428) and his debits bounced on 12 and 13 Oct even with
  ₹270 and ₹212 in the account, so the story uses a ₹500 bank minimum-balance floor.
- The orders snapshot ends 14 Oct 2026. On 14 Oct 19:00 Murari had received a ₹4,603 credit, so
  he is NO_CALL that night. That is why the demo night is 13 Oct.
