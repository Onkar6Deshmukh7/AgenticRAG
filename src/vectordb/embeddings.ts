/**
 * embeddings.ts — text → vector embeddings via Google AI Studio.
 *
 * Google's Generative Language API exposes an OpenAI-compatible endpoint,
 * so we reuse the `openai` npm package with a swapped baseURL — the same
 * trick used for chat completions in reportGenerator.ts. One API key
 * (GEMINI_API_KEY) covers both embeddings and the fallback LLM.
 *
 * Model: gemini-embedding-001, which outputs 3072-dimensional vectors.
 * The Pinecone index dimension must match (see CONFIG.EMBEDDING_DIMENSIONS).
 */
import OpenAI from "openai";
import { CONFIG, ENV } from "../config.js";

// One client instance, created lazily so importing this module without a key
// doesn't throw.
let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!ENV.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set — embeddings unavailable.");
  }
  if (!client) {
    client = new OpenAI({
      apiKey: ENV.GEMINI_API_KEY,
      baseURL: CONFIG.GEMINI_BASE_URL,
    });
  }
  return client;
}

/** Embed a single piece of text (used for queries at breach time). */
export async function embedText(text: string): Promise<number[]> {
  const response = await getClient().embeddings.create({
    model: CONFIG.EMBEDDING_MODEL,
    input: text,
  });
  const embedding = response.data[0]?.embedding;
  if (!embedding) throw new Error("Embedding API returned no vector.");
  return embedding;
}

/**
 * Embed many texts. Called by the ingestion script. We embed sequentially
 * (not in parallel) to stay well inside the free-tier per-minute limits.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (const text of texts) {
    vectors.push(await embedText(text));
  }
  return vectors;
}
