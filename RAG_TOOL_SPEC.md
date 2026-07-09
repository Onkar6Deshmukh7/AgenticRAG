# Project: agentic RAG-based RCA tool

## Instructions for the builder (read first)
Build this project **completely**, then **run it locally, test the full pipeline end-to-end, and verify the report generation and web UI before reporting done** — do not stop at just writing the files. Specifically:
- The developer is on **Windows** and is comfortable with **TypeScript/Node.js** but new to Pinecone, Neon, and LLM APIs.
- Initialize the project with `npm init`, install all dependencies, configure `tsconfig.json`, and set up build + dev scripts.
- After building, start the tool, walk through the user flow (select metrics → set guardrails → initialize → wait for breach → view report), and confirm it works end-to-end.
- Keep the code readable and heavily commented — the developer will need to explain every component in interviews.
- Use **ES modules** (`"type": "module"` in package.json) and modern TypeScript throughout.

## Purpose
This is an **agentic RAG-based Root Cause Analysis tool** that:
1. Lets the user choose which metrics to track and set custom guardrail thresholds.
2. Polls a hosted product metrics dashboard for live data.
3. When a guardrail is breached, autonomously gathers context (past reports via vector search + web search for external factors), selects an RCA framework, and generates a structured report using an LLM.
4. Shows the report in-browser with a suspense animation during generation.
5. Optionally emails the report on user's click (not automatic).

The dashboard is a separate project already hosted on Vercel. The user will provide its URL.

## Tech stack
- **Runtime:** Node.js 20+
- **Language:** TypeScript (strict mode)
- **Backend framework:** Express
- **LLM:** Groq API (primary, `llama-3.3-70b-versatile`) + Google AI Studio / Gemini (`gemini-2.5-flash-lite`) as fallback. Both OpenAI SDK-compatible — use the `openai` npm package with `baseURL` swap.
- **Embeddings:** Google AI Studio embedding model (free, same API key as Gemini).
- **Vector DB:** Pinecone (free tier — 2M vectors, no credit card). Stores chunked sample RCA reports for semantic retrieval.
- **Database:** Neon serverless Postgres (free tier — 512MB, no credit card). Stores generated reports, guardrail configurations, and run history.
- **Web search:** `duckduckgo-search` npm package (or lightweight alternative, no API key needed).
- **Email:** `nodemailer` with Gmail SMTP (app password). Triggered manually, not automatically.
- **Rate limiter:** Built-in token bucket / request counter per LLM provider to stay within free tier limits.

## File structure
```
/
├── src/
│   ├── index.ts                  # Entry point: starts Express server
│   ├── config.ts                 # All configuration: env vars, defaults, metric catalog
│   ├── db/
│   │   ├── neon.ts               # Neon Postgres client + connection
│   │   ├── schema.sql            # Table definitions (reports, guardrail_configs, run_history)
│   │   └── migrations.ts         # Run schema on startup if tables don't exist
│   ├── vectordb/
│   │   ├── pinecone.ts           # Pinecone client init + index management
│   │   ├── embeddings.ts         # Google AI Studio embedding calls
│   │   └── ingest.ts             # One-time script: chunk sample reports → embed → upsert to Pinecone
│   ├── watcher/
│   │   └── metricWatcher.ts      # Polls dashboard, checks guardrails, triggers RCA pipeline
│   ├── rca/
│   │   ├── contextGatherer.ts    # Vector search on past reports + web search for external factors
│   │   ├── frameworkSelector.ts  # Metric → RCA framework (deterministic lookup)
│   │   ├── promptBuilder.ts      # Assembles the full LLM prompt
│   │   └── reportGenerator.ts    # Calls LLM (Groq → Gemini fallback) with rate limiting
│   ├── delivery/
│   │   └── emailSender.ts        # Sends report via email (on user click only)
│   ├── rateLimiter/
│   │   └── rateLimiter.ts        # Token bucket rate limiter for LLM API calls
│   ├── server/
│   │   └── routes.ts             # Express routes: setup UI, report viewer, API endpoints
│   └── types.ts                  # Shared TypeScript interfaces
├── sample-reports/
│   ├── sample_rca_1.md           # Past RCA: acceptance rate drop (Fishbone)
│   ├── sample_rca_2.md           # Past RCA: gross bookings decline (MECE)
│   └── sample_rca_3.md           # Past RCA: completion rate drop (Funnel Degradation)
├── public/
│   ├── index.html                # Setup page: choose metrics, set guardrails, initialize
│   └── report.html               # Report viewer page with suspense animation
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

## Configuration (.env + config.ts)

```env
# .env (user creates from .env.example)

