# SIP Rescue — demo app

Read this if you landed in `demo/` directly. For the product story and data behind it, see
[`../CLAUDE.md`](../CLAUDE.md) (fuller context) and [`../docs/DESIGN.md`](../docs/DESIGN.md)
(original design doc). This file is the technical map of the code in this folder.

## What this is

A browser demo of one scenario: **Murari**, a Bachatt user whose ₹100 daily SIP is about to
bounce again, gets an AI voice call from **Sia**. There is no scripted fallback — every word Sia
says comes from a live Claude call, and every word she hears is transcribed and language-detected
live by Sarvam. The UI shows a phone mockup the presenter answers and talks into, plus a live
"what changed" panel driven by the actual mocked API calls the agent makes.

This is a hackathon demo, not production: one hard-coded user, an in-memory mock backend, no auth,
no persistence. It is meant to be read end to end by whoever picks it up next.

## Run it

```bash
npm install
npm start          # http://localhost:5173
```

Open in Chrome, allow the microphone, click through: **Run tonight's check → Have Sia call Murari
→ Answer → just talk** (or type into the box that appears during the call — it works without a
mic). `PORT` env var overrides the default 5173.

### Credentials (two different files, on purpose)

| File | Committed? | Holds | Why |
| --- | --- | --- | --- |
| `.env` | **Yes** | `SARVAM_API_KEY` | A shared demo key with no billing attached. Safe to commit. |
| `.env.local` | **No** (git-ignored) | `ANTHROPIC_API_KEY`, `ANTHROPIC_WORKSPACE_ID` | Personal Claude credentials. Never commit this. |

`env.mjs` loads `.env.local` first, then `.env`, so a value in `.env.local` wins. Without
`ANTHROPIC_API_KEY` the app still boots and the UI still works, but every call turn returns an
on-screen error ("Claude needs a workspace ID…" or similar) instead of a reply — there is **no
scripted fallback anymore**, this was removed when the agent became fully Claude-driven. If you
see that error, check both keys are in `.env.local` and that the key is scoped to a workspace (a
key not scoped to one needs `ANTHROPIC_WORKSPACE_ID` set, or Anthropic rejects every request).

Optional env vars, all read directly from `process.env` (grep for `process.env.` to confirm this
list is still current — it was last checked against the code on 2026-10-17):

| Var | Default | Effect |
| --- | --- | --- |
| `SIP_RESCUE_MODEL` | `claude-opus-5` | Which Claude model drives the conversation |
| `SIP_RESCUE_EFFORT` | `low` | `output_config.effort` — low keeps turns fast for voice |
| `SARVAM_PACE` | `1.12` | TTS speaking pace multiplier |
| `PORT` | `5173` | HTTP port |

## File map

```
server.mjs       HTTP server: static files, streaming /api/call/* endpoints, mocked
                 /internal/v1/* Bachatt API (so the mocked endpoints are curl-able too)
agent.mjs        The Claude agent: system prompt, tool definitions, the streaming loop that
                 splits Claude's reply into sentences as it arrives
sarvam.mjs       Sarvam AI client: speech-to-text with language auto-detect (saaras:v4),
                 text-to-speech per language (bulbul:v4-flash, falls back to bulbul:v3 for
                 languages v4-flash has no good voice for), text-lid for typed input,
                 disk-cached TTS audio (.cache/tts/, git-ignored)
mockApi.mjs      In-memory mock of Bachatt's internal APIs (top-up link, reduce SIP, change
                 bank, pause, cancel, SMS, callback, call-outcome). Every call is logged with
                 full request/response so the UI and judges can see exactly what fired.
env.mjs          Tiny .env loader (no dependency), see table above
data/murari.json The one demo user's fixture — balance, SIP, bank, debit history — pulled from
                 the hackathon organisers' CSVs (see ../CLAUDE.md for which rows)
public/          Front end: index.html, app.js, styles.css. Vanilla JS, no build step, no
                 framework. Dark "premium fintech" theme — see the design tokens at the top
                 of styles.css if you're changing the look.
```

