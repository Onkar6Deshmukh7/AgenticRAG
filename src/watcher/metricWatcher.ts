/**
 * metricWatcher.ts — the monitoring loop at the center of the tool.
 *
 * Responsibilities:
 *   - Poll the dashboard's /api/metrics/live every 10 seconds.
 *   - Compare each monitored metric against its guardrail.
 *   - Enforce the ONE-REPORT-PER-BREACH latch (see checkGuardrails below —
 *     this is the most important behavioral rule in the tool).
 *   - Trigger the RCA pipeline on a fresh breach.
 *   - Emit events (poll / breach / recovery / progress / complete / error)
 *     that the SSE layer forwards to the browser.
 *
 * Resilience: if the dashboard is unreachable, we slow polling to every 30s
 * and keep retrying — a single failure must never crash the process.
 */
import { EventEmitter } from "node:events";
import { CONFIG } from "../config.js";
import { generateReport } from "../rca/reportGenerator.js";
import { startRun, stopRun } from "../db/neon.js";
import type { BreachEvent, GuardrailConfig, PollResult, SseEvent, ToolStatus } from "../types.js";

export class MetricWatcher extends EventEmitter {
  private guardrails: GuardrailConfig[] = [];
  private dashboardUrl = "";
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private dashboardConnected = false;
  private lastPollAt: string | null = null;
  private totalPolls = 0;
  private totalBreaches = 0;
  private reportsGenerated = 0;
  private runId: string | null = null;

  /**
   * THE LATCH. A metric in this set has already produced its one report for
   * the current breach episode. It leaves the set only when the metric
   * recovers, which re-arms it for the next episode.
   * Net effect: breach → one report → silence while still breached →
   * recovery → re-armed → next breach → one new report. No duplicates.
   */
  private breachedMetrics = new Set<string>();

  /**
   * FRESH-DATA GATING. We must never fire off the snapshot that already
   * existed when the user clicked Initialize — only off data that appears
   * *after*. So the first evaluable poll just records a baseline (no latch),
   * and thereafter the latch runs only when a genuinely new period arrives.
   *   - baselineEstablished: has the first evaluable poll been seen yet?
   *   - lastEvaluatedKey: the period (or poll count, for period-less
   *     dashboards) we last ran the latch against — dedupes repeat polls of
   *     the same period.
   */
  private baselineEstablished = false;
  private lastEvaluatedKey: number | null = null;

  /** Typed emit helper so every event matches the SseEvent union. */
  private emitEvent(event: SseEvent): void {
    this.emit("sse", event);
  }

  getStatus(): ToolStatus {
    return {
      running: this.running,
      dashboardUrl: this.dashboardUrl,
      dashboardConnected: this.dashboardConnected,
      lastPollAt: this.lastPollAt,
      pollIntervalMs: CONFIG.POLL_INTERVAL_MS,
      monitoredMetrics: this.guardrails,
      totalPolls: this.totalPolls,
      totalBreaches: this.totalBreaches,
      reportsGenerated: this.reportsGenerated,
      breachedMetrics: [...this.breachedMetrics],
    };
  }

  /** Start monitoring. Called by POST /api/initialize. */
  async start(dashboardUrl: string, guardrails: GuardrailConfig[]): Promise<void> {
    this.stopTimer(); // restart cleanly if already running
    this.dashboardUrl = dashboardUrl.replace(/\/$/, "");
    this.guardrails = guardrails;
    this.running = true;
    this.totalPolls = 0;
    this.totalBreaches = 0;
    this.reportsGenerated = 0;
    this.breachedMetrics.clear();
    this.baselineEstablished = false;
    this.lastEvaluatedKey = null;

    this.runId = await startRun(
      this.dashboardUrl,
      guardrails.map((g) => ({ metric: g.metricKey, guardrail: g.threshold, direction: g.direction }))
    );

    console.log(
      `[watcher] Started — monitoring ${guardrails.length} metric(s) on ${this.dashboardUrl} every ${CONFIG.POLL_INTERVAL_MS / 1000}s`
    );
    this.emitEvent({ event: "status", data: this.getStatus() });
    void this.pollOnce(); // poll immediately, then the loop schedules itself
  }

  /** Stop monitoring. Called by POST /api/stop. */
  async stop(): Promise<void> {
    this.stopTimer();
    this.running = false;
    await stopRun(this.runId, this.totalPolls, this.totalBreaches);
    this.runId = null;
    console.log("[watcher] Stopped.");
    this.emitEvent({ event: "status", data: this.getStatus() });
  }

