/**
 * pinecone.ts — Pinecone client initialization + index management.
 *
 * The index stores chunked sample RCA reports so that, at breach time, the
 * context gatherer can retrieve only the most relevant sections (the "R" in
 * RAG) instead of stuffing whole documents into the LLM prompt.
 */
import { Pinecone, type Index } from "@pinecone-database/pinecone";
import { CONFIG, ENV } from "../config.js";

let pinecone: Pinecone | null = null;

function getPinecone(): Pinecone {
  if (!ENV.PINECONE_API_KEY) {
    throw new Error("PINECONE_API_KEY is not set — vector search unavailable.");
  }
  if (!pinecone) {
    pinecone = new Pinecone({ apiKey: ENV.PINECONE_API_KEY });
  }
  return pinecone;
}

/**
 * Ensure the index exists, creating it if needed (serverless, free tier).
 * Returns a handle to the index. Creation takes ~30-60s the first time, so
 * we poll until the index reports ready.
 */
export async function ensureIndex(): Promise<Index> {
  const pc = getPinecone();
  const existing = await pc.listIndexes();
  const alreadyExists = existing.indexes?.some(
    (idx) => idx.name === CONFIG.PINECONE_INDEX_NAME
  );

  if (!alreadyExists) {
    console.log(`[pinecone] Creating index "${CONFIG.PINECONE_INDEX_NAME}"...`);
    await pc.createIndex({
      name: CONFIG.PINECONE_INDEX_NAME,
      dimension: CONFIG.EMBEDDING_DIMENSIONS,
      metric: "cosine",
      spec: {
        serverless: { cloud: "aws", region: "us-east-1" }, // free-tier region
      },
      waitUntilReady: true,
    });
    console.log("[pinecone] Index created and ready.");
  }

  return pc.index(CONFIG.PINECONE_INDEX_NAME);
}

/** How many vectors the index currently holds (used to skip re-ingestion). */
export async function getVectorCount(): Promise<number> {
  const index = await ensureIndex();
  const stats = await index.describeIndexStats();
  return stats.totalRecordCount ?? 0;
}

/** Upsert embedded chunks with their metadata. */
export interface ChunkVector {
  id: string;
  values: number[];
  metadata: {
    source: string; // e.g. "sample_rca_1.md"
    section: string; // e.g. "root_cause_analysis"
    framework: string; // e.g. "fishbone"
    text: string; // the chunk text itself, returned at query time
  };
}

export async function upsertChunks(chunks: ChunkVector[]): Promise<void> {
  const index = await ensureIndex();
  await index.upsert(chunks);
}

/** Query the index for the top-K most similar chunks to a query vector. */
export async function querySimilar(
  vector: number[],
  topK: number
): Promise<{ text: string; source: string; score: number }[]> {
  const index = await ensureIndex();
  const result = await index.query({
    vector,
    topK,
    includeMetadata: true,
  });
  return (result.matches ?? []).map((match) => ({
    text: String(match.metadata?.text ?? ""),
    source: String(match.metadata?.source ?? "unknown"),
    score: match.score ?? 0,
  }));
}