No TypeScript, no bundler, no React. `public/app.js` is plain ES modules loaded directly by the
browser. If you're tempted to introduce a build step or a framework, that's a real option but a
separate decision — don't do it silently as part of an unrelated change.

## Request flow for one conversational turn

This is the part most worth understanding before touching `agent.mjs` or `server.mjs`.

1. **Start of call**: the browser fires `POST /api/call/start` the moment the phone starts
   ringing (before the presenter clicks Answer), so Sia's greeting is already streaming back by
   the time the call is answered. See `callMurari()` in `public/app.js`.
2. **Murari speaks**: the browser records audio with voice-activity detection (stops ~0.75 s
   after he stops talking, caps at 15 s) and `POST`s the raw audio to `/api/call/voice`. Typed
   input goes to `/api/call/text` instead, with its language decided by Sarvam's `text-lid`
   endpoint (so "haan boliye" is correctly read as Hindi, not English).
3. **Sarvam STT** (`saaras:v4`, `language_code: "unknown"`) returns the transcript and the
   detected language in ~0.5 s. The server immediately streams a `{"type":"heard",...}` line so
   the UI can show the caption and light up the detected-language chip before Claude has even
   started.
4. **Claude** (`agent.mjs`, `turn()`) gets the message as
   `<customer lang="ta-IN">...</customer>` and streams its reply. Every reply starts with a stage
   tag like `[reduce]` or `[topup]` (stripped before speaking) that drives the ladder UI. The
   reply text is split into sentences as it streams in (`makeSplitter`), not after the full
   response — this is what makes the first audio land in ~1–2.5 s instead of waiting for the
   whole turn.
5. **Each sentence** goes to Sarvam TTS as soon as it's complete; the server streams
   `{"type":"say", text, audio, lang}` lines in order, and the browser plays them back-to-back,
   with the agent's orb/waveform reacting live to the audio amplitude.
6. **Tool calls** (the 4-rung offer ladder plus `cancel_sip`, `schedule_callback`, `end_call`) run
   the mock API in `mockApi.mjs`. The server streams `{"type":"action", tool, input, result}` for
   each one, which both updates the "what changed" panel live and feeds the result back to Claude
   so it can confirm correctly. `end_call` never hangs up in silence — if Claude tries to end the
   call without having said anything that turn, the code asks it to speak first (see the
   `endPending` handling in `agent.mjs`).

The whole response to any `/api/call/*` endpoint is newline-delimited JSON (not SSE, no special
headers needed beyond `content-type: application/x-ndjson`), so it's easy to drive from `curl -N`
or a small script for debugging without opening a browser at all — see the `drive the API` idea
below.

## Debugging without a browser

Every `/api/call/*` endpoint speaks newline-delimited JSON over a normal `POST`, so you can test
a full conversation from the shell:

```bash
curl -s -N -X POST localhost:5173/api/call/start
curl -s -N -X POST localhost:5173/api/call/text -H 'content-type: application/json' \
  -d '{"text":"haan boliye"}'
curl -s localhost:5173/api/state | python3 -m json.tool   # plans, sms, log, outcome
```

This is the fastest way to check a prompt change or a new tool without touching the UI, mic
permissions, or audio playback at all.

## Known gaps / things to verify before a real demo

- **Live microphone input has not been exercised in a real browser by an agent** — it's been
  tested via scripted STT/TTS calls and via the typed-text path, which exercises the same
  server-side code, but not an actual `getUserMedia` recording end to end. Do a real mic test
  before presenting.
- **No scripted fallback.** If the Anthropic key or workspace ID is wrong, the call UI shows an
  error instead of degrading gracefully to a canned script. This is intentional (the brief asked
  for a fully live agent) but means the demo is unusable without working Claude credentials.
- **One user, one scenario.** There's no way to pick a different investor or balance from the UI;
  `data/murari.json` is the only story the app tells.