# Dashboard
DASHBOARD_URL=https://your-dashboard.vercel.app

# LLM
GROQ_API_KEY=gsk_...
GEMINI_API_KEY=AIza...

# Vector DB
PINECONE_API_KEY=pcsk_...

# Database
DATABASE_URL=postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/dbname?sslmode=require

# Email (optional — only needed if user wants to send reports via email)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your.email@gmail.com
SMTP_PASS=your-app-password
REPORT_EMAIL_TO=recipient@example.com
```

```typescript
// config.ts defaults
export const CONFIG = {
  TOOL_PORT: 3000,
  POLL_INTERVAL_MS: 10_000,        // match dashboard's 10-second period
  PINECONE_INDEX_NAME: "rca-reports",
  EMBEDDING_MODEL: "gemini-embedding-001",  // Google AI Studio free embedding model (3072 dimensions)
  LLM_PRIMARY_MODEL: "llama-3.3-70b-versatile",
  LLM_FALLBACK_MODEL: "gemini-2.5-flash-lite",
  RATE_LIMITS: {
    groq: { maxRequestsPerDay: 800, maxRequestsPerMinute: 25 },   // conservative: 80% of Groq's 1000/day
    gemini: { maxRequestsPerDay: 1200, maxRequestsPerMinute: 8 }, // conservative: 80% of Gemini's 1500/day
  },
};
```

## Metric catalog (hardcoded in config.ts)
Same 10 metrics as the dashboard. Each metric has a canonical key, display name, unit, and the RCA framework it maps to.

```typescript
export const METRIC_CATALOG = {
  mapc:                    { displayName: "Monthly Active Platform Consumers (MAPCs)", unit: "count",   framework: "mece" as const },
  total_trips:             { displayName: "Total Trips",                               unit: "count",   framework: "mece" as const },
  gross_bookings:          { displayName: "Total Gross Bookings",                      unit: "USD",     framework: "mece" as const },
  take_rate:               { displayName: "Total Take Rate",                           unit: "%",       framework: "funnel_degradation" as const },
  adj_ebitda:              { displayName: "Adjusted EBITDA",                            unit: "USD",     framework: "mece" as const },
  eta:                     { displayName: "ETA (average pickup time)",                  unit: "minutes", framework: "fishbone" as const },
  request_completion_rate: { displayName: "Request-to-completion rate",                 unit: "%",       framework: "funnel_degradation" as const },
  acceptance_rate:         { displayName: "Acceptance rate",                            unit: "%",       framework: "fishbone" as const },
  driver_utilization:      { displayName: "Driver utilization rate",                    unit: "%",       framework: "fishbone" as const },
  coverage:                { displayName: "Coverage",                                  unit: "%",       framework: "fishbone" as const },
};
```

---

## User flow (this is the core UX — get this right)

### Phase 1: Setup page (public/index.html)

When the user opens `http://localhost:3000`, they see a clean setup page:

1. **Dashboard URL input** — pre-filled from `.env` but editable. A small "Test connection" button that calls the dashboard's `/api/metrics/live` and shows a green checkmark or red error.

2. **Metric selector** — a list of all 10 metrics with checkboxes. User selects which ones to monitor (can select 1 to all 10). Each selected metric expands to show:
   - The metric's display name and unit.
   - A guardrail input field: for most metrics this is a "minimum threshold" number input; for `eta` it's a "maximum threshold" (since higher ETA = worse).
   - A sensible default pre-filled (the values from the guardrails table in the previous spec version) that the user can override.

3. **"Initialize tool" button** — disabled until at least one metric is selected with a guardrail value. Clicking it:
   - Sends the selected metrics + guardrails to `POST /api/initialize`.
   - The backend saves the config to Neon, starts the metric watcher polling loop.
   - The button changes to "Tool running — monitoring X metrics" with a green pulsing dot.
   - A "Stop" button appears to halt monitoring.

