# Linh — Real-Time AI Phone Agent (Vietnamese / English)

Linh is an AI phone assistant that **places real phone calls** and **holds natural, two-way conversations** in Vietnamese or English, with replies starting in well under a second. She handles task calls (for example, ordering takeout), follows strict rules, and ends the call herself. Calls are launched from Discord, and the transcript, recording and result summary are posted back there.

> Built solo on a self-managed Linux server, controlled from Discord.

---

## Demo

- 🎧 Demo audio/video: *(link here)*
- Example result posted to Discord after a call:

```
✅ RESULT: done — Ordered 2 large phở đặc biệt to go, pickup 6:30 PM, name Lợi
📞 Call — duration 52s · avg latency 0.9s
1. Shop: Alo, muốn đặt gì?
2. Linh: Dạ, em muốn đặt 2 tô phở đặc biệt mang về ạ...
```

---

## Features

- **Real phone calls** via Twilio (outbound only, by design)
- **Speech-to-speech AI** with OpenAI Realtime: hearing, thinking and speaking in one model
- **Fast replies:** about **0.4–1.0 s** from the caller finishing a sentence to Linh's voice starting (measured from call recordings)
- **Natural turn-taking and barge-in:** Linh stops talking when interrupted
- **Vietnamese or English** per call, with a Vietnamese persona and correct pronoun handling (anh / chị / cô / chú…), tracked in code and updated mid-call
- **Task calls:** give her a task, details and pre-approved defaults; she confirms details and **refuses changes she wasn't approved for** (result flagged ⚠️ *needs approval*)
- **Ends the call herself** with a single polite goodbye
- **Call reports in Discord:** transcript, call recording (MP3) and a ✅ / ⚠️ result line, posted by the agent that launches the calls (that reporting layer lives outside this repo)

---

## Architecture

```
            ┌──────────────┐
  Phone ◄──►│   Twilio     │  Media Streams (G.711 µ-law, 8 kHz)
            └──────┬───────┘
                   │ WebSocket (signature-verified)
            ┌──────▼───────────────────────────┐
            │  Bridge server (Node.js)          │
            │  - relays audio both ways         │
            │  - per-call persona & task        │
            │  - pronoun tracking, guardrails   │
            │  - call limits, graceful drain    │
            └──────┬───────────────────────────┘
                   │
         ┌─────────▼────────┐
         │ OpenAI Realtime  │
         │ (speech ↔ speech)│
         └──────────────────┘

  Discord ──► agent runs `call.mjs` ──► posts transcript, MP3 and result back to Discord
```

- Audio is passed through **without transcoding**: Twilio's µ-law matches OpenAI's `audio/pcmu`.
- The bridge is exposed through a **Cloudflare Tunnel** (no open ports on the server).
- Services run as **systemd user units** with auto-restart.

---

## Tech Stack

- **Node.js** (WebSocket bridge, call scripts)
- **Twilio** Programmable Voice and Media Streams
- **OpenAI Realtime API** (`gpt-realtime` family, server-side VAD, input transcription)
- **Cloudflare Tunnel** (`cloudflared`)
- **Linux / systemd** on a DigitalOcean droplet
- **Discord** as the control panel (calls launched and reported by an AI agent)

---

## Security & Safety

- **Twilio signature verification** on every WebSocket upgrade; anything else gets a 401
- **Outbound-only:** inbound calls are rejected by the server
- **One call at a time**, **3-minute hard cap**
- **Graceful shutdown:** restarts wait for active calls to finish
- **Secrets only in `.env`** (never committed); see `.env.example`
- **Guardrails in the persona:** no payments, no personal info, never claims to be human when sincerely asked, never accepts unapproved changes

---

## Usage

```bash
node call.mjs \
  --to +1XXXXXXXXXX \
  --lang vi \
  --address chị \
  --opening "Alo, cho em đặt món mang về ạ." \
  --task "Đặt 2 tô phở đặc biệt mang về" \
  --details "tên Lợi, lấy lúc 6 rưỡi tối nay" \
  --defaults "size lớn"
```

| Flag | Meaning |
|---|---|
| `--to` | number to call |
| `--lang` | `vi` (default) or `en` |
| `--address` | starting pronoun; updated automatically if the other person uses a different one |
| `--opening` | first sentence Linh says |
| `--task` | what she must accomplish |
| `--details` | facts she can share |
| `--defaults` | pre-approved answers (e.g. size) |

---

## Setup

1. Copy `.env.example` to `.env` and fill in:
   ```
   OPENAI_API_KEY=
   TWILIO_ACCOUNT_SID=
   TWILIO_API_KEY_SID=
   TWILIO_API_KEY_SECRET=
   TWILIO_AUTH_TOKEN=
   TWILIO_FROM_NUMBER=
   TWILIO_NUMBER=
   ```
   Optional tuning: `PORT`, `REALTIME_MODEL`, `REALTIME_VOICE`, `TURN_DETECTION`.
2. `npm install` (Node 20+)
3. `npm start` to run the bridge server, then point a Cloudflare tunnel at its port.
4. Place a call with `call.mjs`.

---

## What I Learned (Engineering Notes)

This project went through two architectures:

1. **v1: Twilio ConversationRelay + DeepSeek (text LLM) + Google voices.** It worked, but replies took **4–6 s**. Measuring from dual-channel recordings showed the delay was Twilio's end-of-turn detection for Vietnamese, not the LLM (~0.9 s).
2. **v2: Twilio Media Streams + OpenAI Realtime (speech-to-speech).** End-of-turn handled by the model's VAD, reducing first-audio latency to **~0.4–1.0 s**.

Some non-obvious lessons:

- Google **Standard** TTS voices played the welcome greeting but stayed **silent for streamed replies**; only **Chirp 3 HD** voices worked for streaming.
- Twilio's WebSocket **signature is computed over an exact URL form**; one trailing slash broke verification.
- OpenAI Realtime GA renamed audio events (`response.output_audio.delta`), and `output_modalities` must be set explicitly or the model replies in text only.
- Without a language hint, input transcription sometimes **misdetected Vietnamese as Chinese**.
- A bilingual "auto language" prompt made a small model **drift into a translator persona**, so per-call language selection is more reliable.
- Vietnamese pronouns must be **tracked in code**; a prompt alone let the model drift back to the initial pronoun.

---

## Status

Working prototype used for real calls. Possible next steps: voicemail detection, a stable tunnel hostname, multi-call concurrency, and an inbound receptionist mode with a caller allowlist.

---

## Author

**Loi Truong**: solo developer building AI-powered products.
GitHub: [@jacklee1000](https://github.com/jacklee1000)
