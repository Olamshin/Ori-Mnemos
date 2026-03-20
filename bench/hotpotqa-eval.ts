#!/usr/bin/env npx tsx
/**
 * HotpotQA Benchmark: ori_query_ranked vs ori_explore head-to-head
 *
 * Each question has 10 context paragraphs (2 gold, 8 distractors).
 * Converts paragraphs to Ori notes in a temp vault, runs both retrieval
 * methods, measures which finds the 2 gold paragraphs.
 *
 * Usage:
 *   npx tsx bench/hotpotqa-eval.ts                       # 100 questions, both methods
 *   npx tsx bench/hotpotqa-eval.ts --n 500               # 500 questions
 *   npx tsx bench/hotpotqa-eval.ts --type bridge          # bridge questions only
 *   npx tsx bench/hotpotqa-eval.ts --no-embeddings        # BM25 + graph only
 *   npx tsx bench/hotpotqa-eval.ts --llm-judge            # Add LLM answer generation
 *   npx tsx bench/hotpotqa-eval.ts --json                 # Save results
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
import { explore, exploreRecursive } from "../src/core/explore.js";
import { createProvider, NullProvider } from "../src/core/llm.js";
import type { LlmProvider } from "../src/core/llm.js";

// Embedding imports
let buildIndex: typeof import("../src/core/engine.js")["buildIndex"] | null = null;
let initDB: typeof import("../src/core/engine.js")["initDB"] | null = null;
let loadVectors: typeof import("../src/core/engine.js")["loadVectors"] | null = null;
let searchComposite: typeof import("../src/core/engine.js")["searchComposite"] | null = null;

// ---------------------------------------------------------------------------
// HotpotQA Types
// ---------------------------------------------------------------------------

interface HotpotQuestion {
  _id: string;
  question: string;
  answer: string;
  type: "bridge" | "comparison";
  level: string;
  supporting_facts: [string, number][]; // [title, sentence_idx]
  context: [string, string[]][]; // [title, sentences[]]
}

// ---------------------------------------------------------------------------
// Vault creation from HotpotQA context
// ---------------------------------------------------------------------------

interface ContextNote {
  title: string;
  body: string;
  links: string[];
}

function buildContextNotes(q: HotpotQuestion): ContextNote[] {
  const notes: ContextNote[] = [];
  const allTitles = q.context.map(([t]) => t);

  for (const [title, sentences] of q.context) {
    const body = sentences.join(" ");
    // Detect wiki-links: if this paragraph mentions another context title, link it
    const links: string[] = [];
    for (const otherTitle of allTitles) {
      if (otherTitle !== title && body.includes(otherTitle)) {
        links.push(otherTitle);
      }
    }
    notes.push({ title, body, links });
  }
  return notes;
}

async function createTempVault(notes: ContextNote[]): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ori-hotpot-"));
  const notesDir = path.join(tmpDir, "notes");
  const oriDir = path.join(tmpDir, ".ori");
  await fs.mkdir(notesDir, { recursive: true });
  await fs.mkdir(oriDir, { recursive: true });

  await fs.writeFile(path.join(tmpDir, "ori.config.yaml"), `vault:\n  version: "0.3"\n`, "utf-8");

  for (const note of notes) {
    const fm: Record<string, unknown> = {
      description: note.body.substring(0, 150),
      type: "learning",
      status: "active",
    };
    let content = stringifyFrontmatter(fm, "\n" + note.body + "\n");
    if (note.links.length > 0) {
      content += "\n" + note.links.map(l => `See also [[${l}]].`).join("\n") + "\n";
    }
    // Sanitize filename
    const safeName = note.title.replace(/[<>:"/\\|?*]/g, "_");
    await fs.writeFile(path.join(notesDir, `${safeName}.md`), content, "utf-8");
  }
  return tmpDir;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

interface PipelineState {
  vaultRoot: string;
  config: OriConfig;
  linkGraph: LinkGraph;
  graphMetrics: GraphMetrics;
  bm25Index: BM25Index;
  allTitles: string[];
  embeddingsAvailable: boolean;
  notesDir: string;
}

async function buildPipeline(vaultRoot: string, useEmbeddings: boolean): Promise<PipelineState> {
  const config = applyConfigDefaults({ vault: { version: "0.3" } });
  const notesDir = path.join(vaultRoot, "notes");
  const linkGraph = await buildGraph(notesDir);
  const graphMetrics = computeGraphMetrics(linkGraph);

  const entries = await fs.readdir(notesDir);
  const allTitles = entries.filter(e => e.endsWith(".md")).map(e => e.replace(/\.md$/, ""));

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

  let embeddingsAvailable = false;
  if (useEmbeddings) {
    try {
      const engine = await import("../src/core/engine.js");
      buildIndex = engine.buildIndex;
      initDB = engine.initDB;
      loadVectors = engine.loadVectors;
      searchComposite = engine.searchComposite;
      await buildIndex(vaultRoot, config.engine, { force: true });
      embeddingsAvailable = true;
    } catch { /* continue */ }
  }

  return { vaultRoot, config, linkGraph, graphMetrics, bm25Index, allTitles, embeddingsAvailable, notesDir };
}

