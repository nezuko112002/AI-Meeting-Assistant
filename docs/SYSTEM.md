# AI Earpiece (Meeting Copilot v2) — System Documentation

Real-time sales coaching for software and web development client calls. The app listens to a live meeting, transcribes who said what, and streams GPT-4o suggestions for what your salesperson (“You”) should say next — grounded in company portfolio data from Google Sheets.

---

## 1. What the system does

- Captures **two audio channels** during a call: your microphone (“You”) and shared meeting/tab audio (“Client”).
- Transcribes speech in real time via **AssemblyAI streaming** with dual-channel speaker separation.
- Queues **client utterances** and, when you press **Generate**, calls GPT-4o with full meeting context, portfolio knowledge, and a mission brief.
- Returns structured coaching: **Say this next**, **What they're asking**, **Good to know**, **Follow-up**.
- Post-processes every AI response through a **sanitizer** so pricing, portfolio names, jargon, and repetition stay controlled.
- At **End Meeting**, summarizes the call and appends a row to a **Meeting Log** tab in Google Sheets.

The product is branded **AI Earpiece** in the UI. The repo folder is `meeting-copilot-v2`.

---

## 2. Who is who on a call

The system assumes a vendor–buyer sales call:

- **You / Boss** — your side (the person being coached). Mapped from the **mic** channel.
- **Client** — the prospect company. Mapped from **system/tab audio** (Zoom, Meet, Teams, etc.).
- **Speaker A, B, C…** — legacy labels from batch transcription or GPT speaker-split; can be renamed in the **Speakers** panel.

Coaching is triggered only when there is **client speech**. Your own lines are transcript context, not coaching triggers.

---

## 3. High-level architecture

```
Browser (Chrome)
├── CopilotModal (React UI)
├── useStreamingTranscription
│   ├── Mic stream (getUserMedia)
│   ├── System audio (getDisplayMedia — tab/window share)
│   └── AssemblyAI DualChannelCapture + StreamingTranscriber
│
└── API routes (Next.js, server-side keys)
    ├── /api/assemblyai-token   → temporary streaming token
    ├── /api/analyze            → GPT-4o coaching (SSE stream)
    ├── /api/split-speakers     → GPT-4o-mini fallback diarization
    ├── /api/sheets/knowledge   → portfolio rows from Google Sheets
    ├── /api/sheets/summarize   → end-of-meeting summary
    ├── /api/sheets/log         → append Meeting Log row
    └── /api/transcribe         → legacy batch upload (not used by main UI)
```

**Stack:** Next.js 14, React 18, Tailwind CSS, OpenAI SDK, AssemblyAI SDK, Google Sheets API (`googleapis`).

All secrets (`OPENAI_API_KEY`, `ASSEMBLYAI_API_KEY`, Google service account) live **server-side only**.

---

## 4. Repository layout

- `pages/index.js` — landing page; hosts `CopilotModal`.
- `components/CopilotModal.js` — main application shell and state machine.
- `components/` — `TranscriptBubble`, `SuggestionCard`, `MicButton`, `SpeakerMapEditor`, `SpeakerTag`, `SpeakerLegend`.
- `lib/useStreamingTranscription.js` — live dual-channel capture and transcription.
- `lib/useAnalyze.js`, `lib/useAudioRecorder.js`, `lib/useSpeechRecognition.js` — older/alternate capture paths (main UI uses streaming).
- `pages/api/analyze.js` — coaching brain: prompt assembly, streaming, sanitization.
- `lib/sanitizeCoaching.js` — post-processing and intent detection.
- `lib/knowledgeHelpers.js` — portfolio scoring, pricing extraction, allowed client names.
- `lib/prospectAttribution.js` — prevents confusing past clients with the prospect.
- `lib/audienceLevel.js` — developer / balanced / executive tone.
- `lib/googleSheets.js` — Sheets client, tab names, Meeting Log setup.
- `lib/buildAnalyzePrompt.js` — shared prompt pieces and summary parsing.
- `scripts/test-analyze.mjs` — scripted regression test against `/api/analyze`.
- `scripts/surprising-conversations.mjs` — extended conversation scenarios.

