/**
 * rateLimiter.ts — in-memory token-bucket style rate limiter per LLM provider.
 *
 * Why this exists: both Groq and Gemini are used on their free tiers. A bug
 * (e.g. a runaway polling loop) could burn the entire daily quota in minutes.
 * Every LLM call MUST pass through this limiter first.
 *
 * Tracking is simple counting, not a literal token bucket with refill rates:
 *   - a per-minute counter that resets every 60 seconds
 *   - a per-day counter that resets at midnight UTC
 * Both must have headroom for a request to proceed.
 */

export interface RateLimiterConfig {
  maxRequestsPerDay: number;
  maxRequestsPerMinute: number;
}

export interface RateLimiterUsage {
  dailyUsed: number;
  dailyLimit: number;
  minuteUsed: number;
  minuteLimit: number;
}

export class RateLimiter {
  private dailyCount = 0;
  private minuteCount = 0;
  private currentDay: string; // "YYYY-MM-DD" in UTC — change of day resets the counter
  private minuteWindowStart: number; // epoch ms of the current 60s window

  constructor(private readonly config: RateLimiterConfig) {
    this.currentDay = new Date().toISOString().slice(0, 10);
    this.minuteWindowStart = Date.now();
  }

  /** Roll the counters forward if their windows have expired. */
  private refreshWindows(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.currentDay) {
      this.currentDay = today;
      this.dailyCount = 0;
    }
    if (Date.now() - this.minuteWindowStart >= 60_000) {
      this.minuteWindowStart = Date.now();
      this.minuteCount = 0;
    }
  }

  /** True if a request can be made right now without breaching either limit. */
  canMakeRequest(): boolean {
    this.refreshWindows();
    return (
      this.dailyCount < this.config.maxRequestsPerDay &&
      this.minuteCount < this.config.maxRequestsPerMinute
    );
  }

  /** Record that a request was actually sent. Call right before the API call. */
  recordRequest(): void {
    this.refreshWindows();
    this.dailyCount++;
    this.minuteCount++;
  }

  /**
   * Wait until a slot opens up (used for queuing when both providers are
   * exhausted). Checks once per second; gives up after `timeoutMs` so a
   * fully-spent daily quota doesn't hang the pipeline forever.
   */
  async waitForSlot(timeoutMs = 5 * 60_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.canMakeRequest()) return true;
      // If the DAILY quota is spent, waiting minutes won't help — bail early.
      this.refreshWindows();
      if (this.dailyCount >= this.config.maxRequestsPerDay) return false;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    return false;
  }

  /** Usage snapshot for the GET /api/rate-limits endpoint. */
  getUsage(): RateLimiterUsage {
    this.refreshWindows();
    return {
      dailyUsed: this.dailyCount,
      dailyLimit: this.config.maxRequestsPerDay,
      minuteUsed: this.minuteCount,
      minuteLimit: this.config.maxRequestsPerMinute,
    };
  }
}