  private stopTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Schedule the next poll: 10s normally, 30s while disconnected. */
  private scheduleNext(): void {
    if (!this.running) return;
    const delay = this.dashboardConnected ? CONFIG.POLL_INTERVAL_MS : CONFIG.DISCONNECTED_RETRY_MS;
    this.timer = setTimeout(() => void this.pollOnce(), delay);
  }

  /** One iteration of the polling loop. Never throws. */
  private async pollOnce(): Promise<void> {
    try {
      const poll = await this.fetchLiveMetrics();
      this.dashboardConnected = true;
      this.lastPollAt = poll.timestamp;
      this.totalPolls++;
      this.checkGuardrails(poll);
    } catch (err) {
      if (this.dashboardConnected) {
        console.warn(
          `[watcher] Dashboard unreachable — retrying every ${CONFIG.DISCONNECTED_RETRY_MS / 1000}s.`,
          err instanceof Error ? err.message : err
        );
      }
      this.dashboardConnected = false;
      this.emitEvent({ event: "status", data: this.getStatus() });
    }
    this.scheduleNext();
  }

  /**
   * Fetch and normalize the dashboard's live metrics. Dashboards vary, so we
   * accept three shapes:
   *   1. { current_period, is_running, window: [{ period, values }, ...] }
   *      — the real hosted dashboard: a rolling window of periods; we take
   *        the most recent entry's values.
   *   2. { period: 6, values: { acceptance_rate: 82.1, ... } }
   *      — a single-period shape (used by the local mock dashboard).
   *   3. { acceptance_rate: 82.1, ... }             (flat, no wrapper)
   */
  private async fetchLiveMetrics(): Promise<PollResult> {
    const response = await fetch(`${this.dashboardUrl}/api/metrics/live`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Dashboard responded ${response.status}`);
    const body = (await response.json()) as Record<string, unknown>;

    let rawValues: Record<string, unknown> = {};
    let period: number | null = null;
    // Default to "running" for the mock/flat shapes, which have no explicit
    // running flag; shape 1 (the real dashboard) reports is_running directly.
    let isRunning = true;

    if (Array.isArray(body.window)) {
      // Shape 1: rolling window — take the latest period.
      const window = body.window as Array<{ period?: number; values?: Record<string, unknown> }>;
      const latest = window[window.length - 1];
      if (latest?.values && typeof latest.values === "object") {
        rawValues = latest.values;
        period = typeof latest.period === "number" ? latest.period : null;
      }
      // Empty window (simulation not started yet) → no values, not running.
      isRunning = typeof body.is_running === "boolean" ? body.is_running : window.length > 0;
    } else if (body.values && typeof body.values === "object") {
      // Shape 2: single period with a values wrapper.
      rawValues = body.values as Record<string, unknown>;
      period = typeof body.period === "number" ? body.period : null;
    } else {
      // Shape 3: flat object of metric -> value.
      rawValues = body;
      period = typeof body.period === "number" ? body.period : null;
    }

    const values: Record<string, number> = {};
    for (const [key, value] of Object.entries(rawValues)) {
      const num = typeof value === "number" ? value : Number((value as { value?: unknown })?.value ?? value);
      if (Number.isFinite(num)) values[key] = num;
    }

    return { period, isRunning, values, timestamp: new Date().toISOString() };
  }

  /** Is this value breaching its guardrail? */
  private isBreached(value: number, g: GuardrailConfig): boolean {
    return g.direction === "min" ? value < g.threshold : value > g.threshold;
  }

  /** Is this value within 10% of its threshold (amber warning zone)? */
  private isNearThreshold(value: number, g: GuardrailConfig): boolean {
    const margin = Math.abs(g.threshold) * 0.1;
    return g.direction === "min"
      ? value >= g.threshold && value < g.threshold + margin
      : value <= g.threshold && value > g.threshold - margin;
  }

  /**
   * Process one poll. Two responsibilities, deliberately separated:
   *   1. Update the live feed EVERY poll (compute statuses, emit poll/status)
   *      so the UI always reflects the newest values.
   *   2. Run the breach/recovery LATCH only on genuinely new live data —
   *      never off the pre-existing snapshot at Initialize, and never twice
   *      for the same period. See the gating comments below.
   */
  private checkGuardrails(poll: PollResult): void {
    // --- (1) Always refresh the feed -------------------------------------
    const statuses: Record<string, "ok" | "warning" | "breached"> = {};
    for (const g of this.guardrails) {
      const value = poll.values[g.metricKey];
      if (value === undefined) continue; // dashboard didn't report this metric
      statuses[g.metricKey] = this.isBreached(value, g)
        ? "breached"
        : this.isNearThreshold(value, g)
          ? "warning"
          : "ok";
    }
    this.emitEvent({
      event: "poll",
      data: { period: poll.period, values: poll.values, statuses, timestamp: poll.timestamp },
    });
    this.emitEvent({ event: "status", data: this.getStatus() });

    // --- (2) Decide whether to run the latch on this poll ----------------
    // Don't evaluate a stopped/idle simulation — those are stale values.
    if (!poll.isRunning) return;

    // Dedupe key: real dashboards advance `period` ~every 10s (so repeated
    // polls of the same period don't re-fire); period-less dashboards fall
    // back to the poll counter so each distinct poll counts as new data.
    const key = poll.period ?? this.totalPolls;

    if (!this.baselineEstablished) {
      // First evaluable poll = the snapshot that already existed at
      // Initialize. Record it as the baseline and fire nothing. Crucially,
      // SEED THE LATCH with any metric already breaching right now, so we only
      // ever report NEW breaches that occur after monitoring starts — a
      // pre-existing problem is treated as already-reported until it recovers
      // and breaches again. This is what makes "monitor from here forward"
      // behave intuitively and kills the false-fire-on-startup bug.
      this.baselineEstablished = true;
      this.lastEvaluatedKey = key;
      for (const g of this.guardrails) {
        const value = poll.values[g.metricKey];
        if (value !== undefined && this.isBreached(value, g)) {
          this.breachedMetrics.add(g.metricKey);
          console.log(
            `[watcher] ${g.metricKey} already breaching at start (value ${value}, guardrail ${g.direction} ${g.threshold}) — latched, no report until it recovers first.`
          );
        }
      }
      console.log(`[watcher] Baseline established at period ${poll.period ?? "n/a"} — monitoring new data from here.`);
      return;
    }
    if (key === this.lastEvaluatedKey) return; // same period as last eval — skip
    this.lastEvaluatedKey = key;

    // --- (3) Fresh period: apply the latch to every metric ---------------
    this.evaluateLatch(poll);
  }

  /** Apply the one-report-per-breach latch across all metrics for a fresh period. */
  private evaluateLatch(poll: PollResult): void {
    for (const g of this.guardrails) {
      const value = poll.values[g.metricKey];
      if (value === undefined) continue;

      const breached = this.isBreached(value, g);

      if (breached && !this.breachedMetrics.has(g.metricKey)) {
        // FRESH breach: latch it and fire exactly one report.
        this.breachedMetrics.add(g.metricKey);
        this.totalBreaches++;
        console.log(
          `[watcher] ⚠ BREACH: ${g.metricKey} = ${value} (guardrail: ${g.direction} ${g.threshold}) — triggering RCA pipeline`
        );
        this.emitEvent({
          event: "breach",
          data: { metric: g.metricKey, displayName: g.displayName, value, guardrail: g.threshold, direction: g.direction },
        });
        void this.runRcaPipeline(g, value);
      } else if (!breached && this.breachedMetrics.has(g.metricKey)) {
        // RECOVERY: un-latch so a future breach triggers a new report.
        this.breachedMetrics.delete(g.metricKey);
        console.log(
          `[watcher] ✓ ${g.metricKey} recovered (value: ${value}, guardrail: ${g.direction} ${g.threshold})`
        );
        this.emitEvent({
          event: "recovery",
          data: { metric: g.metricKey, displayName: g.displayName, value, guardrail: g.threshold },
        });
      }
      // (breached && already latched) → still failing, already reported: do nothing.
      // (!breached && not latched)   → healthy: do nothing.
    }
  }

  /** Run the full RCA pipeline for one fresh breach. Never throws. */
  private async runRcaPipeline(g: GuardrailConfig, value: number): Promise<void> {
    const breach: BreachEvent = {
      metricKey: g.metricKey,
      displayName: g.displayName,
      unit: g.unit,
      value,
      threshold: g.threshold,
      direction: g.direction,
      framework: (await import("../rca/frameworkSelector.js")).selectFramework(g.metricKey),
      detectedAt: new Date().toISOString(),
    };

    try {
      const report = await generateReport(breach, (step, message) =>
        this.emitEvent({ event: "progress", data: { step, message } })
      );
      this.reportsGenerated++;
      console.log(`[watcher] Report ready: ${report.id} (provider: ${report.llmProvider})`);
      this.emitEvent({ event: "complete", data: { reportId: report.id } });
      this.emitEvent({ event: "status", data: this.getStatus() });
    } catch (err) {
      // generateReport itself catches everything, but belt-and-braces:
      const message = err instanceof Error ? err.message : String(err);
      console.error("[watcher] RCA pipeline error:", message);
      this.emitEvent({ event: "error", data: { message } });
    }
  }
}

/** Single global watcher instance (single-user tool — global state is fine). */
export const watcher = new MetricWatcher();