// ---------------------------------------------------------------------------
// Flat retrieval (ori_query_ranked style)
// ---------------------------------------------------------------------------

async function runFlat(pipeline: PipelineState, query: string, topK: number): Promise<string[]> {
  const { config, linkGraph, graphMetrics, bm25Index, allTitles, embeddingsAvailable, vaultRoot } = pipeline;
  const classified = classifyIntent(query, allTitles);
  const candidateLimit = topK * config.retrieval.candidate_multiplier;

  const bm25Results = searchBM25(query, bm25Index, config.bm25, candidateLimit);

  const seeds = bm25Results.length > 0 ? bm25Results.slice(0, 3).map(r => r.title) : allTitles.slice(0, 3);
  const graphologyGraph = buildGraphologyGraph(linkGraph);
  const pprScores = personalizedPageRank(graphologyGraph, seeds, 0.85, 20);
  const graphResults = rankByImportance(allTitles, pprScores, candidateLimit);

  let compositeResults: ScoredNote[] = [];
  if (embeddingsAvailable && searchComposite && initDB && loadVectors) {
    try {
      const dbPath = path.resolve(vaultRoot, config.engine.db_path);
      const db = initDB(dbPath);
      const storedVectors = loadVectors(db);
      db.close();
      const vitalityScores = new Map<string, number>();
      for (const t of allTitles) vitalityScores.set(t, 0.7);
      compositeResults = await searchComposite({
        queryText: query, intent: classified, storedVectors, graphMetrics,
        vitalityScores, limit: candidateLimit, config: config.engine,
      });
    } catch { /* continue */ }
  }

  const signals: SignalResults = { composite: compositeResults, keyword: bm25Results, graph: graphResults, warmth: [] };
  const fused = fuseScoreWeightedRRF(signals, config.retrieval);
  return fused.slice(0, topK).map(r => r.title);
}

// ---------------------------------------------------------------------------
// Explore retrieval (ori_explore style)
// ---------------------------------------------------------------------------

async function runExploreQuery(pipeline: PipelineState, query: string, topK: number): Promise<string[]> {
  const { config, linkGraph, graphMetrics, bm25Index, allTitles, embeddingsAvailable, vaultRoot, notesDir } = pipeline;
  const classified = classifyIntent(query, allTitles);
  const candidateLimit = config.explore.seed_count * config.retrieval.candidate_multiplier;

  const bm25Results = searchBM25(query, bm25Index, config.bm25, candidateLimit);

  let compositeResults: ScoredNote[] = [];
  if (embeddingsAvailable && searchComposite && initDB && loadVectors) {
    try {
      const dbPath = path.resolve(vaultRoot, config.engine.db_path);
      const db = initDB(dbPath);
      const storedVectors = loadVectors(db);
      db.close();
      const vitalityScores = new Map<string, number>();
      for (const t of allTitles) vitalityScores.set(t, 0.7);
      compositeResults = await searchComposite({
        queryText: query, intent: classified, storedVectors, graphMetrics,
        vitalityScores, limit: candidateLimit, config: config.engine,
      });
    } catch { /* continue */ }
  }

  const seedSignals: SignalResults = { composite: compositeResults, keyword: bm25Results, graph: [], warmth: [] };
  const seedFused = fuseScoreWeightedRRF(seedSignals, config.retrieval);
  const seedResults = seedFused.slice(0, config.explore.seed_count);

  const output = await explore({
    query, classified, linkGraph, notesDir,
    warmthSignals: new Map(), flatResults: seedResults,
    config: config.explore, qValueLookup: () => 0.5,
  });

  return output.results.slice(0, topK).map(r => r.title);
}

// ---------------------------------------------------------------------------
// Recursive explore (Phase 3 — with LLM sub-question decomposition)
// ---------------------------------------------------------------------------

