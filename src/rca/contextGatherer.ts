/**
 * contextGatherer.ts — assembles the context the LLM needs to write a good
 * RCA report. This is the "agentic RAG" heart of the tool. Two sources:
 *
 *   1. INTERNAL: semantic search over past RCA reports in Pinecone.
 *      We embed a query describing the breach and retrieve only the most
 *      relevant chunks — instead of dumping whole documents into the prompt.
 *      If Pinecone (or embedding) fails, we fall back to reading the sample
 *      reports straight from disk so the pipeline never stalls.
 *
 *   2. EXTERNAL: a DuckDuckGo web search for outside factors (weather,
 *      competitor moves, regulation, outages). No API key required.
 *      If it fails, we proceed without it and say so in the prompt.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { search, SafeSearchType } from "duck-duck-scrape";
import { CONFIG, FRAMEWORK_DISPLAY_NAMES } from "../config.js";
import { embedText } from "../vectordb/embeddings.js";
import { querySimilar } from "../vectordb/pinecone.js";
import type { BreachEvent, GatheredContext, WebSearchResult } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_REPORTS_DIR = join(__dirname, "..", "..", "sample-reports");

/**
 * Step 1 of the pipeline: retrieve relevant chunks from past reports.
 * Query string mirrors how the chunks were written, e.g.
 * "Acceptance rate root cause analysis Fishbone (Ishikawa)".
 */
async function retrievePastReportContext(
  breach: BreachEvent
): Promise<Pick<GatheredContext, "pastReportChunks" | "retrievalSource">> {
  const query = `${breach.displayName} root cause analysis ${FRAMEWORK_DISPLAY_NAMES[breach.framework]}`;

  try {
    const queryVector = await embedText(query);
    const matches = await querySimilar(queryVector, CONFIG.VECTOR_TOP_K);
    if (matches.length > 0) {
      console.log(
        `[context] Pinecone returned ${matches.length} chunks (top score: ${matches[0]!.score.toFixed(3)})`
      );
      return {
        pastReportChunks: matches.map((m) => `(from ${m.source})\n${m.text}`),
        retrievalSource: "pinecone",
      };
    }
    // Index empty (ingest not run yet) — fall through to disk.
    console.warn("[context] Pinecone index empty — falling back to disk.");
  } catch (err) {
    console.warn(
      "[context] Vector search failed — falling back to reading sample reports from disk.",
      err instanceof Error ? err.message : err
    );
  }

  // Disk fallback: include the full text of every sample report.
  try {
    const files = readdirSync(SAMPLE_REPORTS_DIR).filter((f) => f.endsWith(".md"));
    const chunks = files.map(
      (f) => `(from ${f}, full text — vector search unavailable)\n${readFileSync(join(SAMPLE_REPORTS_DIR, f), "utf-8")}`
    );
    return { pastReportChunks: chunks, retrievalSource: "disk_fallback" };
  } catch {
    return { pastReportChunks: [], retrievalSource: "none" };
  }
}

/**
 * Step 2: web search for external factors. Query is deliberately broad —
 * we want news-style context, not documentation.
 */
async function searchExternalFactors(breach: BreachEvent): Promise<{
  webResults: WebSearchResult[];
  webSearchAvailable: boolean;
}> {
  const year = new Date().getFullYear();
  const query = `ride hailing ${breach.displayName} drop reasons ${year}`;

  try {
    const response = await search(query, { safeSearch: SafeSearchType.MODERATE });
    const webResults = (response.results ?? [])
      .slice(0, CONFIG.WEB_SEARCH_RESULTS)
      .map((r) => ({
        title: r.title,
        // duck-duck-scrape returns HTML-flavored descriptions; strip tags.
        snippet: r.description.replace(/<[^>]+>/g, ""),
        url: r.url,
      }));
    console.log(`[context] Web search returned ${webResults.length} results.`);
    return { webResults, webSearchAvailable: true };
  } catch (err) {
    console.warn(
      "[context] Web search failed — proceeding without external context.",
      err instanceof Error ? err.message : err
    );
    return { webResults: [], webSearchAvailable: false };
  }
}

/**
 * Public entry point. `onProgress` lets the caller stream pipeline progress
 * to the browser (SSE) so the suspense animation tracks real work.
 */
export async function gatherContext(
  breach: BreachEvent,
  onProgress: (step: "vector_search" | "web_search", message: string) => void
): Promise<GatheredContext> {
  onProgress("vector_search", "Retrieving context from past reports...");
  const { pastReportChunks, retrievalSource } = await retrievePastReportContext(breach);

  onProgress("web_search", "Searching for external factors...");
  const { webResults, webSearchAvailable } = await searchExternalFactors(breach);

  return { pastReportChunks, retrievalSource, webResults, webSearchAvailable };
}
