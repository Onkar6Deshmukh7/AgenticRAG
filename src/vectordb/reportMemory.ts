/**
 * reportMemory.ts — closes the RAG loop.
 *
 * When the tool generates a report, we don't just store it in Postgres — we
 * also chunk it, embed it, and upsert it into Pinecone. That turns every
 * report into future RAG memory: the next time a similar metric breaches, the
 * context gatherer retrieves these real past incidents alongside the seed
 * samples, so the tool genuinely learns from its own history.
 *
 * Vector ids are deterministic (`report:{reportId}#{n}`) and returned to the
 * caller, which stores them on the Neon row so a later delete can purge the
 * exact vectors (see deleteReport / deleteVectors).
 */
import { embedText } from "./embeddings.js";
import { upsertChunks, type ChunkVector } from "./pinecone.js";
import type { Framework } from "../config.js";

/**
 * Split a generated report into chunks along its `##` section headers, keeping
 * each header with its body. Oversized sections are further split on paragraph
 * boundaries at ~2000 chars (~400-500 tokens) — mirrors the seed ingestion in
 * ingest.ts so seed and generated chunks are shaped consistently.
 */
function chunkBySection(markdown: string): { section: string; text: string }[] {
  const chunks: { section: string; text: string }[] = [];
  const sections = markdown.split(/\n(?=## )/);
  const MAX_CHARS = 2000;

  for (const section of sections) {
    const headerMatch = section.match(/^#{1,3} (.+)/);
    const sectionName = (headerMatch?.[1] ?? "preamble")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");

    if (section.length <= MAX_CHARS) {
      if (section.trim()) chunks.push({ section: sectionName, text: section.trim() });
    } else {
      let current = "";
      for (const paragraph of section.split(/\n\n+/)) {
        if (current.length + paragraph.length > MAX_CHARS && current) {
          chunks.push({ section: sectionName, text: current.trim() });
          current = "";
        }
        current += paragraph + "\n\n";
      }
      if (current.trim()) chunks.push({ section: sectionName, text: current.trim() });
    }
  }
  return chunks;
}

/**
 * Embed + upsert a generated report into Pinecone. Returns the list of vector
 * ids created (to be stored on the Neon row). Throws on failure — the caller
 * treats ingestion as best-effort and must not let a failure break report
 * generation.
 */
export async function ingestGeneratedReport(
  reportId: string,
  markdown: string,
  framework: Framework,
  metricDisplayName: string
): Promise<string[]> {
  const chunks = chunkBySection(markdown);
  const vectors: ChunkVector[] = [];
  const ids: string[] = [];

  // Embed sequentially — free-tier friendly, and reports are small (~6 chunks).
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const id = `report:${reportId}#${i}`;
    const values = await embedText(chunk.text);
    vectors.push({
      id,
      values,
      metadata: {
        source: `past incident: ${metricDisplayName}`,
        section: chunk.section,
        framework,
        text: chunk.text,
        reportId,
        kind: "generated",
      },
    });
    ids.push(id);
  }

  await upsertChunks(vectors);
  return ids;
}