---

## 5. User journey (end-to-end flow)

### Before the call

1. Open `http://localhost:3000` (or your deployed URL) in **Chrome**.
2. In **Mission Brief**:
   - Select company: **CodeUpscale** or **Ridge Theory** (required before mic).
   - Set **audience level** (developer, mixed, executive).
   - Enter **client company**, **website**, and **prior conversations / prep notes**.
3. Brief fields persist in `localStorage` under key `aiEarpiece_brief`.

### During the call

1. Press the **mic button**.
2. Grant microphone access.
3. When prompted, **share the meeting tab or window** and enable **Share audio**. Without system audio, the app cannot hear the client.
4. Live transcription runs continuously until you stop the mic.
5. Each finalized “turn” from AssemblyAI is appended to the transcript. Client lines are queued for coaching.
6. Press **Generate** when you want coaching (enabled while listening if client speech is ready).
7. Suggestions stream in green cards below the transcript.
8. Optionally open **Speakers** to rename labels (e.g. Speaker A → “Sarah (CFO)”).
9. Use the pencil icon for **manual input** if audio fails — text is treated as Client speech.

### After the call

1. Stop recording.
2. Press **End Meeting** (visible once there is at least one exchange).
3. System calls `/api/sheets/summarize`, then `/api/sheets/log`.
4. A row is appended to the company’s **Meeting Log** sheet.
5. Press **Start New Meeting** to reset session state (brief reloads from localStorage).

---

## 6. Frontend: CopilotModal state model

**Session state**

- `company` — `codeupscale` | `ridgetheory`; locked after first recording.
- `brief` — client context; persisted to localStorage.
- `meetingId` — random 8-char ID per session.
- `sessionStart` — timestamp when first recording starts (used for duration).
- `turns` — array of `{ id, utterances, suggestion, isStreaming }`.
- `history` — OpenAI-style `[{ role, content }]` for coaching continuity.
- `speakerMap` — `{ "You": "Jane", "Client": "Acme CEO", ... }`.
- `pendingCoachingUtterances` — client lines waiting for Generate.
- `meetingUtterancesRef` — full transcript ref (not lost on re-renders).
- `lastCoachedIndexRef` — index into full transcript for “since last coaching” slice.
- `knowledge` — portfolio rows fetched from Sheets.

**Key behaviors**

- Consecutive utterances from the same speaker are **merged** (client and server).
- `splitSpeakersIfNeeded` calls `/api/split-speakers` when a single long utterance (10+ words, non You/Client label) might contain multiple speakers.
- `generateCoaching` sends:
  - `utterances` — client-focused slice since last coaching (+ live partial client speech).
  - `meetingTranscriptFromStart` — full meeting for context.
  - `history`, `speakerMap`, `knowledge`, `brief`, `company`.
- HTTP **204** from analyze = no client speech in payload; UI silently skips.
- Streaming uses SSE lines: `data: {"text":"..."}`, optional `data: {"replace":"..."}` after sanitization, then `data: [DONE]`.

---

## 7. Live transcription (`useStreamingTranscription`)

### Audio setup

1. Fetches a 5-minute temporary token from `/api/assemblyai-token`.
2. `getUserMedia` — mic with echo cancellation, noise suppression, AGC.
3. `getDisplayMedia` — video + audio from meeting tab; **audio track required**.
4. `StreamingTranscriber` with:
   - Model: `u3-rt-pro`
   - Sample rate: 16 kHz
   - Channels: `mic` → You, `system` → Client
   - Turn detection: `minTurnSilence` 1800 ms, `maxTurnSilence` 3500 ms
5. `DualChannelCapture` pipes both streams into the transcriber.

### Speaker attribution logic

