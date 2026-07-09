/**
 * ingest.ts — one-time ingestion of sample RCA reports into Pinecone.
 *
 * Run with: npm run ingest
 *
 * Pipeline:
 *   1. Read every .md file in sample-reports/.
 *   2. Chunk each report by its markdown section headers (## ...), so every
 *      chunk is a semantically meaningful unit (~300-500 tokens), not an
 *      arbitrary character slice.
 *   3. Embed each chunk with Google AI Studio (gemini-embedding-001).
 *   4. Upsert into Pinecone with metadata: source file, section slug, and
 *      the RCA framework the report used.
 *
 * Idempotency: if the index already has vectors we skip ingestion entirely,
 * so accidentally running this twice costs nothing.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { embedTexts } from "./embeddings.js";
import { ensureIndex, getVectorCount, upsertChunks, type ChunkVector } from "./pinecone.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_REPORTS_DIR = join(__dirname, "..", "..", "sample-reports");

/** A chunk of a report, before embedding. */
interface ReportChunk {
  source: string;
  section: string;
  framework: string;
  text: string;
}

/**
 * Split a markdown report into chunks along `##` section headers.
 * Each chunk keeps its header so the LLM sees what section it came from.
 * Very long sections are further split on blank-line paragraph boundaries
 * at roughly 2000 characters (~400-500 tokens).
 */
export function chunkReport(source: string, markdown: string): ReportChunk[] {
  // The framework is declared in the report's front matter-style first lines,
  // e.g. "**Framework:** Fishbone (Ishikawa)". Default to "unknown".
  const frameworkMatch = markdown.match(/\*\*Framework:\*\*\s*([^\n]+)/i);
  const frameworkRaw = frameworkMatch?.[1]?.toLowerCase() ?? "unknown";
  const framework = frameworkRaw.includes("fishbone")
    ? "fishbone"
    : frameworkRaw.includes("mece")
      ? "mece"
      : frameworkRaw.includes("funnel")
        ? "funnel_degradation"
        : "unknown";

  const chunks: ReportChunk[] = [];
  // Split on level-2 headers, keeping the header with the section body.
  const sections = markdown.split(/\n(?=## )/);

  for (const section of sections) {
    const headerMatch = section.match(/^## (.+)/);
    const sectionName = (headerMatch?.[1] ?? "preamble")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");

    // Further split oversized sections on paragraph boundaries.
    const MAX_CHARS = 2000;
    if (section.length <= MAX_CHARS) {
      if (section.trim()) chunks.push({ source, section: sectionName, framework, text: section.trim() });
    } else {
      let current = "";
      for (const paragraph of section.split(/\n\n+/)) {
        if (current.length + paragraph.length > MAX_CHARS && current) {
          chunks.push({ source, section: sectionName, framework, text: current.trim() });
          current = "";
        }
        current += paragraph + "\n\n";
      }
      if (current.trim()) chunks.push({ source, section: sectionName, framework, text: current.trim() });
    }
  }
  return chunks;
}

async function main(): Promise<void> {
  console.log("[ingest] Ensuring Pinecone index exists...");
  await ensureIndex();

  const existingVectors = await getVectorCount();
  if (existingVectors > 0) {
    console.log(`[ingest] Vectors already ingested (${existingVectors} found), skipping.`);
    return;
  }

  // 1. Read + chunk all sample reports.
  const files = readdirSync(SAMPLE_REPORTS_DIR).filter((f) => f.endsWith(".md"));
  console.log(`[ingest] Found ${files.length} sample report(s): ${files.join(", ")}`);

  const allChunks: ReportChunk[] = [];
  for (const file of files) {
    const markdown = readFileSync(join(SAMPLE_REPORTS_DIR, file), "utf-8");
    const chunks = chunkReport(file, markdown);
    console.log(`[ingest]   ${file} → ${chunks.length} chunks`);
    allChunks.push(...chunks);
  }

  // 2. Embed every chunk (sequential — free-tier friendly).
  console.log(`[ingest] Embedding ${allChunks.length} chunks via Google AI Studio...`);
  const vectors = await embedTexts(allChunks.map((c) => c.text));

  // 3. Upsert into Pinecone with metadata.
  const records: ChunkVector[] = allChunks.map((chunk, i) => ({
    id: `${chunk.source}#${chunk.section}#${i}`,
    values: vectors[i]!,
    metadata: {
      source: chunk.source,
      section: chunk.section,
      framework: chunk.framework,
      text: chunk.text,
    },
  }));

  console.log("[ingest] Upserting to Pinecone...");
  await upsertChunks(records);
  console.log(`[ingest] Done — ${records.length} vectors ingested.`);
}

main().catch((err) => {
  console.error("[ingest] Failed:", err);
  process.exit(1);
});
