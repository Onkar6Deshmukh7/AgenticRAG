/**
 * reportGenerator.ts — orchestrates the full RCA pipeline for one breach:
 *
 *   gather context (RAG + web) → build prompt → call LLM → save to Neon
 *
 * LLM strategy (all through the `openai` package, baseURL swapped):
 *   1. Groq (llama-3.3-70b-versatile) — primary: fast and generous free tier.
 *   2. Gemini (gemini-2.5-flash-lite) — fallback when Groq is rate-limited
 *      or errors.
 *   3. Both exhausted → wait for a rate-limit slot (queued), then retry.
 *   4. Still nothing → save a "generation_failed" report so the breach is
 *      recorded, and surface the error to the UI.
 *
 * Every call is gated by the RateLimiter — see rateLimiter.ts for why.
 */
import OpenAI from "openai";
import { CONFIG, ENV } from "../config.js";
import { RateLimiter } from "../rateLimiter/rateLimiter.js";
import { gatherContext } from "./contextGatherer.js";
import { buildUserPrompt, extractSeverity, SYSTEM_PROMPT } from "./promptBuilder.js";
import { saveReport } from "../db/neon.js";
import type { BreachEvent, ReportRecord } from "../types.js";

// ---------------------------------------------------------------------------
// Rate limiters — one per provider, shared across the whole process.
// ---------------------------------------------------------------------------
export const rateLimiters = {
  groq: new RateLimiter(CONFIG.RATE_LIMITS.groq),
  gemini: new RateLimiter(CONFIG.RATE_LIMITS.gemini),
};

// Lazily-created API clients (avoid throwing at import time if a key is missing).
let groqClient: OpenAI | null = null;
let geminiClient: OpenAI | null = null;

function getGroq(): OpenAI | null {
  if (!ENV.GROQ_API_KEY) return null;
  if (!groqClient) {
    groqClient = new OpenAI({ apiKey: ENV.GROQ_API_KEY, baseURL: CONFIG.GROQ_BASE_URL });
  }
  return groqClient;
}

function getGemini(): OpenAI | null {
  if (!ENV.GEMINI_API_KEY) return null;
  if (!geminiClient) {
    geminiClient = new OpenAI({ apiKey: ENV.GEMINI_API_KEY, baseURL: CONFIG.GEMINI_BASE_URL });
  }
  return geminiClient;
}

/** One chat-completion call against a specific provider. */
async function callProvider(
  provider: "groq" | "gemini",
  userPrompt: string
): Promise<string> {
  const client = provider === "groq" ? getGroq() : getGemini();
  if (!client) throw new Error(`${provider} API key not configured`);

  const model = provider === "groq" ? CONFIG.LLM_PRIMARY_MODEL : CONFIG.LLM_FALLBACK_MODEL;

  rateLimiters[provider].recordRequest(); // count it BEFORE the call — a failed call still consumed quota
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.4, // low-ish: we want rigor, not creativity
    max_tokens: 4000,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error(`${provider} returned an empty response`);
  return content;
}

/**
 * Try Groq → Gemini → queue-and-retry. Returns the markdown and which
 * provider produced it. Throws only when every avenue is exhausted.
 */
async function generateWithFallback(
  userPrompt: string,
  onQueued: () => void
): Promise<{ markdown: string; provider: "groq" | "gemini" }> {
  // Attempt 1: Groq, if configured and within limits.
  if (getGroq() && rateLimiters.groq.canMakeRequest()) {
    try {
      return { markdown: await callProvider("groq", userPrompt), provider: "groq" };
    } catch (err) {
      console.warn("[llm] Groq failed, falling back to Gemini:", err instanceof Error ? err.message : err);
    }
  } else {
    console.warn("[llm] Groq unavailable or rate-limited — trying Gemini.");
  }

  // Attempt 2: Gemini.
  if (getGemini() && rateLimiters.gemini.canMakeRequest()) {
    try {
      return { markdown: await callProvider("gemini", userPrompt), provider: "gemini" };
    } catch (err) {
      console.warn("[llm] Gemini failed:", err instanceof Error ? err.message : err);
    }
  }

  // Attempt 3: both exhausted — queue and wait for a per-minute slot to open.
  onQueued();
  console.warn("[llm] Both providers exhausted — waiting for a rate-limit slot...");
  if (getGroq() && (await rateLimiters.groq.waitForSlot())) {
    return { markdown: await callProvider("groq", userPrompt), provider: "groq" };
  }
  if (getGemini() && (await rateLimiters.gemini.waitForSlot())) {
    return { markdown: await callProvider("gemini", userPrompt), provider: "gemini" };
  }

  throw new Error("Both LLM providers are rate-limited or failing. Report generation aborted.");
}

/**
 * Public entry point: run the entire pipeline for one breach event.
 * `onProgress` streams step updates to the browser via SSE.
 * Always resolves with a saved report — on total failure, that report has
 * severity "generation_failed" so the breach is still on record.
 */
export async function generateReport(
  breach: BreachEvent,
  onProgress: (
    step: "vector_search" | "web_search" | "llm_call",
    message: string
  ) => void
): Promise<ReportRecord> {
  // Steps 1-2: gather RAG + web context (reports its own progress).
  const context = await gatherContext(breach, onProgress);

  // Step 3: build the prompt and call the LLM.
  onProgress("llm_call", "Generating RCA report...");
  const userPrompt = buildUserPrompt(breach, context);

  try {
    const { markdown, provider } = await generateWithFallback(userPrompt, () =>
      onProgress("llm_call", "Rate limit reached — report will be generated when a slot opens...")
    );

    return await saveReport({
      metricKey: breach.metricKey,
      metricDisplayName: breach.displayName,
      breachValue: breach.value,
      guardrailValue: breach.threshold,
      guardrailDirection: breach.direction,
      framework: breach.framework,
      reportMarkdown: markdown,
      severity: extractSeverity(markdown),
      llmProvider: provider,
    });
  } catch (err) {
    // Total failure: record the breach anyway so it isn't silently lost.
    const message = err instanceof Error ? err.message : String(err);
    console.error("[llm] Report generation failed:", message);
    return await saveReport({
      metricKey: breach.metricKey,
      metricDisplayName: breach.displayName,
      breachValue: breach.value,
      guardrailValue: breach.threshold,
      guardrailDirection: breach.direction,
      framework: breach.framework,
      reportMarkdown: `# Report generation failed\n\nA guardrail breach was detected for **${breach.displayName}** (value: ${breach.value}, guardrail: ${breach.direction} ${breach.threshold}), but the RCA report could not be generated.\n\n**Error:** ${message}\n\nYou can retry once LLM quota is available.`,
      severity: "generation_failed",
      llmProvider: "none",
    });
  }
}