- Per-word channel tags from AssemblyAI are preferred.
- **Echo repair**: short islands (≤3 words) sandwiched between the same speaker are merged — reduces mic bleed mislabels.
- Partial turns update `partialTranscript` in the UI (live preview).
- Final turns (`end_of_turn`) call `onTurn` and clear partials.

### Notes

- Chrome is required for reliable `getDisplayMedia` + tab audio.
- If “No meeting audio was shared”, re-share and check “Share tab audio”.
- Volume meter uses Web Audio API on the mic stream only.

---

## 8. API reference

### `POST /api/assemblyai-token`

- Creates AssemblyAI temporary streaming token (300 s expiry, up to 3600 s session).
- Returns `{ token }`.

### `POST /api/analyze` (core coaching)

**Request body**

- `utterances` — latest exchange utterances.
- `meetingTranscriptFromStart` — full meeting utterances.
- `history` — prior user/assistant messages.
- `speakerMap`, `knowledge`, `brief`, `company`.

**Response**

- `text/event-stream` with GPT-4o deltas.
- Post-stream: sanitized full text may replace via `{ replace }`.
- Errors: 400 (no utterances), 204 (no client speech), 500.

**Pipeline inside handler**

1. Merge utterances; build transcript strings.
2. If `brief.clientWebsite` set and no snippet yet → `fetchWebsiteSnippet`.
3. `detectClientIntent` — price, portfolio, technical how, trust, deadline, etc.
4. `buildAnalyzeSystemPrompt` — company identity, portfolio firewall, knowledge base (top 40 scored rows), pricing sections, brief, audience, response format rules.
5. Stream GPT-4o (`temperature: 0.2`, `max_tokens: 800`).
6. `sanitizeCoachingResponse` — anti-repeat, price gating, portfolio name allowlist, audience tone, fluff stripping.

### `POST /api/split-speakers`

- GPT-4o-mini splits one blob of text into `{ utterances: [{ speaker, text }] }`.
- Used when diarization collapses multiple speakers into one label.

### `POST /api/transcribe` (legacy)

- Accepts base64 audio; uploads to AssemblyAI batch API with `speaker_labels`.
- Polls up to ~55 s. Not wired to the current streaming UI but available for alternate flows.

### `GET /api/sheets/knowledge?company=`

- `company=all` — merges CodeUpscale + Ridge Theory **All Work** tabs.
- `company=codeupscale|ridgetheory` — single company.
- Maps columns: Company Name, Scope of Services, Project Name, Industry, Tech Stack, Project Summary, Link, Owner, Assigned Team, Notes, Signed Contract Link.

### `POST /api/sheets/summarize`

- GPT-4o-mini summary of full transcript for Meeting Log fields: summary, topics, actionItems, outcome.

### `POST /api/sheets/log`

- Appends one row to **Meeting Log** tab (creates tab + headers if missing).
- Columns: Meeting ID, Date, Time, Meeting Type, Client Name, Client Company, Meeting Goal, Duration, Key Topics, Action Items, Outcome, Full Summary.

---

## 9. AI coaching design

### Coaching philosophy

The model acts as a **silent earpiece** for a software/web agency salesperson:

- Answer what is **new** in the client’s latest message.
- Build **one evolving proposal** across the meeting — don’t restart with unrelated products.
- **Technical questions** get architecture answers (S3, Postgres, REST, OCR, etc.) — not portfolio name-drops.
- **Experience / credibility / price** questions may cite 2–3 allowed past clients from the knowledge base.
- Never invent client names or prices not grounded in sheets or transcript.
- Every “Say this next” should end with or pair with a sharp **follow-up question**.

### Intent detection (`sanitizeCoaching.js`)

Detects client intent from latest utterances + full meeting context, e.g.:

- Asking price, industry experience, portfolio names/details
- Technical how / security / compliance
- Trust, ownership, process, deadline
- Portfolio objections, close signals

Intent drives:

