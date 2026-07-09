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
    this.breachedMetrics.clear();

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

    if (Array.isArray(body.window)) {
      // Shape 1: rolling window — take the latest period.
      const window = body.window as Array<{ period?: number; values?: Record<string, unknown> }>;
      const latest = window[window.length - 1];
      if (latest?.values && typeof latest.values === "object") {
        rawValues = latest.values;
        period = typeof latest.period === "number" ? latest.period : null;
      }
      // Empty window (simulation not started yet) → no values this poll.
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

    return { period, values, timestamp: new Date().toISOString() };
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

  /** Apply the latch rules to every monitored metric for one poll. */
  private checkGuardrails(poll: PollResult): void {
    const statuses: Record<string, "ok" | "warning" | "breached"> = {};

    for (const g of this.guardrails) {
      const value = poll.values[g.metricKey];
      if (value === undefined) continue; // dashboard didn't report this metric

      const breached = this.isBreached(value, g);
      statuses[g.metricKey] = breached ? "breached" : this.isNearThreshold(value, g) ? "warning" : "ok";

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

    this.emitEvent({
      event: "poll",
      data: { period: poll.period, values: poll.values, statuses, timestamp: poll.timestamp },
    });
    this.emitEvent({ event: "status", data: this.getStatus() });
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
