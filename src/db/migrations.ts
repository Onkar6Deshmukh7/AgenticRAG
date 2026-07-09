/**
 * migrations.ts — creates the database tables on startup.
 *
 * The schema lives in schema.sql (plain SQL, easy to read in interviews).
 * Every statement uses IF NOT EXISTS, so running this repeatedly is safe.
 *
 * Runnable two ways:
 *   1. Called from src/index.ts on every startup.
 *   2. Directly via `npm run migrate` (the import.meta check at the bottom).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { getSqlClient } from "./neon.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(): Promise<boolean> {
  const sql = getSqlClient();
  if (!sql) {
    console.warn("[db] DATABASE_URL not set — skipping migrations (in-memory storage will be used).");
    return false;
  }

  // schema.sql sits next to this file. When compiled to dist/ the .sql file
  // isn't copied by tsc, so we also try the src/ location as a fallback.
  let schema: string;
  try {
    schema = readFileSync(join(__dirname, "schema.sql"), "utf-8");
  } catch {
    schema = readFileSync(join(__dirname, "..", "..", "src", "db", "schema.sql"), "utf-8");
  }

  // Strip full-line comments BEFORE splitting on semicolons — otherwise a
  // comment sitting above the first statement gets merged into that
  // statement's chunk, and filtering "starts with --" discards the real SQL
  // along with the comment.
  const statements = schema
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  try {
    for (const statement of statements) {
      await sql(statement);
    }
    console.log("[db] Migrations complete — tables ready.");
    return true;
  } catch (err) {
    console.warn("[db] Migration failed — falling back to in-memory storage.", err);
    return false;
  }
}

// Allow `npm run migrate` to execute this file directly.
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  runMigrations().then((ok) => process.exit(ok ? 0 : 1));
}