- What goes in the user message (`buildIntentGuidance`)
- Sanitizer rules (allow pricing, pick portfolio projects, skip anti-repeat on distinct new questions)

### Sanitization layer

After streaming completes, `sanitizeCoachingResponse` may rewrite the full response to:

- Strip invented prices and unapproved client names
- Remove repeated price/deadline/demo pitches from prior turns
- Enforce portfolio cite lines on experience turns
- Apply **audience level** (executive = plain language; developer = full stack names)
- Strip fluff (“Great question”, “can be tailored to”, refusals)
- Normalize section headings to `**Say this next:**` format

The UI may flash a **replace** event if sanitized text differs from raw stream.

### Knowledge scoring

When portfolio rows exceed 40, rows are scored by token overlap with transcript + brief (client company name weighted heavily). Only top rows enter the prompt.

### Portfolio firewall (`prospectAttribution.js`)

Prevents the model from describing **past clients’ systems** as if they belong to the **prospect** (e.g. “your loan portfolio” when that’s a Summit Lending project).

---

## 10. Google Sheets integration

### Companies

- **CodeUpscale** → `GOOGLE_SHEET_CODEUPSCALE_ID`
- **Ridge Theory** → `GOOGLE_SHEET_RIDGETHEORY_ID`

### Tabs

- **All Work** — portfolio / project knowledge (read).
- **Meeting Log** — call outcomes (write; auto-created if missing).

### Authentication

Service account via:

- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_PRIVATE_KEY` (PEM with `\n` escapes)

**Important:** Share each spreadsheet with the service account email as **Editor**.

### Knowledge row shape (in memory)

Each row includes: `companyName`, `scopeOfServices`, `projectName`, `industry`, `techStack`, `projectSummary`, `link`, `owner`, `notes`, `signedContractLink`, `portfolioSource`.

Pricing signals are extracted from summary/notes text where dollar amounts appear in project context.

---

## 11. Environment configuration

Copy `.env.example` → `.env.local`:

**Required for core features**

- `OPENAI_API_KEY` — GPT-4o coaching, summarization, speaker split.
- `ASSEMBLYAI_API_KEY` — streaming transcription.

**Required for knowledge + logging**

- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `GOOGLE_SHEET_CODEUPSCALE_ID`
- `GOOGLE_SHEET_RIDGETHEORY_ID`

Without Google credentials, coaching still works if the client passes empty `knowledge`; Meeting Log save will fail gracefully with a warning in the footer.

---

## 12. Setup guide

### Local development

```bash
cd meeting-copilot-v2
npm install
cp .env.example .env.local
# Edit .env.local with your keys
npm run dev
```

Open `http://localhost:3000` in Chrome.

### Google Sheets setup

1. Create a Google Cloud project; enable **Google Sheets API**.
2. Create a **service account**; download JSON key.
3. Copy `client_email` and `private_key` into `.env.local`.
4. Create or open portfolio spreadsheets; copy Sheet IDs from the URL.
5. Share both spreadsheets with the service account email (Editor).
6. Ensure **All Work** tab exists with expected column headers.
7. **Meeting Log** tab is created automatically on first log write.

### Vercel deployment

1. Push to GitHub; import project in Vercel.
2. Add all environment variables from `.env.local`.
3. Deploy.

**Timeout note:** Batch `/api/transcribe` can hit Vercel Hobby 10 s limit. The **streaming** path avoids long server polls for transcription, but `/api/analyze` still runs GPT streaming on the server — Pro plan or `maxDuration` config helps for long meetings with heavy analyze calls.

---

## 13. Operator guide (during a live call)

### Recommended workflow

- Fill the brief **before** starting the mic — website URL enables automatic snippet fetch on first Generate.
- Keep the AI Earpiece tab visible beside the meeting window.
- Share **the meeting tab**, not the entire screen, when possible — cleaner audio routing.
- Let the client finish a thought; partial transcript shows in the footer while they speak.
- Press **Generate** after a substantive client question or objection — not after every short acknowledgment.
- Rename speakers early if multiple client-side participants appear.
- Re-open **Brief** mid-call via the header button to review prep notes (company stays locked).

