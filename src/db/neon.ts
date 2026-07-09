/**
 * neon.ts — Neon serverless Postgres client + report storage layer.
 *
 * Design notes:
 *   - `@neondatabase/serverless` runs queries over HTTP, so there is no
 *     connection pool to manage — perfect for a small local tool.
 *   - Per the error-handling rules, Neon must never crash the tool. Every
 *     function catches DB errors and falls back to an in-memory store for
 *     the session (reports are lost on restart but the tool keeps working).
 */
import { neon } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";
import { ENV } from "../config.js";
import type { ReportRecord } from "../types.js";

// Lazily created query function. Null when DATABASE_URL is missing.
const sql = ENV.DATABASE_URL ? neon(ENV.DATABASE_URL) : null;

// In-memory fallback store (newest first), used when Neon is unavailable.
const memoryReports: ReportRecord[] = [];
let warnedAboutFallback = false;

function warnFallback(err: unknown): void {
  if (!warnedAboutFallback) {
    console.warn(
      "[db] Neon unavailable — falling back to in-memory storage for this session.",
      err instanceof Error ? err.message : err
    );
    warnedAboutFallback = true;
  }
}

/** Convert a raw Postgres row into our camelCase ReportRecord shape. */
function rowToReport(row: Record<string, unknown>): ReportRecord {
  return {
    id: String(row.id),
    metricKey: String(row.metric_key),
    metricDisplayName: String(row.metric_display_name),
    breachValue: Number(row.breach_value),
    guardrailValue: Number(row.guardrail_value),
    guardrailDirection: row.guardrail_direction as "min" | "max",
    framework: row.framework as ReportRecord["framework"],
    reportMarkdown: String(row.report_markdown),
    severity: String(row.severity ?? ""),
    llmProvider: String(row.llm_provider ?? ""),
    generatedAt: new Date(row.generated_at as string).toISOString(),
  };
}

/** Persist a generated report. Returns the stored record (with its id). */
export async function saveReport(
  report: Omit<ReportRecord, "id" | "generatedAt">
): Promise<ReportRecord> {
  const fallback: ReportRecord = {
    ...report,
    id: randomUUID(),
    generatedAt: new Date().toISOString(),
  };

  if (!sql) {
    warnFallback("DATABASE_URL not set");
    memoryReports.unshift(fallback);
    return fallback;
  }

  try {
    const rows = await sql`
      INSERT INTO reports (
        metric_key, metric_display_name, breach_value, guardrail_value,
        guardrail_direction, framework, report_markdown, severity, llm_provider
      ) VALUES (
        ${report.metricKey}, ${report.metricDisplayName}, ${report.breachValue},
        ${report.guardrailValue}, ${report.guardrailDirection}, ${report.framework},
        ${report.reportMarkdown}, ${report.severity}, ${report.llmProvider}
      )
      RETURNING *
    `;
    return rowToReport(rows[0] as Record<string, unknown>);
  } catch (err) {
    warnFallback(err);
    memoryReports.unshift(fallback);
    return fallback;
  }
}

/** Fetch one report by id (checks Neon first, then the in-memory store). */
export async function getReport(id: string): Promise<ReportRecord | null> {
  if (sql) {
    try {
      const rows = await sql`SELECT * FROM reports WHERE id = ${id}`;
      if (rows.length > 0) return rowToReport(rows[0] as Record<string, unknown>);
    } catch (err) {
      warnFallback(err);
    }
  }
  return memoryReports.find((r) => r.id === id) ?? null;
}

/** List all reports, newest first (for the report-history sidebar). */
export async function listReports(): Promise<ReportRecord[]> {
  if (sql) {
    try {
      const rows = await sql`SELECT * FROM reports ORDER BY generated_at DESC LIMIT 100`;
      const dbReports = (rows as Record<string, unknown>[]).map(rowToReport);
      // Merge in any in-memory reports saved while Neon was down.
      return [...memoryReports, ...dbReports.filter((d) => !memoryReports.some((m) => m.id === d.id))];
    } catch (err) {
      warnFallback(err);
    }
  }
  return [...memoryReports];
}

// ---------------------------------------------------------------------------
// Run history: one row per "Initialize → Stop" monitoring session.
// Failures here are logged and ignored — history is nice-to-have.
// ---------------------------------------------------------------------------

/** Record the start of a monitoring run. Returns the run id (or null). */
export async function startRun(
  dashboardUrl: string,
  monitoredMetrics: unknown
): Promise<string | null> {
  if (!sql) return null;
  try {
    const rows = await sql`
      INSERT INTO run_history (dashboard_url, monitored_metrics)
      VALUES (${dashboardUrl}, ${JSON.stringify(monitoredMetrics)}::jsonb)
      RETURNING id
    `;
    return String((rows[0] as Record<string, unknown>).id);
  } catch (err) {
    warnFallback(err);
    return null;
  }
}

/** Mark a run as stopped and record its final counters. */
export async function stopRun(
  runId: string | null,
  totalPolls: number,
  totalBreaches: number
): Promise<void> {
  if (!sql || !runId) return;
  try {
    await sql`
      UPDATE run_history
      SET stopped_at = NOW(), total_polls = ${totalPolls}, total_breaches = ${totalBreaches}
      WHERE id = ${runId}
    `;
  } catch (err) {
    warnFallback(err);
  }
}

/** Raw query access for migrations. Exposed so migrations.ts can reuse it. */
export function getSqlClient() {
  return sql;
}
