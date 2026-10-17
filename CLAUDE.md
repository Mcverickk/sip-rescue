# SIP Rescue: context for development

Hackathon project, team of two. Bachatt users run small daily/weekly/monthly mutual-fund SIPs via
UPI AutoPay. Many debits fail for insufficient funds. SIP Rescue runs at 19:00 IST the evening
before a debit, reads the user's bank balance from bank SMS, and if the debit will likely fail,
an AI voice agent talks to the user.

Full design, data review and the original task split: `docs/DESIGN.md`
(team copy: https://claude.ai/code/artifact/197c6eac-ba17-453e-87f5-7b1cb98872bd).

## Current scope: demo only

The goal is a working, presentable demo, not production. Decisions already made:

- **One user, mocked backend.** The demo follows Murari (user_id 1752215809777244) on Mon 13 Oct
  2026, 19:00 IST. His data is a fixture in `demo/data/murari.json` taken from the organisers' CSVs.
  All Bachatt internal APIs are mocked in `demo/mockApi.mjs` and shown on screen.
- **No phone calls.** Murari's phone is drawn on screen; the presenter answers it and talks.
- **No script and no language picker.** Claude is the brain for every turn. Sarvam detects the
  language Murari speaks, and Sia replies in that language (Hindi/Hinglish, English, Bengali,
  Marathi, Tamil, Telugu, Gujarati, Kannada, Malayalam, Punjabi, Odia). She opens in Hindi.
- **Fast, short, warm.** Replies are one or two short sentences, streamed and voiced sentence by
  sentence. Optimise for natural conversation and conversion.
- **Non-technical audience.** Three-act story UI with animated Noto emoji GIFs. Technical JSON
  stays behind a "system calls" toggle.

## Layout

```
demo/                 the demo app (Node 20+, ESM, no build step)
  server.mjs          static site, streaming /api/call/* endpoints, mocked /internal/v1/* APIs
  agent.mjs           Claude agent: prompt, tools (mocked APIs), streaming + sentence splitting
  sarvam.mjs          Sarvam STT (saaras:v4, auto language) and TTS (bulbul:v4-flash voices), cache
  mockApi.mjs         in-memory mocked Bachatt APIs, request/response log
  env.mjs             loads demo/.env.local (private) then demo/.env (shared)
  data/murari.json    the single demo user's fixture
  public/             index.html, app.js, styles.css (vanilla JS)
pipeline/build_call_list.py   prototype nightly job over the full CSVs (pandas)
docs/DESIGN.md                product + tech design, data notes, task split
buildathon-data/              organisers' CSVs, ~4 GB, NOT committed
```

## Run

```bash
cd demo && npm install && npm start            # http://localhost:5173, use Chrome, allow the mic
```

Keys:
- `demo/.env` (committed on purpose): `SARVAM_API_KEY`, a free shared demo key.
- `demo/.env.local` (git-ignored, never commit): `ANTHROPIC_API_KEY` and `ANTHROPIC_WORKSPACE_ID`.
  The team's key is not scoped to a workspace, so the workspace ID header is required.
- Optional: `SIP_RESCUE_MODEL` (default `claude-opus-5`), `SIP_RESCUE_EFFORT` (default `low`),
  `SARVAM_PACE` (default 1.12).

Demo path: Run tonight's check, Call Murari, Answer, then just talk in any Indian language.

## How a turn works

0. Sia's greeting is generated while the phone rings, so she speaks the instant it's answered.
1. The browser records until Murari pauses (0.75 s of silence) and posts the audio to
   `/api/call/voice`. Typed text goes to `/api/call/text`; its language comes from Sarvam text-lid,
   which tells English apart from romanized Hindi.
2. Sarvam `saaras:v4` with `language_code: unknown` returns the transcript and its language
   (about 0.5 s). The server streams a `heard` event so the caption and language badge appear.
3. Claude (`agent.mjs`) gets `<customer lang="ta-IN">…</customer>` and streams its reply. It starts
   each reply with a stage tag like `[reduce]`, which drives the plan strip and is stripped before
   speaking. Text is cut into sentences as it streams.
4. Each sentence is sent to Sarvam TTS immediately; sentences are delivered to the browser in order
   with their audio URLs and played back-to-back. The voice is picked from the sentence's script.
5. Tool calls run the mocked APIs (Claude writes the confirmation SMS in the call's language; the
   real link is appended) and stream `action` events that update the "What changed" panel.
   `end_call` ends the call, but never silently: if Claude hung up without speaking, it is asked for
   the goodbye first.

Measured with Claude Opus 5 at low effort: first audio of a reply arrives 1.2 to 2.6 s after Murari
stops talking (Sarvam STT ~0.5 s, Claude first sentence ~1.5 s, Sarvam TTS of a short opener
~0.5 s). Each reply opens with a two-to-five-word sentence so the first audio is quick.

Voices (`sarvam.mjs`): `ishita_enhi_customer` for Hindi/Hinglish, `simran_en_conversation`,
`roopa_bn_conversational`, `pooja_gu_customer`, `chaitra_kn_conversation`, `kavitha_te_conversation`,
`anand_pa_customer`; Tamil, Malayalam, Marathi and Odia use `bulbul:v3` `priya`.

## Product rules the agent follows (in the system prompt)

- Ladder, one offer per turn: 1) add ₹500 tonight, 2) save ₹50 a day instead of ₹100,
  3) move AutoPay to another bank, 4) pause 7/15/30 days. Agreement to the offer just described
  is the confirmation, so the tool runs immediately.
- Never offer cancellation. Offer a pause once; cancel only if he insists again.
- Say early there is no penalty. Never ask for OTP, PIN or account numbers.

## Data facts worth knowing

- Debit amounts and schedule come from `investment/orders.csv` and `sip_plans.csv`, never from SMS.
- Murari's balance was ₹149.54 (BOB a/c 9428) and his debits bounced on 12 and 13 Oct even with
  ₹270 and ₹212 in the account, so the story uses a bank minimum-balance floor.
- The orders snapshot ends 14 Oct 2026, which is why the demo night is 13 Oct.