### Audience level cheat sheet

- **Developer / technical buyer** — stack names, protocols, implementation detail.
- **Mixed room (default)** — balance tech and outcomes; mirror client vocabulary.
- **CEO / non-technical** — outcomes, risk reduction, plain language; jargon softened in sanitizer.

### Manual fallback

If tab audio fails:

- Use the pencil icon to type what the client said.
- Manual entries use speaker `Client` and queue for coaching like live speech.

---

## 14. Development and testing

### `scripts/test-analyze.mjs`

- Requires `npm run dev` running.
- Replays a scripted client conversation against live `/api/analyze`.
- Uses fake in-memory knowledge (no Sheets).
- Validates that technical turns don’t name-drop portfolio clients and experience turns do cite appropriately.

```bash
node scripts/test-analyze.mjs
BASE_URL=http://localhost:3001 node scripts/test-analyze.mjs
```

### `scripts/surprising-conversations.mjs`

- Extended scenario runner for edge-case coaching behavior.

---

## 15. UI components (brief)

- **CopilotModal** — full session orchestration.
- **TranscriptBubble** — speaker avatar, label, text per utterance.
- **SuggestionCard** — parses `**Section:**` markdown into ordered green blocks.
- **MicButton** — record/stop with volume ring animation.
- **SpeakerMapEditor** — inline rename inputs per detected speaker ID.

Styling: Tailwind + custom animations (`listening-ring`, `pulse-dot`, `animate-slide-up`) in global CSS.

---

## 16. Security notes

- API keys never ship to the browser; only short-lived AssemblyAI streaming tokens are exposed.
- `.env.local` must not be committed (`.env.example` is the template).
- The `.env.example` in the repo may contain example credentials — rotate any exposed keys in production.
- Coaching output is constrained by allowlists (portfolio names, sheet-derived prices) to reduce hallucination risk — but operators should still verify numbers and claims before quoting clients.

---

## 17. Known limitations and troubleshooting

**Transcription**

- Wrong speaker labels: usually echo bleed; system uses island-merge heuristics but perfect diarization isn’t guaranteed.
- Client heard as You: confirm tab audio is shared, not just mic.
- “Could not start live transcription”: check `ASSEMBLYAI_API_KEY` and token route.

**Coaching**

- Empty Generate / 204: no client utterances in the coaching slice — wait for client speech or use manual input.
- Suggestion suddenly rewrites at end: sanitizer `replace` — expected when raw model output violated rules.
- Irrelevant portfolio cites: improve brief (industry, website) so knowledge scoring ranks better rows.

**Sheets**

- “Could not save — check Sheets connection”: verify service account access, Sheet IDs, and API enablement.
- Knowledge empty: check **All Work** tab name, headers, and that row 1 has data in column A.

**Browser**

- Firefox/Safari may have weaker `getDisplayMedia` audio support — Chrome is the supported browser.

**Legacy code**

- `useAudioRecorder` + `/api/transcribe` and `useSpeechRecognition` remain in the repo; the production UI path is **streaming only**.

---

## 18. Mental model summary

- **Capture** — mic + tab audio → dual-channel stream
- **Transcription** — AssemblyAI real-time turns → You / Client utterances
- **Context** — brief + Sheets knowledge + full transcript + coaching history
- **Reasoning** — GPT-4o with large system prompt and intent guidance
- **Guardrails** — sanitizer: names, prices, repetition, audience, fluff
- **Persistence** — localStorage (brief), Google Sheets (meeting log)

The system is designed for **live sales calls** where the rep needs fast, accurate, on-brand responses — not post-meeting note-taking alone. Transcription is the input; **controlled, intent-aware coaching** is the core product value.
