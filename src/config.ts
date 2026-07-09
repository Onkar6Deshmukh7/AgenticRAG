/**
 * config.ts — single source of truth for all configuration.
 *
 * Everything the tool needs to know lives here:
 *   - Environment variables (loaded once via dotenv)
 *   - Tunable defaults (port, poll interval, model names, rate limits)
 *   - The metric catalog: every metric the dashboard exposes, its display
 *     name, unit, which RCA framework applies to it, whether the guardrail
 *     is a minimum or a maximum, and a sensible default threshold.
 */
import "dotenv/config";

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------
// We read them all in one place so the rest of the codebase never touches
// process.env directly. Missing optional values become empty strings and the
// feature that needs them degrades gracefully (see error-handling rules).
export const ENV = {
  DASHBOARD_URL: process.env.DASHBOARD_URL ?? "",
  GROQ_API_KEY: process.env.GROQ_API_KEY ?? "",
  GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? "",
  PINECONE_API_KEY: process.env.PINECONE_API_KEY ?? "",
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  SMTP_HOST: process.env.SMTP_HOST ?? "smtp.gmail.com",
  SMTP_PORT: Number(process.env.SMTP_PORT ?? 587),
  SMTP_USER: process.env.SMTP_USER ?? "",
  SMTP_PASS: process.env.SMTP_PASS ?? "",
  REPORT_EMAIL_TO: process.env.REPORT_EMAIL_TO ?? "",
};

// ---------------------------------------------------------------------------
// General tool configuration
// ---------------------------------------------------------------------------
export const CONFIG = {
  TOOL_PORT: 3000,
  POLL_INTERVAL_MS: 10_000, // matches the dashboard's 10-second period
  DISCONNECTED_RETRY_MS: 30_000, // slower retry while the dashboard is unreachable
  PINECONE_INDEX_NAME: "rca-reports",
  EMBEDDING_MODEL: "gemini-embedding-001", // Google AI Studio free embedding model
  EMBEDDING_DIMENSIONS: 3072, // gemini-embedding-001 output size
  LLM_PRIMARY_MODEL: "llama-3.3-70b-versatile", // Groq
  LLM_FALLBACK_MODEL: "gemini-2.5-flash-lite", // Google AI Studio
  // Both providers speak the OpenAI wire protocol, so we use the `openai`
  // npm package for both and just swap the baseURL.
  GROQ_BASE_URL: "https://api.groq.com/openai/v1",
  GEMINI_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai/",
  RATE_LIMITS: {
    groq: { maxRequestsPerDay: 800, maxRequestsPerMinute: 25 }, // ~80% of Groq's free tier
    gemini: { maxRequestsPerDay: 1200, maxRequestsPerMinute: 8 }, // ~80% of Gemini's free tier
  },
  VECTOR_TOP_K: 5, // how many chunks to retrieve from Pinecone per breach
  WEB_SEARCH_RESULTS: 5, // how many DuckDuckGo results to include
} as const;

// ---------------------------------------------------------------------------
// RCA frameworks
// ---------------------------------------------------------------------------
export type Framework = "mece" | "fishbone" | "funnel_degradation";

export const FRAMEWORK_DISPLAY_NAMES: Record<Framework, string> = {
  mece: "MECE Decomposition",
  fishbone: "Fishbone (Ishikawa)",
  funnel_degradation: "Funnel Degradation",
};

// ---------------------------------------------------------------------------
// Metric catalog
// ---------------------------------------------------------------------------
// `direction` tells the watcher which way a breach goes:
//   - "min": breach when value drops BELOW the threshold (most metrics)
//   - "max": breach when value rises ABOVE the threshold (only ETA — a
//            longer pickup time is worse)
// `defaultGuardrail` pre-fills the setup UI; the user can override it.
export interface MetricDefinition {
  displayName: string;
  unit: string;
  framework: Framework;
  direction: "min" | "max";
  defaultGuardrail: number;
}

export const METRIC_CATALOG: Record<string, MetricDefinition> = {
  mapc: {
    displayName: "Monthly Active Platform Consumers (MAPCs)",
    unit: "count",
    framework: "mece",
    direction: "min",
    defaultGuardrail: 120_000_000,
  },
  total_trips: {
    displayName: "Total Trips",
    unit: "count",
    framework: "mece",
    direction: "min",
    defaultGuardrail: 2_500_000_000,
  },
  gross_bookings: {
    displayName: "Total Gross Bookings",
    unit: "USD",
    framework: "mece",
    direction: "min",
    defaultGuardrail: 35_000_000_000,
  },
  take_rate: {
    displayName: "Total Take Rate",
    unit: "%",
    framework: "funnel_degradation",
    direction: "min",
    defaultGuardrail: 25,
  },
  adj_ebitda: {
    displayName: "Adjusted EBITDA",
    unit: "USD",
    framework: "mece",
    direction: "min",
    defaultGuardrail: 1_500_000_000,
  },
  eta: {
    displayName: "ETA (average pickup time)",
    unit: "minutes",
    framework: "fishbone",
    direction: "max", // higher ETA = worse, so the guardrail is a ceiling
    defaultGuardrail: 5,
  },
  request_completion_rate: {
    displayName: "Request-to-completion rate",
    unit: "%",
    framework: "funnel_degradation",
    direction: "min",
    defaultGuardrail: 90,
  },
  acceptance_rate: {
    displayName: "Acceptance rate",
    unit: "%",
    framework: "fishbone",
    direction: "min",
    defaultGuardrail: 75,
  },
  driver_utilization: {
    displayName: "Driver utilization rate",
    unit: "%",
    framework: "fishbone",
    direction: "min",
    defaultGuardrail: 60,
  },
  coverage: {
    displayName: "Coverage",
    unit: "%",
    framework: "fishbone",
    direction: "min",
    defaultGuardrail: 95,
  },
};

export type MetricKey = keyof typeof METRIC_CATALOG;
