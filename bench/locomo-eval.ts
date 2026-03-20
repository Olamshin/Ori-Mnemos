#!/usr/bin/env npx tsx
/**
 * LoCoMo Benchmark Adapter for Ori Mnemos
 *
 * Converts LoCoMo conversation data into a temporary Ori vault,
 * runs retrieval queries, and evaluates against ground-truth evidence.
 *
 * Each conversation session becomes an Ori note. QA evidence fields
 * map back to session notes. Evaluation measures whether Ori retrieves
 * the sessions containing the evidence turns.
 *
 * IMPORTANT: Creates a temp vault in os.tmpdir() — never touches real vaults.
 *
 * Usage:
 *   npx tsx bench/locomo-eval.ts                          # All 10 conversations
 *   npx tsx bench/locomo-eval.ts --sample 0               # Single conversation
 *   npx tsx bench/locomo-eval.ts --categories 1,2,3       # Filter question types
 *   npx tsx bench/locomo-eval.ts --k 5                    # Top-K (default: 5)
 *   npx tsx bench/locomo-eval.ts --no-embeddings          # BM25 + graph only
 *   npx tsx bench/locomo-eval.ts --json                   # Save JSON results
 *   npx tsx bench/locomo-eval.ts --max-questions 50       # Limit questions
 *   npx tsx bench/locomo-eval.ts --llm-judge              # Use GPT-4o-mini for answer generation
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { buildGraph } from "../src/core/graph.js";
import type { LinkGraph } from "../src/core/graph.js";
import { computeGraphMetrics, personalizedPageRank, buildGraphologyGraph } from "../src/core/importance.js";
import type { GraphMetrics } from "../src/core/importance.js";
import { buildBM25Index, searchBM25 } from "../src/core/bm25.js";
import type { BM25Index } from "../src/core/bm25.js";
import { classifyIntent } from "../src/core/intent.js";
import type { ClassifiedQuery } from "../src/core/intent.js";
import { fuseScoreWeightedRRF } from "../src/core/fusion.js";
import type { SignalResults } from "../src/core/fusion.js";
import { rankByImportance } from "../src/core/ranking.js";
import type { ScoredNote } from "../src/core/ranking.js";
import { applyConfigDefaults } from "../src/core/config.js";
import type { OriConfig } from "../src/core/config.js";
import { stringifyFrontmatter } from "../src/core/frontmatter.js";

// Explore imports
import { explore } from "../src/core/explore.js";

// Embedding imports — may fail if model unavailable
let buildIndex: typeof import("../src/core/engine.js")["buildIndex"] | null = null;
let initDB: typeof import("../src/core/engine.js")["initDB"] | null = null;
let loadVectors: typeof import("../src/core/engine.js")["loadVectors"] | null = null;
let searchComposite: typeof import("../src/core/engine.js")["searchComposite"] | null = null;

// ---------------------------------------------------------------------------
// LoCoMo Data Types
// ---------------------------------------------------------------------------

interface LoCoMoTurn {
  speaker: string;
  dia_id: string;
  text: string;
  img_url?: string[];
  blip_caption?: string;
}

interface LoCoMoQA {
  question: string;
  answer: string;
  evidence: string[];
  category: number; // 1=multi-hop, 2=single-hop, 3=temporal, 4=open-domain, 5=adversarial
}

interface LoCoMoSample {
  sample_id: string;
  conversation: Record<string, unknown> & {
    speaker_a: string;
    speaker_b: string;
  };
  observation: Record<string, string[]>;
  session_summary: Record<string, string>;
  qa: LoCoMoQA[];
}

const CATEGORY_NAMES: Record<number, string> = {
  1: "multi-hop",
  2: "single-hop",
  3: "temporal",
  4: "open-domain",
  5: "adversarial",
};

// ---------------------------------------------------------------------------
// Conversion: LoCoMo sessions → Ori notes
// ---------------------------------------------------------------------------

interface SessionNote {
  title: string;
  description: string;
  body: string;
  date: string;
  sessionNum: number;
  speakerA: string;
  speakerB: string;
  links: string[];
}

function parseLoCoMoDate(dateStr: string): string {
  // "1:56 pm on 8 May, 2023" → "2023-05-08"
  const match = dateStr.match(/on\s+(\d+)\s+(\w+),?\s+(\d{4})/);
  if (!match) return "2023-01-01";
  const [, day, monthName, year] = match;
  const months: Record<string, string> = {
    January: "01", February: "02", March: "03", April: "04",
    May: "05", June: "06", July: "07", August: "08",
    September: "09", October: "10", November: "11", December: "12",
  };
  const month = months[monthName] ?? "01";
  return `${year}-${month}-${day.padStart(2, "0")}`;
}

function extractSessions(sample: LoCoMoSample): SessionNote[] {
  const conv = sample.conversation;
  const speakerA = conv.speaker_a;
  const speakerB = conv.speaker_b;
  const notes: SessionNote[] = [];

  // Find all session keys
  const sessionNums: number[] = [];
  for (const key of Object.keys(conv)) {
    const m = key.match(/^session_(\d+)$/);
    if (m && Array.isArray(conv[key])) {
      sessionNums.push(parseInt(m[1], 10));
    }
  }
  sessionNums.sort((a, b) => a - b);

  for (const num of sessionNums) {
    const turns = conv[`session_${num}`] as LoCoMoTurn[] | undefined;
    const dateStr = conv[`session_${num}_date_time`] as string | undefined;
    if (!turns || turns.length === 0) continue;

    const date = dateStr ? parseLoCoMoDate(dateStr) : "2023-01-01";

    // Build body from dialogue turns
    const bodyLines = turns.map((t) => `[${t.dia_id}] ${t.speaker}: ${t.text}`);

    // Get observations for this session
    const obsKey = `session_${num}_observation`;
    const observations = sample.observation?.[obsKey] ?? [];

    // Get summary
    const sumKey = `session_${num}_summary`;
    const summary = sample.session_summary?.[sumKey] ?? "";

    // Description from summary or first observation
    const description = summary
      ? summary.substring(0, 200)
      : observations.length > 0
        ? observations[0].substring(0, 200)
        : `Conversation session ${num} between ${speakerA} and ${speakerB}`;

    // Link to adjacent sessions
    const links: string[] = [];
    if (num > 1 && sessionNums.includes(num - 1)) {
      links.push(`${sample.sample_id}-session-${num - 1}`);
    }
    if (sessionNums.includes(num + 1)) {
      links.push(`${sample.sample_id}-session-${num + 1}`);
    }

    let body = bodyLines.join("\n");
    if (observations.length > 0) {
      body += "\n\n## Observations\n" + observations.map((o) => `- ${o}`).join("\n");
    }
    if (links.length > 0) {
      body += "\n\n" + links.map((l) => `See also [[${l}]].`).join("\n");
    }

    notes.push({
      title: `${sample.sample_id}-session-${num}`,
      description,
      body,
      date,
      sessionNum: num,
      speakerA,
      speakerB,
      links,
    });
  }

  return notes;
}

/**
 * Map evidence dia_ids to session note titles.
 * Evidence "D3:5" means session 3, turn 5 → note title "{sample_id}-session-3"
 */
