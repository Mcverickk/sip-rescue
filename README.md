# SIP Rescue

Nightly guardian for UPI AutoPay SIPs. At 19:00 IST it finds every SIP debiting tomorrow,
reads the user's latest bank balance from their bank SMS, and if the balance won't cover the
debit it queues an AI voice call:

- **INFO_CALL** (first-time shortfall): 30-second heads-up, "keep ₹X in the account tonight, no penalty".
- **CONVERSATION_CALL** (repeat / streak of insufficient funds): agent walks the priority ladder
  top up → lower the SIP amount → change bank account → pause the SIP.

Full design, data notes and the two-person task split live in `docs/DESIGN.md`
(also published as a Claude Doc for the team).

## Demo app

A browser demo for one investor, with a voice agent and every Bachatt API mocked on screen.

```bash
cd demo && npm install && npm start
```

Open http://localhost:5173 in Chrome and allow the microphone. Murari speaks in any Indian
language: Sarvam detects it and transcribes, Claude decides what to say and do, and Sarvam speaks
the reply in the same language. Claude credentials go in `demo/.env.local`.

See [`CLAUDE.md`](CLAUDE.md) for the product/decisions context and
[`demo/README.md`](demo/README.md) for the technical map of the demo app (file layout, the
request flow for one conversational turn, env vars, and how to debug a turn with `curl` alone).

## Layout

```
buildathon-data/        hackathon CSVs (not committed)
demo/                   browser demo: voice agent + mocked Bachatt APIs
pipeline/
  build_call_list.py    prototype: CSVs -> tonight's call list with decision + reason
  out/                  generated call lists (not committed)
docs/
  DESIGN.md             product + tech design, data review, task split
```

## Run the prototype

```bash
python3 pipeline/build_call_list.py --run-date 2026-10-14 --run-time 19:00 --data buildathon-data --out pipeline/out
```

Needs Python 3 with pandas. Output: `pipeline/out/call_list_<date>.csv`, one row per SIP plan
due tomorrow with amount, latest balance (account, timestamp, freshness), insufficient-funds
streak, and `decision` / `decision_reason`.

The data snapshot's orders end on 2026-10-14, so `--run-date 2026-10-14` is "tonight" for demos.
Use `--run-date 2026-10-13` to see the best demo user (Murari, ₹100 daily SIP, balance ₹149,
two bounces in a row) land in CONVERSATION_CALL.