async function runRecursiveExploreQuery(
  pipeline: PipelineState,
  query: string,
  topK: number,
  llmProvider: LlmProvider,
): Promise<string[]> {
  const { config, linkGraph, graphMetrics, bm25Index, allTitles, embeddingsAvailable, vaultRoot, notesDir } = pipeline;
  const classified = classifyIntent(query, allTitles);
  const candidateLimit = config.explore.seed_count * config.retrieval.candidate_multiplier;

  // Build seeds (same as Phase 1)
  const bm25Results = searchBM25(query, bm25Index, config.bm25, candidateLimit);
  let compositeResults: ScoredNote[] = [];
  if (embeddingsAvailable && searchComposite && initDB && loadVectors) {
    try {
      const dbPath = path.resolve(vaultRoot, config.engine.db_path);
      const db = initDB(dbPath);
      const storedVectors = loadVectors(db);
      db.close();
      const vitalityScores = new Map<string, number>();
      for (const t of allTitles) vitalityScores.set(t, 0.7);
      compositeResults = await searchComposite({
        queryText: query, intent: classified, storedVectors, graphMetrics,
        vitalityScores, limit: candidateLimit, config: config.engine,
      });
    } catch { /* continue */ }
  }

  const seedSignals: SignalResults = { composite: compositeResults, keyword: bm25Results, graph: [], warmth: [] };
  const seedFused = fuseScoreWeightedRRF(seedSignals, config.retrieval);
  const seedResults = seedFused.slice(0, config.explore.seed_count);

  // Reseed function for sub-questions
  const reseed = async (subQuery: string) => {
    const subBm25 = searchBM25(subQuery, bm25Index, config.bm25, candidateLimit);
    let subComposite: ScoredNote[] = [];
    if (embeddingsAvailable && searchComposite && initDB && loadVectors) {
      try {
        const dbPath = path.resolve(vaultRoot, config.engine.db_path);
        const db = initDB(dbPath);
        const sv = loadVectors(db);
        db.close();
        const vs = new Map<string, number>();
        for (const t of allTitles) vs.set(t, 0.7);
        const subClassified = classifyIntent(subQuery, allTitles);
        subComposite = await searchComposite({
          queryText: subQuery, intent: subClassified, storedVectors: sv, graphMetrics,
          vitalityScores: vs, limit: candidateLimit, config: config.engine,
        });
      } catch { /* continue */ }
    }
    const subSignals: SignalResults = { composite: subComposite, keyword: subBm25, graph: [], warmth: [] };
    const subFused = fuseScoreWeightedRRF(subSignals, config.retrieval);
    return subFused.slice(0, config.explore.seed_count);
  };

  const output = await exploreRecursive({
    query, classified, linkGraph, notesDir,
    warmthSignals: new Map(), seedResults,
    config: config.explore, qValueLookup: () => 0.5,
    llmProvider, allTitles, reseed,
  });

  return output.results.slice(0, topK).map(r => r.title);
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function recall(retrieved: string[], gold: string[]): number {
  const s = new Set(retrieved);
  return gold.length > 0 ? gold.filter(t => s.has(t)).length / gold.length : 0;
}

function precision(retrieved: string[], gold: string[]): number {
  const s = new Set(gold);
  return retrieved.length > 0 ? retrieved.filter(t => s.has(t)).length / retrieved.length : 0;
}

function f1(p: number, r: number): number {
  return p + r > 0 ? (2 * p * r) / (p + r) : 0;
}

function mrr(retrieved: string[], gold: string[]): number {
  const s = new Set(gold);
  for (let i = 0; i < retrieved.length; i++) {
    if (s.has(retrieved[i])) return 1 / (i + 1);
  }
  return 0;
}

// Extractive answer proxy
function answerRecallProxy(retrievedText: string, answer: string): number {
  const normalize = (s: string) => String(s).toLowerCase().replace(/\b(a|an|the)\b/g, " ").replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean);
  const ref = normalize(answer);
  if (ref.length === 0) return 1;
  const ctx = new Set(normalize(retrievedText));
  return ref.filter(t => ctx.has(t)).length / ref.length;
}

// LLM judge
async function llmAnswer(question: string, context: string, apiKey: string): Promise<string> {
  const body = {
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: "Answer using ONLY the context. Short, direct answer. If unknown, say 'I don't know'." },
      { role: "user", content: `Context:\n${context.substring(0, 20000)}\n\nQuestion: ${question}\n\nAnswer:` },
    ],
    max_tokens: 80, temperature: 0,
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (resp.status === 429) { await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt))); continue; }
    if (!resp.ok) throw new Error(`OpenAI ${resp.status}`);
    const data = await resp.json() as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message?.content?.trim() ?? "";
  }
  throw new Error("Max retries");
}

