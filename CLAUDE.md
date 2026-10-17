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
- **No phone calls.** The "call" is a browser voice agent. Murari's phone is drawn on screen and the
  presenter answers it. Speech in and out uses **Sarvam AI** (key in `demo/.env`, committed on purpose:
  it is a free demo key). Browser speech is the fallback if Sarvam is unreachable.
- **Languages:** Hinglish (default), Hindi, English, Bengali, Marathi, Tamil, Telugu, Gujarati,
  Kannada, Malayalam, Punjabi, Odia. Optimise for natural conversation and conversion in these.
- **Audience is non-technical.** The UI tells a story in three acts (tonight's check, the call,
  what changed) with animated Noto emoji GIFs. Technical JSON stays behind a "system calls" toggle.
- **All Bachatt internal APIs are mocked** in `demo/mockApi.mjs` (top-up link, modify/reduce SIP,
  change bank, pause, cancel, SMS, callbacks, call outcome). Every call is logged with request and
  response and shown on screen. They mutate an in-memory `sip_plans` list shaped like the real table.

## Layout

```
demo/                 the demo app (Node 20+, ESM, no build step)
  server.mjs          static site + /api/* for the UI + /internal/v1/* mocked Bachatt APIs
  agent.mjs           conversation agent: Claude engine + scripted ladder engine
  lines.mjs           everything Sia says (en / Hinglish / Devanagari), reply chips, SMS templates
  sarvam.mjs          Sarvam TTS (bulbul:v3), STT (saaras:v3), translation (mayura:v1), disk cache
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

Demo path: pick a language, Run tonight's check, Call Murari, Answer, then speak or tap
"Haan, boliye", "Abhi paise nahi hain…", "Haan, 50 rupaye kar do". Use Chrome and allow the mic.

## Voice pipeline (Sarvam)

- **Speech out:** each line is rendered per language and spoken with `bulbul:v3`, speaker `priya`
  (override with `SARVAM_SPEAKER`). Hinglish captions are Latin script but the audio is generated from
  the Devanagari version, which Sarvam pronounces best. Audio is cached in `demo/.cache/tts/`.
- **Languages other than en/Hinglish/Hindi** are machine-translated from the English line with
  `mayura:v1` in `modern-colloquial` mode (natural code-mixing) and cached in `demo/.cache/`.
- **Warm-up:** picking a language pre-translates and pre-records all ~17 lines (about 25 s cold,
  instant after). Hinglish and Hindi warm up when the server starts.
- **Speech in:** the browser records until 1.1 s of silence, then `/api/stt` calls `saaras:v3` twice
  in parallel: `translit`/`transcribe` for the caption and `translate` for an English version that
  the intent matcher reads. About 0.4 s per turn.
- If audio can't play, a timeout keeps the call moving, so the demo never freezes.

## Agent engines

- **Claude** (`claude-opus-5`, override with `SIP_RESCUE_MODEL`): used when `ANTHROPIC_API_KEY` or
  `ANTHROPIC_AUTH_TOKEN` is set. Tool use with the mocked APIs as tools, effort `low` for latency,
  server-side refusal fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`).
  On any API error the call switches to the scripted engine mid-call.
- **Scripted**: regex intent matching over Hinglish/English and a fixed ladder state machine.
  Deterministic, so the stage demo cannot go off-script. It matches intent on the English translation,
  asks once more when it can't tell, and never advances the ladder on unclear speech. Reply chips live
  in `lines.mjs` (`CHIPS`); their `en` text is what the matcher reads.

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
