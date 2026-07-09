# RCA Report: Request-to-Completion Rate Drop — July 2025

**Metric:** Request-to-completion rate
**Breach:** 83.7% (guardrail: min 90%)
**Framework:** Funnel Degradation
**Severity:** High
**Author:** Marketplace Reliability Team

## Executive Summary

On July 8, 2025, the request-to-completion rate dropped from a 92% baseline to 83.7% within six hours, breaching the 90% guardrail. Funnel analysis located the degradation almost entirely at the Driver Match stage: a deploy of the matching service introduced a geo-index regression that silently excluded drivers near market boundary polygons, cutting effective matchable supply by ~12% in affected zones. Riders in those zones saw "no drivers available" errors and cancelled. The deploy was reverted at 21:40 UTC the same day and completion recovered to 91.5% within two hours — an unusually fast recovery that itself confirmed a platform (not behavioral) cause.

## Metric Trend Analysis

Request-to-completion normally varies between 90.5% and 93.5% intraday. The July 8 drop was a step function, not a drift: 92.1% at 14:00 UTC, 84.9% by 17:00, bottoming at 83.7%. Step-function degradation with a sharp onset is the classic signature of a deploy or infrastructure event rather than gradual marketplace imbalance. The 8.4-point drop equals roughly 310,000 failed or cancelled requests over the incident window.

## Root Cause Analysis

Funnel stages for request_completion_rate: **Request → Driver Match → Driver Acceptance → Pickup → Trip Completion**

### Stage 1: Request (healthy)
Request volume was normal (+1% vs. trailing seven-day average). No client-side errors preventing request creation. Not the degraded stage.

### Stage 2: Driver Match (DEGRADED — root cause stage)
Match success rate fell from 97.8% to 88.1%. The 15:52 UTC deploy of matching-service v2.14 replaced the driver geo-index with an R-tree implementation whose polygon-boundary handling excluded drivers whose last ping fell within 150m of a market boundary — roughly 12% of online drivers in dense multi-market regions. "No driver found" responses tripled. Internal supply dashboards still showed those drivers as online, which delayed diagnosis by ~3 hours.

### Stage 3: Driver Acceptance (healthy)
Acceptance rate among successfully-matched offers was flat at 80-81%, confirming drivers who received offers behaved normally.

### Stage 4: Pickup (mildly degraded, downstream effect)
Cancellation-before-pickup rose 1.9 points, but concentrated in re-requests after failed matches — a downstream symptom of stage 2, not an independent degradation.

### Stage 5: Trip Completion (healthy)
Started trips completed at the normal 98.9% rate.

**Stage with the largest inferred degradation: Driver Match**, explaining an estimated 85-90% of the overall completion-rate drop.

## Contributing Factors

1. The geo-index change shipped without a shadow-traffic comparison against the old index, which would have caught the boundary exclusion immediately.
2. Supply-health dashboards counted drivers as "online" from heartbeat pings, not from matchability, hiding the effective supply loss.
3. The incident began during a shift-change trough in on-call coverage, adding ~40 minutes to time-to-detection.

## Recommended Actions

1. **Immediate:** Revert matching-service to v2.13. *(Owner: Matching Eng — done July 8, 21:40 UTC)*
2. **Short-term:** Add a "matchable supply" metric (drivers the index can actually return) to supply dashboards, alerting on >3% divergence from online count. *(Owner: Marketplace Observability, 2 weeks)*
3. **Short-term:** Require shadow-traffic parity testing (old vs. new index agreement >99.5%) for any geo-index change. *(Owner: Matching Eng, 3 weeks)*
4. **Long-term:** Automated canary analysis on completion rate per deploy, with auto-rollback on 2-point drop within 30 minutes. *(Owner: Deploy Platform, 1 quarter)*

## Severity Assessment

High severity: the breach directly failed ~310,000 rider requests, degraded ETA and acceptance metrics downstream, and eroded rider trust in affected zones (measured re-open rate fell 4% for the following week). It stops short of critical because time-to-mitigation was under seven hours, the cause was a single reversible deploy, and no data integrity or safety impact occurred.

Severity: high