function evidenceToSessions(evidence: string[], sampleId: string): string[] {
  const sessions = new Set<string>();
  for (const eid of evidence) {
    const m = eid.match(/^D(\d+):/);
    if (m) {
      sessions.add(`${sampleId}-session-${m[1]}`);
    }
  }
  return [...sessions];
}

// ---------------------------------------------------------------------------
// Vault Setup (temp dir — never touches real vaults)
// ---------------------------------------------------------------------------

async function createTempVault(notes: SessionNote[]): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ori-locomo-eval-"));
  const notesDir = path.join(tmpDir, "notes");
  const oriDir = path.join(tmpDir, ".ori");

  await fs.mkdir(notesDir, { recursive: true });
  await fs.mkdir(oriDir, { recursive: true });

  // Write config
  const configContent = `vault:
  version: "0.3"
engine:
  embedding_model: "Xenova/all-MiniLM-L6-v2"
  embedding_dims: 384
  piecewise_bins: 8
  community_dims: 16
  db_path: ".ori/embeddings.db"
retrieval:
  default_limit: 10
  candidate_multiplier: 5
  rrf_k: 60
  signal_weights:
    composite: 2.0
    keyword: 1.0
    graph: 1.5
  exploration_budget: 0.0
bm25:
  k1: 1.2
  b: 0.75
  title_boost: 3.0
  description_boost: 2.0
`;
  await fs.writeFile(path.join(tmpDir, "ori.config.yaml"), configContent, "utf-8");

  // Write notes
  for (const note of notes) {
    const frontmatter: Record<string, unknown> = {
      description: note.description,
      type: "episodic",
      project: ["locomo"],
      status: "active",
      created: note.date,
    };
    const content = stringifyFrontmatter(frontmatter, "\n" + note.body + "\n");
    await fs.writeFile(path.join(notesDir, `${note.title}.md`), content, "utf-8");
  }

  return tmpDir;
}