function tokenF1(pred: string, ref: string): number {
  const normalize = (s: string) => String(s).toLowerCase().replace(/\b(a|an|the)\b/g, " ").replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean);
  const p = normalize(pred), r = normalize(ref);
  if (r.length === 0) return p.length === 0 ? 1 : 0;
  if (p.length === 0) return 0;
  const rs = new Set(r), ps = new Set(p);
  const prec = p.filter(t => rs.has(t)).length / p.length;
  const rec = r.filter(t => ps.has(t)).length / r.length;
  return prec + rec > 0 ? (2 * prec * rec) / (prec + rec) : 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  n: number;
  topK: number;
  type: string | null;
  useEmbeddings: boolean;
  llmJudge: boolean;
  jsonOutput: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let n = 100, topK = 5, type: string | null = null;
  let useEmbeddings = true, llmJudge = false, jsonOutput = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--n" && i + 1 < args.length) n = parseInt(args[++i], 10);
    else if (args[i] === "--k" && i + 1 < args.length) topK = parseInt(args[++i], 10);
    else if (args[i] === "--type" && i + 1 < args.length) type = args[++i];
    else if (args[i] === "--no-embeddings") useEmbeddings = false;
    else if (args[i] === "--llm-judge") llmJudge = true;
    else if (args[i] === "--json") jsonOutput = true;
  }
  return { n, topK, type, useEmbeddings, llmJudge, jsonOutput };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface QResult {
  id: string;
  question: string;
  answer: string;
  qtype: string;
  gold: string[];
  flatRetrieved: string[];
  exploreRetrieved: string[];
  recursiveRetrieved: string[];
  flatR: number; flatP: number; flatF1: number; flatMRR: number; flatAnsProxy: number;
  explR: number; explP: number; explF1: number; explMRR: number; explAnsProxy: number;
  recR: number; recP: number; recF1: number; recMRR: number; recAnsProxy: number;
  flatLLM: number; explLLM: number; recLLM: number;
}

