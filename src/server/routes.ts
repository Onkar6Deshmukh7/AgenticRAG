/**
 * routes.ts — all Express routes: the API the two HTML pages talk to,
 * plus the SSE stream that pushes live events to the browser.
 *
 * Route map:
 *   GET  /api/metrics             → metric catalog (drives the setup UI)
 *   GET  /api/test-connection     → probe the dashboard URL
 *   POST /api/initialize          → save config, start the watcher
 *   POST /api/stop                → stop the watcher
 *   GET  /api/status              → current tool status (poll counts etc.)
 *   GET  /api/reports/stream      → SSE: poll/breach/progress/complete events
 *   GET  /api/reports             → report history (newest first)
 *   GET  /api/reports/:id         → one full report
 *   POST /api/reports/:id/email   → send report by email (user click only)
 *   GET  /api/rate-limits         → LLM quota usage for the status bar
 */
import { Router, type Request, type Response } from "express";
import { ENV, METRIC_CATALOG } from "../config.js";
import { watcher } from "../watcher/metricWatcher.js";
import { getReport, listReports } from "../db/neon.js";
import { sendReportEmail } from "../delivery/emailSender.js";
import { rateLimiters } from "../rca/reportGenerator.js";
import type { GuardrailConfig, InitializeRequest, SseEvent } from "../types.js";

export const router = Router();

// ---------------------------------------------------------------------------
// SSE plumbing
// ---------------------------------------------------------------------------
// Every connected browser tab holds one Response here. The watcher emits
// typed events; we serialize them into the SSE wire format and fan out.
const sseClients = new Set<Response>();

function broadcast(event: SseEvent): void {
  const payload = `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

// Wire the watcher's events straight into the SSE broadcaster.
watcher.on("sse", broadcast);

router.get("/api/reports/stream", (req: Request, res: Response) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  // Send the current status immediately so a freshly-opened tab syncs up.
  res.write(`event: status\ndata: ${JSON.stringify(watcher.getStatus())}\n\n`);

  sseClients.add(res);
  // Heartbeat comment every 25s keeps proxies from closing the connection.
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

// ---------------------------------------------------------------------------
// Setup + control endpoints
// ---------------------------------------------------------------------------

/** Metric catalog + defaults — the setup page builds its checkboxes from this. */
router.get("/api/metrics", (_req, res) => {
  res.json({
    dashboardUrl: ENV.DASHBOARD_URL,
    metrics: Object.entries(METRIC_CATALOG).map(([key, m]) => ({
      key,
      displayName: m.displayName,
      unit: m.unit,
      framework: m.framework,
      direction: m.direction,
      defaultGuardrail: m.defaultGuardrail,
    })),
  });
});

/** "Test connection" button: probe {url}/api/metrics/live. */
router.get("/api/test-connection", async (req, res) => {
  const url = String(req.query.url ?? ENV.DASHBOARD_URL).replace(/\/$/, "");
  if (!url) {
    res.status(400).json({ ok: false, error: "No dashboard URL provided." });
    return;
  }
  try {
    const response = await fetch(`${url}/api/metrics/live`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Dashboard responded ${response.status}`);
    await response.json(); // must at least be valid JSON
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err instanceof Error ? err.message : "Connection failed" });
  }
});

/** Initialize: validate the config, then start the watcher loop. */
router.post("/api/initialize", async (req, res) => {
  const body = req.body as Partial<InitializeRequest>;

  const dashboardUrl = (body.dashboardUrl ?? ENV.DASHBOARD_URL).trim();
  if (!dashboardUrl) {
    res.status(400).json({ ok: false, error: "Dashboard URL is required." });
    return;
  }

  // Validate every guardrail against the catalog — reject unknown metrics
  // and non-numeric thresholds instead of silently monitoring garbage.
  const guardrails: GuardrailConfig[] = [];
  for (const g of body.guardrails ?? []) {
    const metric = METRIC_CATALOG[g.metricKey];
    if (!metric) {
      res.status(400).json({ ok: false, error: `Unknown metric: ${g.metricKey}` });
      return;
    }
    const threshold = Number(g.threshold);
    if (!Number.isFinite(threshold)) {
      res.status(400).json({ ok: false, error: `Invalid guardrail for ${g.metricKey}` });
      return;
    }
    guardrails.push({
      metricKey: g.metricKey,
      displayName: metric.displayName,
      unit: metric.unit,
      direction: metric.direction,
      threshold,
    });
  }

  if (guardrails.length === 0) {
    res.status(400).json({ ok: false, error: "Select at least one metric with a guardrail." });
    return;
  }

  await watcher.start(dashboardUrl, guardrails);
  res.json({ ok: true, monitoring: guardrails.length });
});

router.post("/api/stop", async (_req, res) => {
  await watcher.stop();
  res.json({ ok: true });
});

router.get("/api/status", (_req, res) => {
  res.json(watcher.getStatus());
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

router.get("/api/reports", async (_req, res) => {
  const reports = await listReports();
  // History list only needs metadata, not the full markdown bodies.
  res.json(
    reports.map(({ reportMarkdown: _md, ...meta }) => meta)
  );
});

router.get("/api/reports/:id", async (req, res) => {
  const report = await getReport(String(req.params.id));
  if (!report) {
    res.status(404).json({ error: "Report not found." });
    return;
  }
  res.json(report);
});

/** Email — fires ONLY from the user's click in the report viewer. */
router.post("/api/reports/:id/email", async (req, res) => {
  const report = await getReport(String(req.params.id));
  if (!report) {
    res.status(404).json({ ok: false, error: "Report not found." });
    return;
  }
  try {
    const recipient = await sendReportEmail(report);
    res.json({ ok: true, recipient });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : "Email failed" });
  }
});

// ---------------------------------------------------------------------------
// Rate limits (for the quota display in the status bar)
// ---------------------------------------------------------------------------

router.get("/api/rate-limits", (_req, res) => {
  res.json({
    groq: rateLimiters.groq.getUsage(),
    gemini: rateLimiters.gemini.getUsage(),
  });
});
