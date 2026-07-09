/**
 * types.ts — shared TypeScript interfaces used across the tool.
 *
 * Keeping every cross-module shape in one file makes the data flow easy to
 * trace: dashboard poll → breach event → RCA pipeline → stored report → UI.
 */
import type { Framework } from "./config.js";

/** One monitored metric + the guardrail the user configured for it. */
export interface GuardrailConfig {
  metricKey: string;
  displayName: string;
  unit: string;
  /** "min" = breach when value drops below threshold, "max" = above. */
  direction: "min" | "max";
  threshold: number;
}

/** What the user submits from the setup page when clicking "Initialize". */
export interface InitializeRequest {
  dashboardUrl: string;
  guardrails: GuardrailConfig[];
}

/** A single poll of the dashboard: raw values for the monitored metrics. */
export interface PollResult {
  period: number | null; // the dashboard's simulation period, if it reports one
  values: Record<string, number>; // metricKey -> current value
  timestamp: string; // ISO time of the poll
}

/** Emitted by the watcher the moment a guardrail is crossed. */
export interface BreachEvent {
  metricKey: string;
  displayName: string;
  unit: string;
  value: number; // the breaching value
  threshold: number;
  direction: "min" | "max";
  framework: Framework;
  detectedAt: string; // ISO timestamp
}

/** Context gathered before calling the LLM (the "RAG" part). */
export interface GatheredContext {
  /** Relevant chunks retrieved from Pinecone (or disk fallback). */
  pastReportChunks: string[];
  /** Where the chunks came from: "pinecone" or "disk_fallback". */
  retrievalSource: "pinecone" | "disk_fallback" | "none";
  /** Web search results for external factors (may be empty on failure). */
  webResults: WebSearchResult[];
  webSearchAvailable: boolean;
}

export interface WebSearchResult {
  title: string;
  snippet: string;
  url: string;
}

/** A generated (or failed) RCA report as stored in Neon. */
export interface ReportRecord {
  id: string;
  metricKey: string;
  metricDisplayName: string;
  breachValue: number;
  guardrailValue: number;
  guardrailDirection: "min" | "max";
  framework: Framework;
  reportMarkdown: string;
  severity: string; // "low" | "medium" | "high" | "critical" | "generation_failed"
  llmProvider: string; // "groq" | "gemini" | "none"
  generatedAt: string; // ISO timestamp
}

/** Live status shown in the setup page's status bar. */
export interface ToolStatus {
  running: boolean;
  dashboardUrl: string;
  dashboardConnected: boolean;
  lastPollAt: string | null;
  pollIntervalMs: number;
  monitoredMetrics: GuardrailConfig[];
  totalPolls: number;
  totalBreaches: number;
  reportsGenerated: number;
  /** Metrics currently latched as breached (one-report-per-breach rule). */
  breachedMetrics: string[];
}

/** Shape of every Server-Sent Event pushed to the frontend. */
export type SseEvent =
  | { event: "poll"; data: { period: number | null; values: Record<string, number>; statuses: Record<string, "ok" | "warning" | "breached">; timestamp: string } }
  | { event: "breach"; data: { metric: string; displayName: string; value: number; guardrail: number; direction: "min" | "max" } }
  | { event: "recovery"; data: { metric: string; displayName: string; value: number; guardrail: number } }
  | { event: "progress"; data: { step: "vector_search" | "web_search" | "llm_call"; message: string } }
  | { event: "complete"; data: { reportId: string } }
  | { event: "error"; data: { message: string } }
  | { event: "status"; data: ToolStatus };
