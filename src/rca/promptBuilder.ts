/**
 * promptBuilder.ts — assembles the full LLM prompt for report generation.
 *
 * Prompt structure (in order):
 *   1. System role: senior product analyst writing an RCA report.
 *   2. The breach facts: metric, value, guardrail, direction, timestamp.
 *   3. Framework instructions (from frameworkSelector) — tells the model
 *      HOW to structure the root-cause section.
 *   4. Retrieved context from past reports (the RAG payload).
 *   5. External web-search context (or a note that it was unavailable).
 *   6. Strict output format: the exact markdown sections the report viewer
 *      expects, plus a severity line we can parse afterwards.
 */
import { FRAMEWORK_DISPLAY_NAMES } from "../config.js";
import { FRAMEWORK_INSTRUCTIONS } from "./frameworkSelector.js";
import type { BreachEvent, GatheredContext } from "../types.js";

export const SYSTEM_PROMPT = `You are a senior product analyst at a ride-hailing platform, known for writing rigorous, evidence-based root cause analysis (RCA) reports. You write in clear, professional prose. You never invent specific data you were not given; when you infer, you label it as a hypothesis. You always follow the requested report structure exactly.`;

export function buildUserPrompt(breach: BreachEvent, context: GatheredContext): string {
  const frameworkName = FRAMEWORK_DISPLAY_NAMES[breach.framework];
  const frameworkInstructions = FRAMEWORK_INSTRUCTIONS[breach.framework].replaceAll(
    "{metric}",
    breach.displayName
  );

  const guardrailDescription =
    breach.direction === "min"
      ? `minimum acceptable value: ${breach.threshold} ${breach.unit} (the metric FELL BELOW this)`
      : `maximum acceptable value: ${breach.threshold} ${breach.unit} (the metric ROSE ABOVE this)`;

  // --- RAG payload: retrieved chunks from past reports -------------------
  const pastReportsSection =
    context.pastReportChunks.length > 0
      ? context.pastReportChunks
          .map((chunk, i) => `--- Retrieved context ${i + 1} ---\n${chunk}`)
          .join("\n\n")
      : "(No past report context available.)";

  // --- External web context ----------------------------------------------
  const webSection = context.webSearchAvailable
    ? context.webResults.length > 0
      ? context.webResults
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   Source: ${r.url}`)
          .join("\n")
      : "(Web search ran but returned no relevant results.)"
    : "Web search unavailable — analyze without external context.";

  return `A metric guardrail has been breached on our ride-hailing platform. Write a complete root cause analysis report.

## Breach details
- Metric: ${breach.displayName} (${breach.metricKey})
- Current value: ${breach.value} ${breach.unit}
- Guardrail: ${guardrailDescription}
- Detected at: ${breach.detectedAt}
- Assigned RCA framework: ${frameworkName}

## Framework instructions
${frameworkInstructions}

## Context from past RCA reports (retrieved via semantic search)
Use these excerpts from previous incident reports to inform your analysis — look for recurring causes, past fixes, and patterns relevant to this metric:

${pastReportsSection}

## External context (web search)
${webSection}

## Required output format
Respond with ONLY the report in markdown, using EXACTLY these level-2 sections in this order:

## Executive Summary
(3-5 sentences: what breached, how badly, most likely cause, recommended immediate action)

## Metric Trend Analysis
(What the breach value means relative to the guardrail; magnitude of the deviation as a percentage; what a healthy range looks like)

## Root Cause Analysis
(Apply the ${frameworkName} framework per the instructions above — this must be the longest, most rigorous section)

## Contributing Factors
(Secondary factors from the past-report context and external context that likely amplified the problem)

## Recommended Actions
(Numbered list: 3-5 concrete actions, each with an owner role and a timeframe — immediate / short-term / long-term)

## Severity Assessment
(One paragraph justifying the severity, then end the section with a single line in exactly this format:)
Severity: <low|medium|high|critical>`;
}

/**
 * Pull the machine-readable severity out of the generated markdown.
 * The prompt asks for a trailing "Severity: <level>" line; if the model
 * didn't comply, default to "medium" rather than failing the pipeline.
 */
export function extractSeverity(markdown: string): string {
  const match = markdown.match(/severity:\s*(low|medium|high|critical)/i);
  return match?.[1]?.toLowerCase() ?? "medium";
}