async function main() {
  const args = parseArgs();
  const startTime = Date.now();
  const apiKey = args.llmJudge ? (process.env.OPENAI_API_KEY ?? "") : "";
  if (args.llmJudge && !apiKey) { console.error("Need OPENAI_API_KEY"); process.exit(1); }

  console.log("HotpotQA Benchmark — Flat vs Explore Head-to-Head");
  console.log("=".repeat(70));
  console.log(`  Questions: ${args.n} | Top-K: ${args.topK} | Type: ${args.type ?? "all"}`);
  console.log(`  Embeddings: ${args.useEmbeddings} | LLM Judge: ${args.llmJudge}`);
  console.log("=".repeat(70) + "\n");

  const raw = await fs.readFile(path.join("bench", "data", "hotpotqa-dev.json"), "utf-8");
  let dataset: HotpotQuestion[] = JSON.parse(raw);
  if (args.type) dataset = dataset.filter(q => q.type === args.type);
  dataset = dataset.slice(0, args.n);
  console.log(`Loaded ${dataset.length} questions.\n`);

  // Create LLM provider for recursive explore (uses same API key as LLM judge)
  const recApiKey = process.env.OPENAI_API_KEY ?? "";
  let recLlmProvider: LlmProvider = new NullProvider();
  if (recApiKey) {
    try {
      recLlmProvider = await createProvider({
        provider: "openai", model: "gpt-4.1-mini",
        api_key_env: "OPENAI_API_KEY", base_url: null,
      });
    } catch { /* continue without recursive */ }
  }
  const hasRecursive = !(recLlmProvider instanceof NullProvider);
  if (hasRecursive) console.log("Recursive explore: ENABLED (gpt-4.1-mini for sub-questions)\n");
  else console.log("Recursive explore: DISABLED (no OPENAI_API_KEY)\n");

  const results: QResult[] = [];

  for (let i = 0; i < dataset.length; i++) {
    const q = dataset[i];
    const goldTitles = [...new Set(q.supporting_facts.map(([t]) => t.replace(/[<>:"/\\|?*]/g, "_")))];

    const notes = buildContextNotes(q);
    const vaultRoot = await createTempVault(notes);

    try {
      const pipeline = await buildPipeline(vaultRoot, args.useEmbeddings);
      const gold = goldTitles.filter(t => pipeline.allTitles.includes(t));
      if (gold.length === 0) continue;

      // Run all three methods
      const flatR = await runFlat(pipeline, q.question, args.topK);
      const explR = await runExploreQuery(pipeline, q.question, args.topK);
      const recR = hasRecursive
        ? await runRecursiveExploreQuery(pipeline, q.question, args.topK, recLlmProvider)
        : explR; // fallback to Phase 1 if no LLM

      // Read retrieved text for answer proxy
      const notesDir = path.join(vaultRoot, "notes");
      let flatText = "", explText = "", recText = "";
      for (const t of flatR) { try { flatText += " " + await fs.readFile(path.join(notesDir, `${t}.md`), "utf-8"); } catch {} }
      for (const t of explR) { try { explText += " " + await fs.readFile(path.join(notesDir, `${t}.md`), "utf-8"); } catch {} }
      for (const t of recR) { try { recText += " " + await fs.readFile(path.join(notesDir, `${t}.md`), "utf-8"); } catch {} }

      const fP = precision(flatR, gold), fRc = recall(flatR, gold);
      const eP = precision(explR, gold), eRc = recall(explR, gold);
      const rP = precision(recR, gold), rRc = recall(recR, gold);

      let flatLLM = -1, explLLM = -1, recLLM = -1;
      if (args.llmJudge && apiKey) {
        try {
          const fAns = await llmAnswer(q.question, flatText, apiKey);
          flatLLM = tokenF1(fAns, q.answer);
          const eAns = await llmAnswer(q.question, explText, apiKey);
          explLLM = tokenF1(eAns, q.answer);
          if (hasRecursive) {
            const rAns = await llmAnswer(q.question, recText, apiKey);
            recLLM = tokenF1(rAns, q.answer);
          }
        } catch { /* skip */ }
      }

      results.push({
        id: q._id, question: q.question, answer: q.answer, qtype: q.type, gold,
        flatRetrieved: flatR, exploreRetrieved: explR, recursiveRetrieved: recR,
        flatR: fRc, flatP: fP, flatF1: f1(fP, fRc), flatMRR: mrr(flatR, gold), flatAnsProxy: answerRecallProxy(flatText, q.answer),
        explR: eRc, explP: eP, explF1: f1(eP, eRc), explMRR: mrr(explR, gold), explAnsProxy: answerRecallProxy(explText, q.answer),
        recR: rRc, recP: rP, recF1: f1(rP, rRc), recMRR: mrr(recR, gold), recAnsProxy: answerRecallProxy(recText, q.answer),
        flatLLM, explLLM, recLLM,
      });

      if ((i + 1) % 25 === 0) {
        const done = results.length;
        const fF1 = results.reduce((s, r) => s + r.flatF1, 0) / done;
        const eF1 = results.reduce((s, r) => s + r.explF1, 0) / done;
        const rF1 = results.reduce((s, r) => s + r.recF1, 0) / done;
        console.log(`  [${i + 1}/${dataset.length}] flat=${fF1.toFixed(3)}  explore=${eF1.toFixed(3)}  recursive=${rF1.toFixed(3)}`);
      }
    } finally {
      try { await fs.rm(vaultRoot, { recursive: true, force: true }); } catch {}
    }
  }

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------
  const div = "=".repeat(70);
  const hasLLM = results.some(r => r.flatLLM >= 0);

  console.log("\n" + div);
  console.log("  HOTPOTQA: FLAT vs EXPLORE — HEAD TO HEAD");
  console.log(div + "\n");

  // By type
  const byType = new Map<string, QResult[]>();
  for (const r of results) {
    if (!byType.has(r.qtype)) byType.set(r.qtype, []);
    byType.get(r.qtype)!.push(r);
  }

  const hdr = ["Type".padEnd(12), "N".padStart(5),
    "Flat-R".padStart(7), "Expl-R".padStart(7), "Rec-R".padStart(7),
    "Flat-F1".padStart(8), "Expl-F1".padStart(8), "Rec-F1".padStart(8),
    "Flat-Ans".padStart(9), "Expl-Ans".padStart(9), "Rec-Ans".padStart(9),
  ];
  if (hasLLM) hdr.push("Flat-LLM".padStart(9), "Expl-LLM".padStart(9), "Rec-LLM".padStart(9));
  console.log("  " + hdr.join("  "));
  console.log("  " + "-".repeat(hdr.join("  ").length));

  for (const [t, rs] of [...byType.entries()].sort()) {
    const n = rs.length;
    const avg = (arr: QResult[], fn: (r: QResult) => number) => arr.reduce((s, r) => s + fn(r), 0) / n;
    const cols = [
      t.padEnd(12), String(n).padStart(5),
      avg(rs, r => r.flatR).toFixed(3).padStart(7), avg(rs, r => r.explR).toFixed(3).padStart(7), avg(rs, r => r.recR).toFixed(3).padStart(7),
      avg(rs, r => r.flatF1).toFixed(3).padStart(8), avg(rs, r => r.explF1).toFixed(3).padStart(8), avg(rs, r => r.recF1).toFixed(3).padStart(8),
      (avg(rs, r => r.flatAnsProxy) * 100).toFixed(1).padStart(9), (avg(rs, r => r.explAnsProxy) * 100).toFixed(1).padStart(9), (avg(rs, r => r.recAnsProxy) * 100).toFixed(1).padStart(9),
    ];
    if (hasLLM) {
      cols.push(
        (avg(rs, r => Math.max(0, r.flatLLM)) * 100).toFixed(1).padStart(9),
        (avg(rs, r => Math.max(0, r.explLLM)) * 100).toFixed(1).padStart(9),
        (avg(rs, r => Math.max(0, r.recLLM)) * 100).toFixed(1).padStart(9),
      );
    }
    console.log("  " + cols.join("  "));
  }

  // Overall
  const n = results.length;
  const avg = (fn: (r: QResult) => number) => results.reduce((s, r) => s + fn(r), 0) / n;
  console.log("  " + "-".repeat(hdr.join("  ").length));
  const oCols = [
    "OVERALL".padEnd(12), String(n).padStart(5),
    avg(r => r.flatR).toFixed(3).padStart(7), avg(r => r.explR).toFixed(3).padStart(7), avg(r => r.recR).toFixed(3).padStart(7),
    avg(r => r.flatF1).toFixed(3).padStart(8), avg(r => r.explF1).toFixed(3).padStart(8), avg(r => r.recF1).toFixed(3).padStart(8),
    (avg(r => r.flatAnsProxy) * 100).toFixed(1).padStart(9), (avg(r => r.explAnsProxy) * 100).toFixed(1).padStart(9), (avg(r => r.recAnsProxy) * 100).toFixed(1).padStart(9),
  ];
  if (hasLLM) {
    oCols.push(
      (avg(r => Math.max(0, r.flatLLM)) * 100).toFixed(1).padStart(9),
      (avg(r => Math.max(0, r.explLLM)) * 100).toFixed(1).padStart(9),
      (avg(r => Math.max(0, r.recLLM)) * 100).toFixed(1).padStart(9),
    );
  }
  console.log("  " + oCols.join("  "));
  console.log(div);

  // Win/loss counts (best of 3)
  let flatWins = 0, explWins = 0, recWins = 0, ties = 0;
  for (const r of results) {
    const best = Math.max(r.flatF1, r.explF1, r.recF1);
    if (r.flatF1 === best && r.explF1 < best && r.recF1 < best) flatWins++;
    else if (r.recF1 === best && r.flatF1 < best && r.explF1 < best) recWins++;
    else if (r.explF1 === best && r.flatF1 < best && r.recF1 < best) explWins++;
    else ties++;
  }
  console.log(`\n  Win/Loss: Flat ${flatWins} | Phase1 ${explWins} | Recursive ${recWins} | Ties ${ties}`);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  Total time: ${elapsed}s`);

  if (args.jsonOutput) {
    const resultsDir = path.join("bench", "results");
    await fs.mkdir(resultsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = path.join(resultsDir, `hotpotqa-${ts}.json`);
    await fs.writeFile(outPath, JSON.stringify({
      timestamp: new Date().toISOString(), n, topK: args.topK,
      flat: { R: avg(r => r.flatR), F1: avg(r => r.flatF1), MRR: avg(r => r.flatMRR), AnsProxy: avg(r => r.flatAnsProxy) },
      explore: { R: avg(r => r.explR), F1: avg(r => r.explF1), MRR: avg(r => r.explMRR), AnsProxy: avg(r => r.explAnsProxy) },
      wins: { flat: flatWins, explore: explWins, ties },
    }, null, 2), "utf-8");
    console.log(`  Saved: ${outPath}`);
  }
}

main().catch(e => { console.error("Failed:", e); process.exit(1); });