// ---------------------------------------------------------------------------
// Retrieval Pipeline (same as locomo.ts)
// ---------------------------------------------------------------------------

interface PipelineState {
  vaultRoot: string;
  config: OriConfig;
  linkGraph: LinkGraph;
  graphMetrics: GraphMetrics;
  bm25Index: BM25Index;
  allTitles: string[];
  embeddingsAvailable: boolean;
}

async function buildPipeline(vaultRoot: string, useEmbeddings: boolean): Promise<PipelineState> {
  const config = applyConfigDefaults({
    vault: { version: "0.3" },
    retrieval: {
      default_limit: 10,
      candidate_multiplier: 5,
      rrf_k: 60,
      signal_weights: { composite: 2.0, keyword: 1.0, graph: 1.5 },
      exploration_budget: 0.0,
    },
  });

  const notesDir = path.join(vaultRoot, "notes");
  const linkGraph = await buildGraph(notesDir);
  const graphMetrics = computeGraphMetrics(linkGraph);

  const entries = await fs.readdir(notesDir);
  const allTitles = entries.filter((e) => e.endsWith(".md")).map((e) => e.replace(/\.md$/, ""));

  // Build BM25
  const docs: Array<{ title: string; description: string; body: string }> = [];
  for (const title of allTitles) {
    const content = await fs.readFile(path.join(notesDir, `${title}.md`), "utf-8");
    const lines = content.split("\n");
    let bodyStart = 0;
    if (lines[0] === "---") {
      for (let i = 1; i < lines.length; i++) {
        if (lines[i] === "---") { bodyStart = i + 1; break; }
      }
    }
    const body = lines.slice(bodyStart).join("\n");
    const descMatch = content.match(/^description:\s*(.+)$/m);
    const description = descMatch ? descMatch[1].trim().replace(/^["']|["']$/g, "") : "";
    docs.push({ title, description, body });
  }
  const bm25Index = buildBM25Index(docs, config.bm25);

  // Embeddings
  let embeddingsAvailable = false;
  if (useEmbeddings) {
    try {
      const engine = await import("../src/core/engine.js");
      buildIndex = engine.buildIndex;
      initDB = engine.initDB;
      loadVectors = engine.loadVectors;
      searchComposite = engine.searchComposite;

      console.log("  Building embedding index...");
      const stats = await buildIndex(vaultRoot, config.engine, { force: true });
      console.log(`  Indexed ${stats.indexed} notes in ${stats.durationMs}ms`);
      embeddingsAvailable = true;
    } catch (err) {
      console.log(`  Embeddings unavailable: ${(err as Error).message}`);
    }
  }

  return { vaultRoot, config, linkGraph, graphMetrics, bm25Index, allTitles, embeddingsAvailable };
}

async function runQuery(pipeline: PipelineState, query: string, topK: number): Promise<string[]> {
  const { config, linkGraph, graphMetrics, bm25Index, allTitles, embeddingsAvailable, vaultRoot } = pipeline;

  const classified: ClassifiedQuery = classifyIntent(query, allTitles);
  const candidateLimit = topK * config.retrieval.candidate_multiplier;

  // BM25
  const bm25Results = searchBM25(query, bm25Index, config.bm25, candidateLimit);

  // Graph: PPR seeded from BM25 top hits
  const seeds = bm25Results.length > 0
    ? bm25Results.slice(0, 3).map((r) => r.title)
    : allTitles.slice(0, 3);
  const graphologyGraph = buildGraphologyGraph(linkGraph);
  const pprScores = personalizedPageRank(graphologyGraph, seeds, 0.85, 20);
  const graphResults = rankByImportance(allTitles, pprScores, candidateLimit);

  // Composite embeddings
  let compositeResults: ScoredNote[] = [];
  if (embeddingsAvailable && searchComposite && initDB && loadVectors) {
    try {
      const dbPath = path.resolve(vaultRoot, config.engine.db_path);
      const db = initDB(dbPath);
      const storedVectors = loadVectors(db);
      db.close();

      const vitalityScores = new Map<string, number>();
      for (const title of allTitles) vitalityScores.set(title, 0.7);

      compositeResults = await searchComposite({
        queryText: query,
        intent: classified,
        storedVectors,
        graphMetrics,
        vitalityScores,
        limit: candidateLimit,
        config: config.engine,
      });
    } catch { /* continue without */ }
  }

  const signals: SignalResults = { composite: compositeResults, keyword: bm25Results, graph: graphResults, warmth: [] };
  const fused = fuseScoreWeightedRRF(signals, config.retrieval);
  return fused.slice(0, topK).map((r) => r.title);
}

async function runQueryExplore(pipeline: PipelineState, query: string, topK: number): Promise<string[]> {
  const { config, linkGraph, bm25Index, allTitles, embeddingsAvailable, vaultRoot, graphMetrics } = pipeline;

  const classified = classifyIntent(query, allTitles);
  const candidateLimit = topK * config.retrieval.candidate_multiplier;

  // Build seed results (same as flat retrieval)
  const bm25Results = searchBM25(query, bm25Index, config.bm25, candidateLimit);

  let compositeResults: ScoredNote[] = [];
  if (embeddingsAvailable && searchComposite && initDB && loadVectors) {
    try {
      const dbPath = path.resolve(vaultRoot, config.engine.db_path);
      const db = initDB(dbPath);
      const storedVectors = loadVectors(db);
      db.close();
      const vitalityScores = new Map<string, number>();
      for (const title of allTitles) vitalityScores.set(title, 0.7);
      compositeResults = await searchComposite({
        queryText: query,
        intent: classified,
        storedVectors,
        graphMetrics,
        vitalityScores,
        limit: candidateLimit,
        config: config.engine,
      });
    } catch { /* continue without */ }
  }

  const seedSignals: SignalResults = { composite: compositeResults, keyword: bm25Results, graph: [], warmth: [] };
  const seedFused = fuseScoreWeightedRRF(seedSignals, config.retrieval);
  const seedResults = seedFused.slice(0, config.explore.seed_count);

  // Run explore pipeline with PPR at α=0.45
  const notesDir = path.join(vaultRoot, "notes");
  const output = await explore({
    query,
    classified,
    linkGraph,
    notesDir,
    warmthSignals: new Map(),
    flatResults: seedResults,
    config: config.explore,
    qValueLookup: () => 0.5,
  });

  return output.results.slice(0, topK).map((r) => r.title);
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function precision(retrieved: string[], relevant: string[]): number {
  const s = new Set(relevant);
  return retrieved.length > 0 ? retrieved.filter((t) => s.has(t)).length / retrieved.length : 0;
}

function recall(retrieved: string[], relevant: string[]): number {
  const s = new Set(retrieved);
  return relevant.length > 0 ? relevant.filter((t) => s.has(t)).length / relevant.length : 0;
}

function f1(p: number, r: number): number {
  return p + r > 0 ? (2 * p * r) / (p + r) : 0;
}

function mrr(retrieved: string[], relevant: string[]): number {
  const s = new Set(relevant);
  for (let i = 0; i < retrieved.length; i++) {
    if (s.has(retrieved[i])) return 1 / (i + 1);
  }
  return 0;
}

/** Normalize text for token comparison: lowercase, remove articles/punctuation, split. */
function normalizeTokens(s: string): string[] {
  return String(s).toLowerCase()
    .replace(/\b(a|an|the)\b/g, " ")
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Extractive answer proxy: what fraction of the ground-truth answer tokens
 * appear somewhere in the retrieved text? This measures whether the retrieval
 * found enough context for an LLM to answer correctly.
 *
 * Returns a score 0-1 (scaled to 0-100 for the comparison table).
 */
function answerRecallProxy(retrievedText: string, groundTruth: string): number {
  const ref = normalizeTokens(groundTruth);
  if (ref.length === 0) return 1;
  const contextTokens = new Set(normalizeTokens(retrievedText));
  const hits = ref.filter((t) => contextTokens.has(t)).length;
  return hits / ref.length;
}

// ---------------------------------------------------------------------------
// LLM Judge (GPT-4o-mini)
// ---------------------------------------------------------------------------

/**
 * Token F1 between generated answer and ground truth (LoCoMo's primary metric).
 */
function tokenF1(prediction: string, reference: string): number {
  const pred = normalizeTokens(prediction);
  const ref = normalizeTokens(reference);
  if (ref.length === 0) return pred.length === 0 ? 1 : 0;
  if (pred.length === 0) return 0;
  const refSet = new Set(ref);
  const predSet = new Set(pred);
  const overlap = pred.filter((t) => refSet.has(t)).length;
  const p = overlap / pred.length;
  const r = ref.filter((t) => predSet.has(t)).length / ref.length;
  return p + r > 0 ? (2 * p * r) / (p + r) : 0;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function llmGenerateAnswer(
  question: string,
  context: string,
  apiKey: string,
  maxRetries = 5,
): Promise<string> {
  const body = {
    model: "gpt-4.1-mini",
    messages: [
      {
        role: "system" as const,
        content: "You are answering questions about conversations. Use ONLY the provided context. Give a short, direct answer — no explanation. If the answer is not in the context, say 'I don't know'.",
      },
      {
        role: "user" as const,
        content: `Context:\n${context}\n\nQuestion: ${question}\n\nAnswer:`,
      },
    ],
    max_tokens: 100,
    temperature: 0,
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (resp.status === 429) {
      // Rate limited — wait and retry
      const waitMs = Math.min(2000 * Math.pow(2, attempt), 30000);
      await sleep(waitMs);
      continue;
    }

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`OpenAI API error ${resp.status}: ${err}`);
    }

    const data = await resp.json() as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message?.content?.trim() ?? "";
  }

  throw new Error("Max retries exceeded for rate limiting");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface EvalArgs {
  dataPath: string;
  sampleIndex: number | null;
  categories: Set<number> | null;
  topK: number;
  useEmbeddings: boolean;
  jsonOutput: boolean;
  maxQuestions: number;
  llmJudge: boolean;
  useExplore: boolean;
}

function parseArgs(): EvalArgs {
  const args = process.argv.slice(2);
  let dataPath = path.join("bench", "data", "locomo10.json");
  let sampleIndex: number | null = null;
  let categories: Set<number> | null = null;
  let topK = 5;
  let useEmbeddings = true;
  let jsonOutput = false;
  let maxQuestions = Infinity;
  let llmJudge = false;
  let useExplore = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--data" && i + 1 < args.length) {
      dataPath = args[++i];
    } else if (args[i] === "--sample" && i + 1 < args.length) {
      sampleIndex = parseInt(args[++i], 10);
    } else if (args[i] === "--categories" && i + 1 < args.length) {
      categories = new Set(args[++i].split(",").map(Number));
    } else if (args[i] === "--k" && i + 1 < args.length) {
      topK = parseInt(args[++i], 10);
    } else if (args[i] === "--no-embeddings") {
      useEmbeddings = false;
    } else if (args[i] === "--json") {
      jsonOutput = true;
    } else if (args[i] === "--max-questions" && i + 1 < args.length) {
      maxQuestions = parseInt(args[++i], 10);
    } else if (args[i] === "--llm-judge") {
      llmJudge = true;
    } else if (args[i] === "--explore") {
      useExplore = true;
    }
  }

  return { dataPath, sampleIndex, categories, topK, useEmbeddings, jsonOutput, maxQuestions, llmJudge, useExplore };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface QueryResult {
  sampleId: string;
  question: string;
  answer: string;
  category: number;
  categoryName: string;
  evidenceSessions: string[];
  retrieved: string[];
  precision: number;
  recall: number;
  f1: number;
  mrr: number;
  answerF1: number; // extractive proxy: token overlap of ground-truth answer vs retrieved text
  llmAnswerF1: number; // LLM-generated answer token F1 vs ground truth (-1 if not run)
  llmAnswer: string; // LLM-generated answer text
}

async function main(): Promise<void> {
  const args = parseArgs();
  const startTime = Date.now();

  console.log("LoCoMo Benchmark — Ori Mnemos");
  console.log("==============================\n");

  // LLM judge setup
  const apiKey = args.llmJudge ? process.env.OPENAI_API_KEY ?? "" : "";
  if (args.llmJudge && !apiKey) {
    console.error("ERROR: --llm-judge requires OPENAI_API_KEY env var");
    process.exit(1);
  }
  if (args.llmJudge) {
    console.log("LLM Judge: GPT-4.1-mini (answer generation + token F1)");
  }
  if (args.useExplore) {
    console.log("Retrieval: ori_explore (PPR α=0.45, deep graph traversal)");
  } else {
    console.log("Retrieval: ori_query_ranked (flat 4-signal fusion)");
  }
  console.log("");

  // Load dataset
  console.log(`Loading ${args.dataPath}...`);
  const raw = await fs.readFile(args.dataPath, "utf-8");
  const dataset: LoCoMoSample[] = JSON.parse(raw);
  console.log(`  ${dataset.length} conversations loaded.`);

  // Select samples
  const samples = args.sampleIndex !== null ? [dataset[args.sampleIndex]] : dataset;

  // Process each conversation independently (separate vault per conversation)
  const allResults: QueryResult[] = [];
  let questionsProcessed = 0;

  for (const sample of samples) {
    if (questionsProcessed >= args.maxQuestions) break;

    console.log(`\n--- ${sample.sample_id} (${sample.conversation.speaker_a} & ${sample.conversation.speaker_b}) ---`);

    // Convert sessions to notes
    const sessionNotes = extractSessions(sample);
    console.log(`  ${sessionNotes.length} session notes created.`);

    // Filter QAs
    let qas = sample.qa;
    if (args.categories) {
      qas = qas.filter((q) => args.categories!.has(q.category));
    }
    // Skip adversarial (cat 5) by default — correct answer is "no info", retrieval eval doesn't apply
    if (!args.categories) {
      qas = qas.filter((q) => q.category !== 5);
    }
    const remaining = args.maxQuestions - questionsProcessed;
    if (qas.length > remaining) qas = qas.slice(0, remaining);

    console.log(`  ${qas.length} questions to evaluate.`);
    if (qas.length === 0) continue;

    // Create temp vault
    const vaultRoot = await createTempVault(sessionNotes);
    console.log(`  Temp vault: ${vaultRoot}`);

    try {
      // Build pipeline
      const pipeline = await buildPipeline(vaultRoot, args.useEmbeddings);
      console.log(`  Pipeline: ${pipeline.allTitles.length} notes, embeddings=${pipeline.embeddingsAvailable}`);

      // Run queries
      const notesDir = path.join(vaultRoot, "notes");
      for (const qa of qas) {
        const evidenceSessions = evidenceToSessions(qa.evidence, sample.sample_id);
        if (evidenceSessions.length === 0) continue; // skip if no evidence mapping

        const retrieved = args.useExplore
          ? await runQueryExplore(pipeline, qa.question, args.topK)
          : await runQuery(pipeline, qa.question, args.topK);
        const p = precision(retrieved, evidenceSessions);
        const r = recall(retrieved, evidenceSessions);

        // Extractive proxy: read retrieved session text, compute token F1 against ground-truth answer
        let retrievedText = "";
        for (const title of retrieved) {
          try {
            const content = await fs.readFile(path.join(notesDir, `${title}.md`), "utf-8");
            retrievedText += " " + content;
          } catch { /* skip missing */ }
        }
        const aF1 = answerRecallProxy(retrievedText, String(qa.answer));

        // LLM judge
        let llmAnsF1 = -1;
        let llmAnswer = "";
        if (args.llmJudge && apiKey) {
          try {
            // Truncate context to ~6K tokens (~24K chars) to stay within limits
            const truncatedContext = retrievedText.substring(0, 24000);
            llmAnswer = await llmGenerateAnswer(qa.question, truncatedContext, apiKey);
            llmAnsF1 = tokenF1(llmAnswer, String(qa.answer));
          } catch (err) {
            console.error(`    LLM error: ${(err as Error).message}`);
            llmAnsF1 = 0;
          }
        }

        allResults.push({
          sampleId: sample.sample_id,
          question: qa.question,
          answer: qa.answer,
          category: qa.category,
          categoryName: CATEGORY_NAMES[qa.category] ?? "unknown",
          evidenceSessions,
          retrieved,
          precision: p,
          recall: r,
          f1: f1(p, r),
          mrr: mrr(retrieved, evidenceSessions),
          answerF1: aF1,
          llmAnswerF1: llmAnsF1,
          llmAnswer,
        });
        questionsProcessed++;
      }

      // Progress
      const sampleResults = allResults.filter((r) => r.sampleId === sample.sample_id);
      const sampleF1 = sampleResults.reduce((s, r) => s + r.f1, 0) / sampleResults.length;
      console.log(`  ${sample.sample_id}: ${sampleResults.length} questions, mean F1=${sampleF1.toFixed(3)}`);
    } finally {
      // Cleanup temp vault
      try { await fs.rm(vaultRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------

  const divider = "=".repeat(80);

  console.log("\n" + divider);
  console.log("  LOCOMO EVALUATION RESULTS");
  console.log(divider);

  // Per-category breakdown
  const byCategory = new Map<number, QueryResult[]>();
  for (const r of allResults) {
    if (!byCategory.has(r.category)) byCategory.set(r.category, []);
    byCategory.get(r.category)!.push(r);
  }

  console.log(`\n  Total questions: ${allResults.length}`);
  console.log(`  Top-K: ${args.topK}\n`);

  const hasLLM = allResults.some((r) => r.llmAnswerF1 >= 0);
  const headerCols = [
    "Category".padEnd(15),
    "N".padStart(5),
    "P@K".padStart(8),
    "R@K".padStart(8),
    "F1@K".padStart(8),
    "MRR".padStart(8),
    "AnsF1".padStart(8),
  ];
  if (hasLLM) headerCols.push("LLM-F1".padStart(8));
  const header = headerCols.join("  ");
  console.log("  " + header);
  console.log("  " + "-".repeat(header.length));

  for (const [cat, results] of [...byCategory.entries()].sort((a, b) => a[0] - b[0])) {
    const n = results.length;
    const mp = results.reduce((s, r) => s + r.precision, 0) / n;
    const mr = results.reduce((s, r) => s + r.recall, 0) / n;
    const mf = results.reduce((s, r) => s + r.f1, 0) / n;
    const mm = results.reduce((s, r) => s + r.mrr, 0) / n;
    const ma = results.reduce((s, r) => s + r.answerF1, 0) / n;
    const rowCols = [
      (CATEGORY_NAMES[cat] ?? "?").padEnd(15),
      String(n).padStart(5),
      mp.toFixed(4).padStart(8),
      mr.toFixed(4).padStart(8),
      mf.toFixed(4).padStart(8),
      mm.toFixed(4).padStart(8),
      ma.toFixed(4).padStart(8),
    ];
    if (hasLLM) {
      const ml = results.reduce((s, r) => s + Math.max(0, r.llmAnswerF1), 0) / n;
      rowCols.push(ml.toFixed(4).padStart(8));
    }
    console.log("  " + rowCols.join("  "));
  }

  // Aggregate
  const n = allResults.length;
  const meanP = allResults.reduce((s, r) => s + r.precision, 0) / n;
  const meanR = allResults.reduce((s, r) => s + r.recall, 0) / n;
  const meanF1 = allResults.reduce((s, r) => s + r.f1, 0) / n;
  const meanMRR = allResults.reduce((s, r) => s + r.mrr, 0) / n;
  const meanAnsF1 = allResults.reduce((s, r) => s + r.answerF1, 0) / n;

  const meanLLM = hasLLM ? allResults.reduce((s, r) => s + Math.max(0, r.llmAnswerF1), 0) / n : 0;

  console.log("  " + "-".repeat(header.length));
  const aggCols = [
    "OVERALL".padEnd(15),
    String(n).padStart(5),
    meanP.toFixed(4).padStart(8),
    meanR.toFixed(4).padStart(8),
    meanF1.toFixed(4).padStart(8),
    meanMRR.toFixed(4).padStart(8),
    meanAnsF1.toFixed(4).padStart(8),
  ];
  if (hasLLM) aggCols.push(meanLLM.toFixed(4).padStart(8));
  console.log("  " + aggCols.join("  "));
  console.log(divider);

  // Per-category answer F1 for comparison table
  console.log("\n" + divider);
  console.log("  COMPARISON TABLE (Answer F1 — same metric as Mem0 paper)");
  console.log(divider + "\n");

  // Collect Ori's per-category answer F1
  const oriByCategory: Record<string, number> = {};
  for (const [cat, results] of byCategory) {
    oriByCategory[CATEGORY_NAMES[cat] ?? "?"] = results.reduce((s, r) => s + r.answerF1, 0) / results.length;
  }

  const compHeader = [
    "System".padEnd(20),
    "Single".padStart(8),
    "Multi".padStart(8),
    "Temporal".padStart(8),
  ].join("  ");
  console.log("  " + compHeader);
  console.log("  " + "-".repeat(compHeader.length));

  // Known baselines (Answer F1 from Mem0 paper, Table 1)
  const baselines: Array<{ name: string; single: string; multi: string; temporal: string }> = [
    { name: "MemoryBank", single: "5.00", multi: "—", temporal: "—" },
    { name: "ReadAgent", single: "9.15", multi: "—", temporal: "—" },
    { name: "A-Mem", single: "20.76", multi: "—", temporal: "35.40" },
    { name: "MemGPT/Letta", single: "26.65", multi: "—", temporal: "—" },
    { name: "LangMem", single: "35.51", multi: "26.04", temporal: "—" },
    { name: "Zep", single: "35.74", multi: "19.37", temporal: "42.00" },
    { name: "OpenAI Memory", single: "34.30", multi: "—", temporal: "—" },
    { name: "Mem0", single: "38.72", multi: "28.64", temporal: "48.93" },
  ];

  for (const b of baselines) {
    const row = [
      b.name.padEnd(20),
      b.single.padStart(8),
      b.multi.padStart(8),
      b.temporal.padStart(8),
    ].join("  ");
    console.log("  " + row);
  }

  // Ori's extractive row
  // Scale 0-1 to 0-100 to match Mem0 paper's scale
  const oriSingle = ((oriByCategory["single-hop"] ?? 0) * 100).toFixed(2);
  const oriMulti = ((oriByCategory["multi-hop"] ?? 0) * 100).toFixed(2);
  const oriTemporal = ((oriByCategory["temporal"] ?? 0) * 100).toFixed(2);
  const oriExtRow = [
    "Ori (extractive)*".padEnd(20),
    oriSingle.padStart(8),
    oriMulti.padStart(8),
    oriTemporal.padStart(8),
  ].join("  ");
  console.log("  " + oriExtRow);

  // Ori's LLM-judged row
  if (hasLLM) {
    const llmByCategory: Record<string, number> = {};
    for (const [cat, results] of byCategory) {
      llmByCategory[CATEGORY_NAMES[cat] ?? "?"] =
        (results.reduce((s, r) => s + Math.max(0, r.llmAnswerF1), 0) / results.length) * 100;
    }
    const oriLLMRow = [
      "Ori (GPT-4o-mini)".padEnd(20),
      (llmByCategory["single-hop"] ?? 0).toFixed(2).padStart(8),
      (llmByCategory["multi-hop"] ?? 0).toFixed(2).padStart(8),
      (llmByCategory["temporal"] ?? 0).toFixed(2).padStart(8),
    ].join("  ");
    console.log("  " + oriLLMRow);
  }

  console.log("\n  * Extractive proxy — answer token recall against retrieved text.");
  console.log(divider);

  // Worst queries (bottom 5 by answerF1)
  const sorted = [...allResults].sort((a, b) => a.answerF1 - b.answerF1);
  const worst = sorted.slice(0, 5);
  console.log("\n  HARDEST QUERIES (lowest Answer F1):");
  for (const r of worst) {
    console.log(`    [${r.categoryName}] AnsF1=${r.answerF1.toFixed(3)} "${r.question.substring(0, 70)}"`);
    console.log(`      Answer: "${String(r.answer).substring(0, 60)}"`);
    console.log(`      Retrieved: ${r.retrieved.slice(0, 3).join(", ")}`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nTotal time: ${elapsed}s`);

  // JSON output
  if (args.jsonOutput) {
    const resultsDir = path.join("bench", "results");
    await fs.mkdir(resultsDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outputPath = path.join(resultsDir, `locomo-eval-${timestamp}.json`);
    const output = {
      timestamp: new Date().toISOString(),
      topK: args.topK,
      embeddingsUsed: args.useEmbeddings,
      totalQuestions: n,
      aggregate: { meanPrecision: meanP, meanRecall: meanR, meanF1, meanMRR, meanAnsF1 },
      byCategory: [...byCategory.entries()].map(([cat, results]) => ({
        category: cat,
        name: CATEGORY_NAMES[cat],
        count: results.length,
        meanPrecision: results.reduce((s, r) => s + r.precision, 0) / results.length,
        meanRecall: results.reduce((s, r) => s + r.recall, 0) / results.length,
        meanF1: results.reduce((s, r) => s + r.f1, 0) / results.length,
        meanMRR: results.reduce((s, r) => s + r.mrr, 0) / results.length,
        meanAnsF1: results.reduce((s, r) => s + r.answerF1, 0) / results.length,
      })),
      perQuery: allResults.map((r) => ({
        sampleId: r.sampleId,
        question: r.question,
        category: r.category,
        evidenceSessions: r.evidenceSessions,
        retrieved: r.retrieved,
        precision: r.precision,
        recall: r.recall,
        f1: r.f1,
        mrr: r.mrr,
      })),
    };
    await fs.writeFile(outputPath, JSON.stringify(output, null, 2), "utf-8");
    console.log(`\nResults saved to: ${outputPath}`);
  }
}

main().catch((err) => {
  console.error("LoCoMo eval failed:", err);
  process.exit(1);
});