4. **Status bar** at the bottom: connection status, last poll time, polling interval, number of reports generated.

### Phase 2: Monitoring (automatic, background)

Once initialized, the metric watcher polls the dashboard every 10 seconds. The setup page stays open and shows a live feed of poll results (a scrolling log or a small table showing the latest values for monitored metrics, with color coding: green = within guardrails, amber = within 10% of threshold, red = breached).

**One report per breach (latch behavior):** The watcher maintains an in-memory `Set<string>` called `breachedMetrics`. This is the most important behavioral rule in the tool:
- When a metric's value crosses its guardrail AND the metric is **not** in `breachedMetrics`: add it to the set, trigger the RCA pipeline, generate exactly **one** report.
- When a metric's value is still below its guardrail AND the metric **is** in `breachedMetrics`: do nothing — the metric is still failing, but we already reported it. No duplicate reports.
- When a metric that **is** in `breachedMetrics` **recovers** (value returns within guardrail bounds): remove it from `breachedMetrics` and log `"✅ acceptance_rate recovered (value: 82.1, guardrail: min 75)"`. This re-arms the metric so a *future* breach will trigger a new report.
- Net effect: breach → one report → silence while it stays breached → recovery → re-armed → next breach → one report. No cooldown timers, no duplicate reports, no spam.

### Phase 3: Breach detected → Report generation

When a guardrail breach is detected:

1. The setup page shows a prominent banner: `"⚠ Breach detected: acceptance_rate = 64.2 (guardrail: min 75). Generating RCA report..."`.

2. **The page transitions to (or opens) the report viewer (public/report.html)** showing a **suspense/loading animation**:
   - A clean, centered loading state with:
     - A skeleton document outline (gray pulsing bars where the report sections will be).
     - A step indicator showing the pipeline progress:
       - `"🔍 Retrieving context from past reports..."` → (vector search happening)
       - `"🌐 Searching for external factors..."` → (web search happening)
       - `"🧠 Generating RCA report..."` → (LLM call happening)
       - `"✅ Report ready"` → (transitions to full report)
     - Each step transitions after the corresponding backend work completes. Use a WebSocket or SSE (server-sent events) connection from the frontend to get real-time progress updates from the backend. (SSE is simpler and sufficient here.)
   - The animation should feel professional, not gimmicky. Think: a polished SaaS product generating a report, not a toy spinner.

3. **Once the report is ready**, the suspense animation fades out and the full rendered report fades in. The report is rendered as formatted HTML from the LLM's markdown output.

### Phase 4: Report viewer (public/report.html)

The report page shows:

1. **Report header**: metric name, breach value, guardrail, framework used, timestamp, severity badge.
2. **Full rendered report**: the LLM's markdown output converted to clean HTML. Sections: Executive Summary, Metric Trend Analysis, Root Cause Analysis (with the framework structure), Contributing Factors, Recommended Actions, Severity Assessment.
3. **Action buttons** at the top:
   - `"Send via Email"` — calls `POST /api/reports/:id/email`. Shows a small confirmation toast on success ("Email sent to xyz@example.com") or an error. This is the ONLY way email gets sent — no automatic emailing.
   - `"Download as PDF"` (bonus, optional — can skip in v1).
   - `"Back to monitoring"` — returns to the setup page.
4. **Report history sidebar or section**: a list of all previously generated reports (from Neon), clickable to view any past report.

---

## Component details

### Rate limiter (rateLimiter/rateLimiter.ts)

A simple in-memory token bucket that tracks usage per provider. This is critical — free tiers are limited and a runaway loop will burn through credits.

```typescript
interface RateLimiterConfig {
  maxRequestsPerDay: number;
  maxRequestsPerMinute: number;
}

class RateLimiter {
  // Track: requests made today, requests made this minute
  // Methods:
  //   canMakeRequest(): boolean — checks both daily and per-minute limits
  //   recordRequest(): void — increments counters
  //   waitForSlot(): Promise<void> — waits until a slot is available (for queuing)
  //   getUsage(): { dailyUsed, dailyLimit, minuteUsed, minuteLimit }
  // Reset daily counter at midnight UTC, minute counter every 60s.
}
```

