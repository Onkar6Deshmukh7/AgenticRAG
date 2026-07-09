-- schema.sql — table definitions for the RCA tool (Neon Postgres).
-- All statements are idempotent (IF NOT EXISTS) so migrations can run on
-- every startup without erroring.

CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_key VARCHAR(50) NOT NULL,
  metric_display_name VARCHAR(100) NOT NULL,
  breach_value NUMERIC NOT NULL,
  guardrail_value NUMERIC NOT NULL,
  guardrail_direction VARCHAR(10) NOT NULL,  -- 'min' or 'max'
  framework VARCHAR(30) NOT NULL,
  report_markdown TEXT NOT NULL,
  severity VARCHAR(20),
  llm_provider VARCHAR(20),                  -- 'groq' or 'gemini'
  generated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS run_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ DEFAULT NOW(),
  stopped_at TIMESTAMPTZ,
  dashboard_url TEXT NOT NULL,
  monitored_metrics JSONB NOT NULL,          -- array of { metric, guardrail }
  total_polls INTEGER DEFAULT 0,
  total_breaches INTEGER DEFAULT 0
);
