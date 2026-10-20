# Agentic RAG-based Root Cause Analysis Tool

Monitors a live product-metrics dashboard, detects guardrail breaches, and **autonomously generates a structured RCA report** by combining:

- **RAG (Retrieval-Augmented Generation):** semantic search over past RCA reports stored in **Pinecone**, embedded with **Google AI Studio** (`gemini-embedding-001`).
- **Web search:** DuckDuckGo lookup for external factors (no API key needed).
- **Deterministic framework selection:** each metric maps to an RCA framework — MECE, Fishbone (Ishikawa), or Funnel Degradation.
- **LLM generation with fallback:** **Groq** (`llama-3.3-70b-versatile`) primary → **Gemini** (`gemini-2.5-flash-lite`) fallback, both behind a built-in rate limiter to protect free-tier quotas.
- **Neon Postgres** for report storage + run history, **SSE** for live progress in the browser, optional **email delivery** on user click.

## How it works

```
Dashboard ──poll 10s──▶ Metric Watcher ──breach──▶ RCA Pipeline
                            │ (one-report-per-breach latch)      │
                            ▼                                    ▼
                     SSE → browser UI          1. Pinecone vector search (past reports)
                                               2. DuckDuckGo search (external factors)
                                               3. Framework-specific LLM prompt
                                               4. Groq → Gemini fallback
                                               5. Save to Neon → render in viewer
```

**One report per breach (latch behavior):** when a metric breaches its guardrail, exactly one report is generated. While it stays breached, nothing more happens. When it recovers, the metric re-arms — a future breach triggers one new report. No duplicates, no spam.

## Prerequisites

- Node.js 20+ installed (https://nodejs.org/)
- Free accounts (no credit card needed for any of these):
  - Groq API key: https://console.groq.com
  - Google AI Studio API key: https://aistudio.google.com
  - Pinecone API key: https://app.pinecone.io
  - Neon database: https://console.neon.tech (create a project → copy the connection string)

## Setup

1. Clone this repo and cd into it.
2. Install dependencies:

       npm install

3. Copy `.env.example` to `.env` and fill in your keys:

       copy .env.example .env

4. Run database migrations (creates tables in Neon):

       npm run migrate

5. Ingest sample reports into Pinecone (one-time — creates the index, chunks the 3 sample RCA reports, embeds them, and upserts the vectors):

       npm run ingest

6. Open your dashboard (Vercel URL or localhost:8000) and click **"Start simulation."** Leave it running while the RCA tool monitors it.
7. Start the tool:

       npm run dev

8. Open http://localhost:3000 in your browser.
9. Select metrics, set guardrails, click **"Initialize tool."**
10. Wait for a guardrail breach. The tool will detect it and generate an RCA report automatically — the
    browser transitions to the report viewer with a live progress animation.

## Testing without your real dashboard

A tiny mock dashboard is included for local testing and demos:

    npm run mock-dashboard        # serves http://localhost:8000/api/metrics/live

Set `DASHBOARD_URL=http://localhost:8000` in `.env`, initialize the tool, then
trigger a breach manually from another terminal:

    curl "http://localhost:8000/set?metric=acceptance_rate&value=64.2"

Recover it with a value above the guardrail (e.g. `value=82`) to re-arm the latch.

## Optional: Email

To enable the **"Send via Email"** button on the report page:

- Use a Gmail account with an App Password: https://myaccount.google.com/apppasswords
- Fill in the `SMTP_*` variables and `REPORT_EMAIL_TO` in `.env`.

Email is sent **only** when you click the button — never automatically.

## Scripts

| Script            | What it does                                        |
| ----------------- | --------------------------------------------------- |
| `npm run dev`     | Run in development with `tsx` (no build step)       |
| `npm run build`   | Compile TypeScript to `dist/`                       |
| `npm start`       | Run the compiled build (`dist/index.js`)            |
| `npm run migrate` | Create the Neon tables (idempotent)                 |
| `npm run ingest`  | One-time Pinecone ingestion of `sample-reports/*.md`|
| `npm run typecheck` | Type-check without emitting                       |

## Graceful degradation

The tool is a monitor — it must never die on a single failure:

| Failure              | Behavior                                                        |
| -------------------- | --------------------------------------------------------------- |
| Dashboard unreachable| Shows "disconnected", retries every 30s instead of 10s          |
| Pinecone/embeddings  | Falls back to reading sample reports directly from disk         |
| Web search           | Proceeds without external context, notes it in the prompt       |
| Groq rate-limited    | Falls back to Gemini; both exhausted → queues and waits         |
| Both LLMs fail       | Saves a `generation_failed` report so the breach is on record   |
| Neon down            | Falls back to in-memory storage for the session                 |
| Email fails          | Error toast in UI; the report itself is unaffected              |

## Project structure

```
src/
├── index.ts                 # Entry point: Express server + safety nets
├── config.ts                # Env vars, defaults, metric catalog
├── types.ts                 # Shared interfaces
├── db/                      # Neon Postgres: schema, migrations, storage layer
├── vectordb/                # Pinecone client, embeddings, ingestion script
├── watcher/metricWatcher.ts # Polling loop + breach latch + pipeline trigger
├── rca/                     # Context gathering (RAG + web), framework selection,
│                            #   prompt building, LLM generation with fallback
├── delivery/emailSender.ts  # Nodemailer (manual trigger only)
├── rateLimiter/             # Per-provider token-bucket rate limiter
└── server/routes.ts         # REST API + SSE stream
public/
├── index.html               # Setup & monitoring page
└── report.html              # Report viewer with suspense animation
sample-reports/              # 3 past RCA reports (the RAG corpus)
```