The report generator checks `rateLimiter.canMakeRequest("groq")` before calling Groq. If Groq is exhausted, it falls back to Gemini. If both are exhausted, it queues the request and shows "Rate limit reached — report will be generated when a slot opens" in the UI.

Expose usage stats via `GET /api/rate-limits` so the frontend can show remaining daily quota.

### Vector DB: Pinecone (vectordb/)

**One-time setup (ingest.ts):**
A script (runnable via `npm run ingest`) that:
1. Reads all `.md` files from `sample-reports/`.
2. Chunks each report into ~300-500 token segments (split by section headers or paragraph boundaries — keep chunks meaningful, not arbitrary).
3. Calls the Google AI Studio embedding API to embed each chunk.
4. Upserts the embeddings into Pinecone with metadata: `{ source: "sample_rca_1.md", section: "root_cause_analysis", framework: "fishbone" }`.

This only needs to run once (or whenever sample reports change). Include a check: if the Pinecone index already has vectors, skip ingestion and log "Vectors already ingested, skipping."

**At query time (contextGatherer.ts):**
1. Take the breach event's metric name + the selected framework.
2. Build a query string: `"{metric display name} root cause analysis {framework name}"`.
3. Embed the query using the same embedding model.
4. Query Pinecone for the top 3-5 most similar chunks.
5. Return the chunk texts as context for the prompt.

This is the "RAG" part: instead of dumping entire reports into the prompt, we retrieve only the most relevant sections. For 3 sample reports this is admittedly overkill (you could just read the files), but it demonstrates the RAG pattern properly for the resume, and scales if more reports are added later.

### Database: Neon Postgres (db/)

**Schema (schema.sql):**

```sql
CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_key VARCHAR(50) NOT NULL,
  metric_display_name VARCHAR(100) NOT NULL,
  breach_value NUMERIC NOT NULL,
  guardrail_value NUMERIC NOT NULL,
  guardrail_direction VARCHAR(10) NOT NULL,  -- 'min' or 'max'
  framework VARCHAR(30) NOT NULL,
  report_markdown TEXT NOT NULL,
  severity VARCHAR(10),
  llm_provider VARCHAR(20),                  -- 'groq' or 'gemini'
  generated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS run_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ DEFAULT NOW(),
  stopped_at TIMESTAMPTZ,
  dashboard_url TEXT NOT NULL,
  monitored_metrics JSONB NOT NULL,          -- array of { metric, guardrail }
  total_polls INTEGER DEFAULT 0,
  total_breaches INTEGER DEFAULT 0
);
```

Use the `@neondatabase/serverless` package for the Postgres client — it works over HTTP, no connection pooling headaches.

**migrations.ts:** On app startup, run the CREATE TABLE statements. Use `IF NOT EXISTS` so it's idempotent.

### Web search (contextGatherer.ts)

Search for external context using DuckDuckGo (no API key):
- Query: `"ride hailing {metric display name} drop reasons 2026"`
- Take top 3-5 results (title + snippet + URL).
- Include in the prompt as "External context."
- If search fails, proceed without it and note `"Web search unavailable"` in the prompt.

### Framework selector (frameworkSelector.ts)

Pure lookup — already defined in `METRIC_CATALOG` above. The function just reads `METRIC_CATALOG[metricKey].framework`.

**Framework-specific prompt instructions:**

**MECE:**
```
Decompose {metric} into mutually exclusive, collectively exhaustive sub-drivers.
For each sub-driver, state whether it likely moved, estimate direction and magnitude, and assess whether it explains the overall drop.
Identify the 1-2 sub-drivers most likely responsible.
Present as a tree: Level 1 splits, then Level 2 where helpful.
```

**Fishbone (Ishikawa):**
```
Organize potential root causes into these categories:
- People (driver behavior, rider behavior, workforce changes)
- Process (matching algorithm, pricing, surge logic, incentive programs)
- Platform (app bugs, infrastructure issues, API latency, deployment incidents)
- External (weather, competitor activity, regulation, seasonal patterns)
For each category, list 2-3 plausible causes and assess likelihood (High/Medium/Low).
Identify the single most likely root cause.
```

