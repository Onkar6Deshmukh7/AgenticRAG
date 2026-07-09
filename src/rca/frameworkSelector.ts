/**
 * frameworkSelector.ts — maps a metric to its RCA framework.
 *
 * This is intentionally a deterministic lookup, not an LLM decision: the
 * right analytical framework for a metric is a product-analytics judgment
 * that we encode once in the METRIC_CATALOG. Keeping it deterministic makes
 * the pipeline predictable and saves an LLM call per breach.
 *
 * Frameworks:
 *   - MECE: volume/financial metrics that decompose into sub-drivers
 *   - Fishbone: operational metrics with people/process/platform/external causes
 *   - Funnel Degradation: conversion-style metrics with sequential stages
 */
import { METRIC_CATALOG, type Framework } from "../config.js";

export function selectFramework(metricKey: string): Framework {
  const metric = METRIC_CATALOG[metricKey];
  if (!metric) {
    // Unknown metric — Fishbone is the most general-purpose fallback.
    console.warn(`[framework] Unknown metric "${metricKey}", defaulting to fishbone.`);
    return "fishbone";
  }
  return metric.framework;
}

/**
 * Framework-specific analysis instructions injected into the LLM prompt.
 * `{metric}` is replaced with the metric's display name by promptBuilder.
 */
export const FRAMEWORK_INSTRUCTIONS: Record<Framework, string> = {
  mece: `Use the MECE (Mutually Exclusive, Collectively Exhaustive) decomposition framework:
Decompose {metric} into mutually exclusive, collectively exhaustive sub-drivers.
For each sub-driver, state whether it likely moved, estimate direction and magnitude, and assess whether it explains the overall drop.
Identify the 1-2 sub-drivers most likely responsible.
Present as a tree: Level 1 splits, then Level 2 where helpful.`,

  fishbone: `Use the Fishbone (Ishikawa) framework. Organize potential root causes into these categories:
- People (driver behavior, rider behavior, workforce changes)
- Process (matching algorithm, pricing, surge logic, incentive programs)
- Platform (app bugs, infrastructure issues, API latency, deployment incidents)
- External (weather, competitor activity, regulation, seasonal patterns)
For each category, list 2-3 plausible causes and assess likelihood (High/Medium/Low).
Identify the single most likely root cause.`,

  funnel_degradation: `Use the Funnel Degradation framework. Map {metric} to its conversion funnel stages:
- request_completion_rate: Request → Driver Match → Driver Acceptance → Pickup → Trip Completion
- take_rate: Gross Bookings → Platform Fees → Driver Pay → Incentives/Promotions → Net Revenue
For each stage, describe what a degradation would look like and assess whether this stage likely caused the overall metric drop.
Identify the stage with the largest inferred degradation.`,
};
