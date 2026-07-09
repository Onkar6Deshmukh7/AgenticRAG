/**
 * index.ts — entry point. Boots the Express server that serves:
 *   - the setup page (public/index.html) and report viewer (public/report.html)
 *   - the JSON API + SSE stream (src/server/routes.ts)
 *
 * Startup order:
 *   1. Run DB migrations (idempotent; degrades to in-memory storage on failure).
 *   2. Mount static files + API routes.
 *   3. Listen on CONFIG.TOOL_PORT.
 *
 * The metric watcher does NOT start here — it starts when the user clicks
 * "Initialize tool" in the browser (POST /api/initialize).
 *
 * Global safety nets at the bottom: this is a monitoring tool, so a single
 * unhandled error must never kill the process.
 */
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CONFIG } from "./config.js";
import { runMigrations } from "./db/migrations.js";
import { router } from "./server/routes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// public/ sits at the project root, one level above src/ (or dist/).
const PUBLIC_DIR = join(__dirname, "..", "public");

async function main(): Promise<void> {
  // 1. Ensure the Neon tables exist (safe to run every startup).
  await runMigrations();

  // 2. Build the Express app.
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(PUBLIC_DIR));
  app.use(router);

  // 3. Go live.
  app.listen(CONFIG.TOOL_PORT, () => {
    console.log("");
    console.log("  ┌─────────────────────────────────────────────────┐");
    console.log("  │  Agentic RAG RCA Tool                           │");
    console.log(`  │  Setup page:  http://localhost:${CONFIG.TOOL_PORT}             │`);
    console.log("  │  Select metrics → set guardrails → Initialize   │");
    console.log("  └─────────────────────────────────────────────────┘");
    console.log("");
  });
}

// ---------------------------------------------------------------------------
// Never crash on a single failure — log it and keep monitoring.
// ---------------------------------------------------------------------------
process.on("unhandledRejection", (reason) => {
  console.error("[fatal-guard] Unhandled promise rejection (process kept alive):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[fatal-guard] Uncaught exception (process kept alive):", err);
});

main().catch((err) => {
  // Startup itself failing IS fatal — nothing to keep alive yet.
  console.error("Failed to start:", err);
  process.exit(1);
});