**Funnel Degradation:**
```
Map {metric} to its conversion funnel stages:
- request_completion_rate: Request → Driver Match → Driver Acceptance → Pickup → Trip Completion
- take_rate: Gross Bookings → Platform Fees → Driver Pay → Incentives/Promotions → Net Revenue
For each stage, describe what a degradation would look like and assess whether this stage likely caused the overall metric drop.
Identify the stage with the largest inferred degradation.
```

### Report generator (reportGenerator.ts)

1. Check rate limiter for Groq. If available, call Groq.
2. If Groq fails or is rate-limited, check Gemini. If available, call Gemini.
3. If both exhausted, queue the request and notify the frontend via SSE.
4. On success:
   - Save the report markdown + metadata to Neon.
   - Send an SSE event to the frontend: `{ status: "complete", reportId: "..." }`.
5. On failure:
   - Save a partial report to Neon with `severity: "generation_failed"`.
   - Send an SSE event: `{ status: "error", message: "..." }`.

### SSE for progress updates (server/routes.ts)

`GET /api/reports/stream` — an SSE endpoint the frontend connects to after clicking "Initialize." It sends events as the pipeline progresses:

```typescript
// Event types:
{ event: "poll",     data: { period: 6, values: {...}, status: "within_guardrails" } }
{ event: "breach",   data: { metric: "acceptance_rate", value: 64.2, guardrail: 75 } }
{ event: "progress", data: { step: "vector_search", message: "Retrieving context from past reports..." } }
{ event: "progress", data: { step: "web_search", message: "Searching for external factors..." } }
{ event: "progress", data: { step: "llm_call", message: "Generating RCA report..." } }
{ event: "complete", data: { reportId: "uuid-here" } }
{ event: "error",    data: { message: "Both LLM providers rate-limited. Queued for retry." } }
```

Frontend uses `new EventSource("/api/reports/stream")` to listen.

---

## Error handling
- Dashboard not reachable → show "Dashboard disconnected" in UI, keep retrying every 30s (not every 10s).
- LLM both fail → save error report to Neon, show error state in UI with option to retry.
- Pinecone fails → fall back to reading sample reports directly from disk (full text, no vector search). Log warning.
- Neon fails → fall back to in-memory storage for the session. Log warning. Reports will be lost on restart but the tool stays functional.
- Email fails → show error toast in UI. Report is still saved and viewable.
- Web search fails → proceed without external context.
- **Never crash the process on a single failure.** This is a monitoring tool — it must stay alive.

---

## Explicitly out of scope
- No automatic emailing — email only on user click.
- No authentication on the web UI.
- No frontend build tooling — single HTML files, vanilla JS, CSS.
- No deployment config, but structure for easy deployment later.
- No concurrent multi-user support — single global state is fine.

## Deliverables
- Working TypeScript project per the structure above.
- `package.json` with all dependencies and scripts:
  - `dev`: runs with `tsx` for development
  - `build`: compiles TypeScript to `dist/`
  - `start`: runs compiled JS from `dist/`
  - `ingest`: runs the one-time Pinecone ingestion script
- `tsconfig.json` with strict mode.
- `.env.example` with all environment variables listed and commented.
- 3 realistic sample RCA reports in `sample-reports/`.
- `public/index.html` (setup page) and `public/report.html` (report viewer with suspense animation).
- `README.md` with the setup and run instructions below.

### Required README content (Windows)
```
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
3. Copy .env.example to .env and fill in your keys:
       copy .env.example .env
4. Run database migrations (creates tables in Neon):
       npm run migrate
5. Ingest sample reports into Pinecone (one-time):
       npm run ingest
6. Make sure your dashboard is running (Vercel URL or localhost:8000).
7. Start the tool:
       npm run dev
8. Open http://localhost:3000 in your browser.
9. Select metrics, set guardrails, click "Initialize tool."
10. On the dashboard, start a simulation and wait for the guardrail breach.
    The tool will detect it and generate an RCA report automatically.

## Optional: Email
To enable the "Send via Email" button:
- Use a Gmail account with an App Password: https://myaccount.google.com/apppasswords
- Fill in the SMTP_* variables in .env.
```
