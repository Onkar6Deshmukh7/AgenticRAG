# RCA Report: Gross Bookings Decline — November 2024

**Metric:** Total Gross Bookings
**Breach:** $31.2B annualized run-rate (guardrail: min $35B)
**Framework:** MECE Decomposition
**Severity:** Critical
**Author:** Finance Analytics & Marketplace Team

## Executive Summary

Total gross bookings run-rate declined 11% from $35.1B to $31.2B over the November 4-18, 2024 window, breaching the $35B guardrail. MECE decomposition isolated the decline almost entirely to the trips-volume branch rather than average booking value: monthly active consumers were flat while trips-per-consumer fell 9%, concentrated in commuter hours in North American metros. The dominant driver was a fare increase experiment (+8% base fare in 14 markets) that overshot the price elasticity assumption, suppressing trip frequency among high-frequency commuters. A secondary driver was reduced airport trip volume from a holiday-timing effect. The fare experiment was rolled back November 19.

## Metric Trend Analysis

Gross bookings run-rate is normally stable within ±3% week-over-week. The 11% decline over two weeks is a four-sigma event for this metric. The decline tracked the fare experiment's staged rollout almost market-by-market: each market's bookings began declining 3-5 days after its fare change, consistent with riders exhausting stored value and habitual bookings before adjusting behavior. Healthy range at current scale: $34.5B-$37B annualized.

## Root Cause Analysis

MECE decomposition of gross bookings:

**Gross Bookings = MAPCs × Trips per MAPC × Average Booking Value**

### Level 1 split

- **MAPCs (flat, -0.4%):** Consumer base stable. Not a driver of the decline.
- **Trips per MAPC (-9.1%):** THE dominant driver. Explains roughly 82% of the total bookings decline.
- **Average Booking Value (+1.8% gross, but -2.1% net of mix):** Base fares rose with the experiment, but trip mix shifted away from long airport trips, netting slightly negative. Explains the remaining ~18%.

### Level 2: decomposing Trips per MAPC

- **Commuter-hour trips (-16%):** Weekday 7-9am and 5-7pm trips fell sharply in the 14 fare-experiment markets, and only in those markets. High-frequency commuters are the most price-elastic segment; the +8% fare crossed their substitution threshold to transit and carpooling.
- **Leisure/weekend trips (-3%):** Mild decline consistent with normal seasonal cooling.
- **Airport trips (-7%):** Thanksgiving fell unusually late in 2024, shifting holiday travel bookings outside the measurement window. Calendar artifact, not organic loss.

### Level 2: decomposing Average Booking Value

- **Base fare (+8% in experiment markets):** As designed.
- **Trip mix (-4%):** Fewer long airport trips reduced average distance per trip.
- **Surge contribution (flat):** No change.

**Most likely root causes (1-2):** (1) The +8% base fare experiment suppressing commuter trip frequency — the elasticity model used leisure-rider data and underestimated commuter sensitivity by roughly 3x. (2) Holiday calendar timing artifact on airport volume — real but self-correcting.

## Contributing Factors

1. The elasticity model behind the fare experiment was trained on 2022 leisure-trip data and never segmented by rider frequency.
2. The experiment shipped to 14 markets simultaneously instead of the standard 3-market canary, multiplying the blast radius.
3. Bookings dashboards aggregated daily totals, masking the commuter-hour concentration for the first week.

## Recommended Actions

1. **Immediate:** Roll back the fare increase in all 14 experiment markets. *(Owner: Pricing Team — done November 19)*
2. **Immediate:** Publish corrected bookings guidance internally reflecting the holiday calendar shift. *(Owner: Finance Analytics)*
3. **Short-term:** Rebuild the price elasticity model with rider-frequency segmentation before any new fare experiments. *(Owner: Data Science, 4 weeks)*
4. **Short-term:** Enforce 3-market canary policy for all pricing changes via experiment-platform guardrails. *(Owner: Experimentation Platform, 3 weeks)*
5. **Long-term:** Add hour-of-day cohort views to the bookings dashboard so segment-concentrated declines surface within 48 hours. *(Owner: Analytics Eng, 1 quarter)*

## Severity Assessment

Critical severity: gross bookings is the company's headline top-line metric, the breach magnitude (11%) was the largest in eight quarters, and the decline was compounding while the experiment remained live. Revenue impact of the two-week window is estimated at $140M in bookings. The rollback restored trajectory within one week, but the elasticity-model gap could have recurred in any future pricing change, warranting the highest severity.

Severity: critical
