# RCA Report: Acceptance Rate Drop — March 2025

**Metric:** Acceptance rate
**Breach:** 61.4% (guardrail: min 75%)
**Framework:** Fishbone (Ishikawa)
**Severity:** High
**Author:** Marketplace Analytics Team

## Executive Summary

Between March 12 and March 15, 2025, driver acceptance rate fell from a steady 81% to 61.4%, breaching the 75% guardrail. The primary root cause was a mispriced incentive rollout: a new quest-based bonus program shipped with city-level multipliers inverted, making short urban trips pay less than the previous flat structure. Drivers responded within hours by declining low-fare requests. A secondary contributor was a surge-pricing suppression bug in three metro areas. The incentive config was rolled back on March 15 and acceptance recovered to 79% within 48 hours.

## Metric Trend Analysis

Acceptance rate held between 79% and 83% for the preceding six weeks. The decline began at 14:00 UTC on March 12 — within two hours of the incentive config deploy — and degraded roughly 4-5 percentage points per day, which is the signature of drivers progressively learning the new payout structure rather than an instantaneous platform fault. The 61.4% trough represents an 18% relative decline from baseline. Historical healthy range for this marketplace is 76-85%.

## Root Cause Analysis

Applying the Fishbone framework across the four cause categories:

### People
- **Driver earnings sensitivity (High likelihood):** Forum and in-app feedback showed drivers explicitly declining trips under 2 miles because the new quest structure paid ~22% less on short trips. Behavior propagated quickly through driver communities.
- **Rider demand shift (Low likelihood):** Demand mix was stable week-over-week; no unusual concentration of short trips.

### Process
- **Incentive program misconfiguration (High likelihood — ROOT CAUSE):** The quest multiplier table was deployed with city-tier values inverted (tier-1 cities received tier-3 multipliers). Short-trip payouts dropped 18-24% in the largest markets.
- **Surge suppression interaction (Medium likelihood):** A concurrent experiment capped surge at 1.4x in three metros, further reducing per-trip earnings during peak hours.

### Platform
- **Dispatch latency (Low likelihood):** P95 dispatch-to-offer latency was flat; no deploy incidents in the matching service.
- **App crash rate (Low likelihood):** Driver app crash-free sessions remained at 99.6%.

### External
- **Weather (Low likelihood):** No major weather events in affected markets during the window.
- **Competitor incentives (Medium likelihood):** A competitor ran a driver sign-on bonus in two of the affected metros, which may have amplified supply willingness to decline.

**Most likely root cause:** the inverted city-tier multiplier in the March 12 incentive config deploy, compounded by the surge cap experiment.

## Contributing Factors

1. The incentive config pipeline had no automated sanity check comparing projected per-trip payout against the previous structure.
2. The surge cap experiment and the quest rollout were not cross-reviewed; each team was unaware of the other's earnings impact.
3. Driver-facing payout preview in the app made the reduced earnings immediately visible, accelerating behavioral response.

## Recommended Actions

1. **Immediate:** Roll back the quest multiplier table to the pre-March-12 configuration. *(Owner: Incentives Eng — done March 15)*
2. **Immediate:** Pause the surge cap experiment in affected metros. *(Owner: Pricing Team)*
3. **Short-term:** Add a pre-deploy simulation gate that blocks incentive configs projecting >5% per-trip earnings decline in any market. *(Owner: Incentives Eng, 2 weeks)*
4. **Short-term:** Establish a shared earnings-impact calendar so pricing and incentive experiments are mutually visible. *(Owner: Marketplace PM, 2 weeks)*
5. **Long-term:** Build an acceptance-rate early-warning model keyed on config deploys, alerting at 2 percentage points of decline within 6 hours of any earnings-affecting change. *(Owner: Data Science, 1 quarter)*

## Severity Assessment

High severity: an 18% relative decline in acceptance rate directly degrades rider ETA and completion rate, and sustained low acceptance risks driver churn from reduced utilization earnings. The breach persisted for three days across all tier-1 markets before rollback. It did not reach critical because completion rate remained above its own guardrail and the cause was fully reversible by config rollback.

Severity: high
