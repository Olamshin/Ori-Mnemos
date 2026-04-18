#!/usr/bin/env npx tsx
/**
 * LOCOMO Benchmark for Ori Mnemos v0.3
 *
 * Evaluates retrieval quality by:
 * 1. Creating a temporary vault with test notes
 * 2. Building the BM25 index and link graph
 * 3. Optionally building embedding index (auto-downloads ~22MB model)
 * 4. Running queries through the retrieval pipeline
 * 5. Computing precision, recall, F1 against expected results
 *
 * Usage:
 *   npx tsx bench/locomo.ts                                  # Run with synthetic data
 *   npx tsx bench/locomo.ts --data bench/data/locomo.json    # Run with real LOCOMO data
 *   npx tsx bench/locomo.ts --k 5                            # Top-K (default: 5)
 *   npx tsx bench/locomo.ts --no-embeddings                  # Skip embedding index
 *   npx tsx bench/locomo.ts --ablation                       # Signal ablation comparison
 *   npx tsx bench/locomo.ts --ablation --json                # Ablation + save JSON results
 *   npx tsx bench/locomo.ts --json                           # Standard + save JSON results
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

// Embedding imports — may fail if model is unavailable
let buildIndex: typeof import("../src/core/engine.js")["buildIndex"] | null = null;
let initDB: typeof import("../src/core/engine.js")["initDB"] | null = null;
let loadVectors: typeof import("../src/core/engine.js")["loadVectors"] | null = null;
let searchComposite: typeof import("../src/core/engine.js")["searchComposite"] | null = null;

// ---------------------------------------------------------------------------
// Synthetic Test Data
// ---------------------------------------------------------------------------

interface SyntheticNote {
  title: string;
  type: string;
  project: string[];
  description: string;
  body: string;
  links: string[];
}

interface TestQuery {
  query: string;
  expectedRelevant: string[];
  intent: string;
}

const SYNTHETIC_NOTES: SyntheticNote[] = [
  // AI Agents cluster
  {
    title: "agent memory requires both episodic and semantic retrieval",
    type: "insight",
    project: ["ai-agents"],
    description: "Pure semantic search misses temporal context while pure episodic misses conceptual links",
    body: `Agent memory systems need both episodic (when did X happen) and semantic (what is related to X) retrieval.
Episodic retrieval captures the timeline of events — session logs, conversation sequences, temporal ordering.
Semantic retrieval finds conceptual neighbors — notes about similar topics regardless of when they were created.
A system using only embeddings will surface topically similar notes but lose the "last Tuesday we decided..." context.
A system using only recency will miss deep structural connections across projects.
The answer is multi-signal fusion: combine [[episodic retrieval captures temporal context that semantic search misses]]
with [[BM25 keyword search provides exact term matching that embeddings miss]].
See also [[personalized pagerank spreads activation through the link graph]].`,
    links: [
      "episodic retrieval captures temporal context that semantic search misses",
      "BM25 keyword search provides exact term matching that embeddings miss",
      "personalized pagerank spreads activation through the link graph",
    ],
  },
  {
    title: "episodic retrieval captures temporal context that semantic search misses",
    type: "learning",
    project: ["ai-agents"],
    description: "Time-ordered access patterns reveal session context that vector similarity cannot encode",
    body: `When a user asks "what did we decide last week about the token model," semantic search finds notes about tokens
but cannot rank by temporal proximity to "last week." Episodic retrieval tracks access timestamps and session
boundaries, letting the system answer temporal queries accurately.
This is why [[agent memory requires both episodic and semantic retrieval]].
Temporal signals include: creation date, last accessed, access frequency, session membership.
These feed into the vitality model which gives recently-active notes a boost.
Related: [[vitality decay models how quickly notes fade from working memory]].`,
    links: [
      "agent memory requires both episodic and semantic retrieval",
      "vitality decay models how quickly notes fade from working memory",
    ],
  },
  {
    title: "BM25 keyword search provides exact term matching that embeddings miss",
    type: "learning",
    project: ["ai-agents"],
    description: "Keyword search excels at proper nouns, technical terms, and exact phrases where vector similarity fails",
    body: `Embedding models map text to dense vectors capturing semantic meaning, but they compress away exact tokens.
Searching for "CourtShare" via embeddings might return notes about basketball apps in general but miss the
specific project name. BM25 with title and description boosting catches these exact matches.
The retrieval pipeline uses BM25 as one signal alongside composite embedding search and graph signals.
This complements [[agent memory requires both episodic and semantic retrieval]] — BM25 handles the
lexical signal while embeddings handle the semantic signal.
Configuration: k1=1.2, b=0.75, title_boost=3.0, description_boost=2.0.`,
    links: [
      "agent memory requires both episodic and semantic retrieval",
    ],
  },
  {
    title: "personalized pagerank spreads activation through the link graph",
    type: "learning",
    project: ["ai-agents"],
    description: "PPR seeds from BM25 hits and walks the graph to surface structurally connected notes",
    body: `Personalized PageRank starts with seed nodes (the top BM25 or embedding hits) and iteratively spreads
activation along wiki-link edges. Notes that are well-connected to the seed set get elevated even if they
don't directly match the query text.
This is the graph signal in the three-signal retrieval pipeline:
1. Composite embedding search (semantic similarity)
2. BM25 keyword search (lexical matching)
3. Personalized PageRank (structural proximity)
All three are fused via score-weighted reciprocal rank fusion (RRF).
See [[score weighted RRF outperforms simple rank fusion for heterogeneous signals]].
Links: [[agent memory requires both episodic and semantic retrieval]].`,
    links: [
      "score weighted RRF outperforms simple rank fusion for heterogeneous signals",
      "agent memory requires both episodic and semantic retrieval",
    ],
  },
  {
    title: "score weighted RRF outperforms simple rank fusion for heterogeneous signals",
    type: "decision",
    project: ["ai-agents"],
    description: "Multiplying raw scores by signal weights before RRF respects the magnitude of each signal",
    body: `Standard RRF treats all signals equally — a #1 rank in BM25 contributes the same as #1 in embedding search.
But these signals have different reliability profiles. Score-weighted RRF multiplies each signal's raw score
by a configurable weight before applying the 1/(k+rank) formula.
Default weights: composite=2.0, keyword=1.0, graph=1.5.
This means a high-confidence embedding match contributes more than a moderate keyword match at the same rank.
The decision was made after testing on synthetic queries where cross-project notes were consistently missed
by uniform RRF but surfaced correctly with weighted RRF.
See [[personalized pagerank spreads activation through the link graph]] for the graph signal.`,
    links: [
      "personalized pagerank spreads activation through the link graph",
    ],
  },
  // Vitality cluster
  {
    title: "vitality decay models how quickly notes fade from working memory",
    type: "insight",
    project: ["ai-agents"],
    description: "ACT-R inspired decay gives recently accessed notes higher retrieval priority",
    body: `The vitality model borrows from ACT-R cognitive architecture: notes that are accessed more frequently and
more recently have higher activation levels. The base formula is:
  B_i = ln(n / (1 - d)) - d * ln(L)
where n = access count, d = decay parameter (0.5), L = lifetime in days.
This feeds into the composite search as the vitality space weight.
Structural stability from incoming links slows decay — well-connected notes persist longer.
Bridge notes (articulation points in the graph) get a vitality floor to prevent critical connectors from fading.
Related: [[episodic retrieval captures temporal context that semantic search misses]].
See also [[bridge notes connect communities and resist vitality decay]].`,
    links: [
      "episodic retrieval captures temporal context that semantic search misses",
      "bridge notes connect communities and resist vitality decay",
    ],
  },
  {
    title: "bridge notes connect communities and resist vitality decay",
    type: "insight",
    project: ["ai-agents", "crypto"],
    description: "Articulation points in the knowledge graph get protected vitality floors to maintain cross-domain paths",
    body: `Some notes serve as bridges between otherwise disconnected clusters — connecting the crypto project to
CourtShare, or linking AI agent architecture to Discord bot implementation. These bridge notes are identified
by Tarjan's algorithm (articulation points) and high betweenness centrality.
Losing a bridge note would disconnect communities, so they receive a vitality floor of 0.5 regardless of
access patterns. This prevents important structural connectors from decaying into obscurity.
The bridge detection also catches: map notes, high-degree hubs, cross-project connectors.
Related: [[vitality decay models how quickly notes fade from working memory]].
Also: [[cross project connections multiply the value of both domains]].`,
    links: [
      "vitality decay models how quickly notes fade from working memory",
      "cross project connections multiply the value of both domains",
    ],
  },
  // Crypto cluster
  {
    title: "kashi token needs real utility beyond trading to drive adoption",
    type: "idea",
    project: ["crypto"],
    description: "Token must solve actual user problems in CourtShare and Discord ecosystems to avoid speculative-only demand",
    body: `A token with no utility beyond buy/sell is just gambling. Kashi needs to plug into real actions:
- CourtShare: stake tokens to boost court reservations, earn tokens for engagement
- Discord: tip tokens for helpful answers, stake for premium features
- Agent team: pay for priority processing, earn for contribution
The [[courtshare engagement could use kashi token incentives]] connection is key — if we tie tokens to
basketball court booking, there's genuine demand beyond speculation.
Without utility, [[fake money is not sticky because users have nothing to lose]].`,
    links: [
      "courtshare engagement could use kashi token incentives",
      "fake money is not sticky because users have nothing to lose",
    ],
  },
  {
    title: "fake money is not sticky because users have nothing to lose",
    type: "learning",
    project: ["crypto", "courtshare"],
    description: "Virtual currency without real value creates no loss aversion and users churn quickly",
    body: `CourtShare originally used a fake point system for engagement. Users earned points for booking courts,
leaving reviews, inviting friends. But churn was high because points had no real value — losing them
felt like nothing. Behavioral economics shows loss aversion only kicks in when stakes are real.
This is why [[kashi token needs real utility beyond trading to drive adoption]] — the token must have
genuine value (redeemable for real benefits) to create the loss aversion that drives retention.
Related: [[courtshare engagement could use kashi token incentives]].`,
    links: [
      "kashi token needs real utility beyond trading to drive adoption",
      "courtshare engagement could use kashi token incentives",
    ],
  },
  {
    title: "courtshare engagement could use kashi token incentives",
    type: "opportunity",
    project: ["courtshare", "crypto"],
    description: "Integrating Kashi tokens into CourtShare creates genuine token demand and solves the engagement churn problem",
    body: `Cross-project opportunity: CourtShare needs better engagement mechanics and Kashi needs real utility.
Combining them: users earn Kashi tokens for court bookings, reviews, and community contributions.
Tokens can be spent on premium court time slots, priority booking, or transferred to other platforms.
This creates a flywheel: CourtShare usage drives token demand, token value drives CourtShare engagement.
See [[fake money is not sticky because users have nothing to lose]] for why the old point system failed.
See [[kashi token needs real utility beyond trading to drive adoption]] for the token side.
Also connects to [[cross project connections multiply the value of both domains]].`,
    links: [
      "fake money is not sticky because users have nothing to lose",
      "kashi token needs real utility beyond trading to drive adoption",
      "cross project connections multiply the value of both domains",
    ],
  },
  // Cross-domain connections
  {
    title: "cross project connections multiply the value of both domains",
    type: "insight",
    project: ["ai-agents", "crypto", "courtshare"],
    description: "Notes linking two projects create compounding value that isolated domain knowledge cannot match",
    body: `The highest-value notes in the vault are the ones that bridge projects. A crypto insight that solves a
CourtShare problem is worth more than either insight alone. An AI memory pattern that improves the
Discord agent is a force multiplier.
The knowledge graph makes this explicit through wiki-links and multi-project tags. The retrieval system
surfaces these connections through community detection (Louvain) and bridge note identification.
Examples: [[courtshare engagement could use kashi token incentives]] bridges crypto and CourtShare.
[[bridge notes connect communities and resist vitality decay]] bridges AI agents and crypto.`,
    links: [
      "courtshare engagement could use kashi token incentives",
      "bridge notes connect communities and resist vitality decay",
    ],
  },
  // Basketball / CourtShare cluster
  {
    title: "basketball court availability data needs real time API integration",
    type: "blocker",
    project: ["courtshare"],
    description: "Static scraping breaks when facilities change schedules; need push-based or polling API",
    body: `CourtShare currently scrapes court schedules from recreation center websites. This breaks constantly
because the HTML structure changes, schedules are published as PDFs, and some facilities have no online
presence at all.
The solution is partnering with facilities for API access or building a polling system that checks
schedules every 15 minutes and diffs against the last known state.
This blocks the real-time booking feature which is critical for [[courtshare engagement could use kashi token incentives]].
Without accurate availability data, users book phantom courts and churn.`,
    links: [
      "courtshare engagement could use kashi token incentives",
    ],
  },
  {
    title: "discord agent team uses channel to agent binding for routing",
    type: "decision",
    project: ["ai-agents"],
    description: "Each Discord channel maps to one specialist agent, with a router agent handling cross-channel queries",
    body: `The OpenClaw Discord bot uses a multi-agent architecture where each channel has a dedicated specialist:
#crypto -> Kashi agent, #courtshare -> CourtShare agent, #general -> Router agent.
The router agent classifies incoming messages and delegates to specialists. This avoids context pollution
where crypto conversations leak into CourtShare responses.
The binding is configured in a channel_map.yaml, not hardcoded. Adding a new specialist means adding a
channel and a config entry.
Related: [[agent memory requires both episodic and semantic retrieval]] — each specialist needs its own
memory context.`,
    links: [
      "agent memory requires both episodic and semantic retrieval",
    ],
  },
  {
    title: "louvain community detection groups topically related notes automatically",
    type: "learning",
    project: ["ai-agents"],
    description: "The Louvain algorithm partitions the knowledge graph into clusters without manual topic assignment",
    body: `Running Louvain on the undirected wiki-link graph produces communities that closely match project boundaries.
Crypto notes cluster together, CourtShare notes cluster together, and cross-project notes end up at
community boundaries.
These community assignments feed into the composite embedding search as a community similarity signal.
Notes in the same community get a slight boost when queried from that community's context.
Related: [[personalized pagerank spreads activation through the link graph]] — PPR and community detection
are complementary graph signals.
See also [[cross project connections multiply the value of both domains]].`,
    links: [
      "personalized pagerank spreads activation through the link graph",
      "cross project connections multiply the value of both domains",
    ],
  },
  {
    title: "chose YAML frontmatter over JSON for note metadata",
    type: "decision",
    project: ["ai-agents"],
    description: "YAML is more readable for humans editing notes directly and parses cleanly with the yaml library",
    body: `Decision: use YAML frontmatter (delimited by ---) for note metadata instead of JSON blocks or
inline key-value pairs. Rationale:
- YAML is more readable when editing notes in a text editor
- The yaml npm package handles parsing reliably
- Obsidian and other tools already use this convention
- Arrays (project tags) are cleaner in YAML than JSON
Alternative considered: JSON frontmatter — rejected because it's harder to read and edit by hand.
Alternative considered: inline metadata (tags in body) — rejected because it's harder to query programmatically.`,
    links: [],
  },
  {
    title: "piecewise linear encoding preserves ordering for scalar features",
    type: "learning",
    project: ["ai-agents"],
    description: "Encoding vitality and importance as thermometer vectors maintains ordinal relationships in cosine similarity",
    body: `Scalar values like vitality (0-1) and importance (PageRank score) need to be encoded as vectors for the
composite embedding space. One-hot binning loses ordering (bin 3 is not "more" than bin 1 in cosine space).
Piecewise linear encoding fills bins progressively: value 0.6 with 8 bins fills bins 0-3 fully and bin 4
partially. This means cosine similarity between two thermometer vectors reflects the distance between the
original scalar values.
This is used for temporal, vitality, and importance spaces in the 6-space composite search.
Related: [[score weighted RRF outperforms simple rank fusion for heterogeneous signals]].`,
    links: [
      "score weighted RRF outperforms simple rank fusion for heterogeneous signals",
    ],
  },
  // Map notes (navigation)
  {
    title: "ai agents map",
    type: "insight",
    project: ["ai-agents"],
    description: "Map of Content for AI agent architecture, memory systems, and Discord bot implementation",
    body: `# AI Agents Map

## Memory & Retrieval
- [[agent memory requires both episodic and semantic retrieval]]
- [[episodic retrieval captures temporal context that semantic search misses]]
- [[BM25 keyword search provides exact term matching that embeddings miss]]
- [[personalized pagerank spreads activation through the link graph]]
- [[score weighted RRF outperforms simple rank fusion for heterogeneous signals]]
- [[vitality decay models how quickly notes fade from working memory]]
- [[piecewise linear encoding preserves ordering for scalar features]]

## Graph Intelligence
- [[bridge notes connect communities and resist vitality decay]]
- [[louvain community detection groups topically related notes automatically]]

## Architecture
- [[discord agent team uses channel to agent binding for routing]]
- [[chose YAML frontmatter over JSON for note metadata]]

## Cross-Project
- [[cross project connections multiply the value of both domains]]`,
    links: [
      "agent memory requires both episodic and semantic retrieval",
      "episodic retrieval captures temporal context that semantic search misses",
      "BM25 keyword search provides exact term matching that embeddings miss",
      "personalized pagerank spreads activation through the link graph",
      "score weighted RRF outperforms simple rank fusion for heterogeneous signals",
      "vitality decay models how quickly notes fade from working memory",
      "piecewise linear encoding preserves ordering for scalar features",
      "bridge notes connect communities and resist vitality decay",
      "louvain community detection groups topically related notes automatically",
      "discord agent team uses channel to agent binding for routing",
      "chose YAML frontmatter over JSON for note metadata",
      "cross project connections multiply the value of both domains",
    ],
  },
  {
    title: "crypto map",
    type: "insight",
    project: ["crypto"],
    description: "Map of Content for Kashi cryptocurrency token design and tokenomics",
    body: `# Crypto Map

## Tokenomics
- [[kashi token needs real utility beyond trading to drive adoption]]
- [[fake money is not sticky because users have nothing to lose]]

## Cross-Project
- [[courtshare engagement could use kashi token incentives]]
- [[cross project connections multiply the value of both domains]]
- [[bridge notes connect communities and resist vitality decay]]`,
    links: [
      "kashi token needs real utility beyond trading to drive adoption",
      "fake money is not sticky because users have nothing to lose",
      "courtshare engagement could use kashi token incentives",
      "cross project connections multiply the value of both domains",
      "bridge notes connect communities and resist vitality decay",
    ],
  },
];

const SYNTHETIC_QUERIES: TestQuery[] = [
  {
    query: "how does agent memory handle temporal context",
    expectedRelevant: [
      "agent memory requires both episodic and semantic retrieval",
      "episodic retrieval captures temporal context that semantic search misses",
      "vitality decay models how quickly notes fade from working memory",
    ],
    intent: "semantic",
  },
  {
    query: "what is BM25 and why do we use keyword search",
    expectedRelevant: [
      "BM25 keyword search provides exact term matching that embeddings miss",
      "agent memory requires both episodic and semantic retrieval",
    ],
    intent: "semantic",
  },
  {
    query: "how does personalized pagerank work in retrieval",
    expectedRelevant: [
      "personalized pagerank spreads activation through the link graph",
      "agent memory requires both episodic and semantic retrieval",
      "louvain community detection groups topically related notes automatically",
    ],
    intent: "procedural",
  },
  {
    query: "why did we choose score weighted RRF over simple fusion",
    expectedRelevant: [
      "score weighted RRF outperforms simple rank fusion for heterogeneous signals",
      "personalized pagerank spreads activation through the link graph",
    ],
    intent: "decision",
  },
  {
    query: "how can kashi tokens improve courtshare engagement",
    expectedRelevant: [
      "courtshare engagement could use kashi token incentives",
      "kashi token needs real utility beyond trading to drive adoption",
      "fake money is not sticky because users have nothing to lose",
    ],
    intent: "semantic",
  },
  {
    query: "why did the fake point system fail for user retention",
    expectedRelevant: [
      "fake money is not sticky because users have nothing to lose",
      "courtshare engagement could use kashi token incentives",
      "kashi token needs real utility beyond trading to drive adoption",
    ],
    intent: "semantic",
  },
  {
    query: "what are bridge notes and why do they matter",
    expectedRelevant: [
      "bridge notes connect communities and resist vitality decay",
      "cross project connections multiply the value of both domains",
      "vitality decay models how quickly notes fade from working memory",
    ],
    intent: "semantic",
  },
  {
    query: "how does vitality decay work for notes",
    expectedRelevant: [
      "vitality decay models how quickly notes fade from working memory",
      "bridge notes connect communities and resist vitality decay",
      "episodic retrieval captures temporal context that semantic search misses",
    ],
    intent: "procedural",
  },
  {
    query: "what connects crypto and courtshare projects",
    expectedRelevant: [
      "courtshare engagement could use kashi token incentives",
      "cross project connections multiply the value of both domains",
      "fake money is not sticky because users have nothing to lose",
      "kashi token needs real utility beyond trading to drive adoption",
    ],
    intent: "semantic",
  },
  {
    query: "how does the discord bot route messages to agents",
    expectedRelevant: [
      "discord agent team uses channel to agent binding for routing",
      "agent memory requires both episodic and semantic retrieval",
    ],
    intent: "procedural",
  },
  {
    query: "what blocks the real time court booking feature",
    expectedRelevant: [
      "basketball court availability data needs real time API integration",
      "courtshare engagement could use kashi token incentives",
    ],
    intent: "semantic",
  },
  {
    query: "how are communities detected in the knowledge graph",
    expectedRelevant: [
      "louvain community detection groups topically related notes automatically",
      "personalized pagerank spreads activation through the link graph",
      "cross project connections multiply the value of both domains",
    ],
    intent: "semantic",
  },
];

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function precision(retrieved: string[], relevant: string[]): number {
  const relevantSet = new Set(relevant);
  const hits = retrieved.filter((t) => relevantSet.has(t));
  return retrieved.length > 0 ? hits.length / retrieved.length : 0;
}

function recall(retrieved: string[], relevant: string[]): number {
  const retrievedSet = new Set(retrieved);
  const hits = relevant.filter((t) => retrievedSet.has(t));
  return relevant.length > 0 ? hits.length / relevant.length : 0;
}

function f1(p: number, r: number): number {
  return p + r > 0 ? (2 * p * r) / (p + r) : 0;
}

/**
 * Mean Reciprocal Rank — 1/rank of the first relevant result.
 */
function mrr(retrieved: string[], relevant: string[]): number {
  const relevantSet = new Set(relevant);
  for (let i = 0; i < retrieved.length; i++) {
    if (relevantSet.has(retrieved[i])) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Vault Setup
// ---------------------------------------------------------------------------

async function createTempVault(notes: SyntheticNote[]): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ori-locomo-"));
  const notesDir = path.join(tmpDir, "notes");
  const oriDir = path.join(tmpDir, ".ori");
  const templatesDir = path.join(tmpDir, "templates");

  await fs.mkdir(notesDir, { recursive: true });
  await fs.mkdir(oriDir, { recursive: true });
  await fs.mkdir(templatesDir, { recursive: true });

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
      type: note.type,
      project: note.project,
      status: "active",
      created: "2026-02-20",
    };
    const content = stringifyFrontmatter(frontmatter, "\n" + note.body + "\n");
    await fs.writeFile(path.join(notesDir, `${note.title}.md`), content, "utf-8");
  }

  return tmpDir;
}

async function cleanupVault(vaultRoot: string): Promise<void> {
  try {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  } catch {
    // Best effort cleanup
  }
}

// ---------------------------------------------------------------------------
// Retrieval Pipeline
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

async function buildPipeline(
  vaultRoot: string,
  useEmbeddings: boolean,
): Promise<PipelineState> {
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

  // Build graph
  const linkGraph = await buildGraph(notesDir);
  const graphMetrics = computeGraphMetrics(linkGraph);

  // List all titles
  const entries = await fs.readdir(notesDir);
  const allTitles = entries
    .filter((e) => e.endsWith(".md"))
    .map((e) => e.replace(/\.md$/, ""));

  // Build BM25 index
  const docs: Array<{ title: string; description: string; body: string }> = [];
  for (const title of allTitles) {
    const content = await fs.readFile(path.join(notesDir, `${title}.md`), "utf-8");
    // Simple frontmatter extraction
    const lines = content.split("\n");
    let bodyStart = 0;
    if (lines[0] === "---") {
      for (let i = 1; i < lines.length; i++) {
        if (lines[i] === "---") {
          bodyStart = i + 1;
          break;
        }
      }
    }
    const body = lines.slice(bodyStart).join("\n");

    // Extract description from frontmatter
    const descMatch = content.match(/^description:\s*(.+)$/m);
    const description = descMatch ? descMatch[1].trim().replace(/^["']|["']$/g, "") : "";

    docs.push({ title, description, body });
  }
  const bm25Index = buildBM25Index(docs, config.bm25);

  // Attempt embedding index
  let embeddingsAvailable = false;
  if (useEmbeddings) {
    try {
      const engine = await import("../src/core/engine.js");
      buildIndex = engine.buildIndex;
      initDB = engine.initDB;
      loadVectors = engine.loadVectors;
      searchComposite = engine.searchComposite;

      console.log("  Building embedding index (model will auto-download if needed)...");
      const stats = await buildIndex(vaultRoot, config.engine, { force: true });
      console.log(`  Indexed ${stats.indexed} notes in ${stats.durationMs}ms (model: ${stats.model})`);
      embeddingsAvailable = true;
    } catch (err) {
      console.log(`  Embedding index unavailable: ${(err as Error).message}`);
      console.log("  Falling back to BM25 + graph signals only.");
    }
  }

  return {
    vaultRoot,
    config,
    linkGraph,
    graphMetrics,
    bm25Index,
    allTitles,
    embeddingsAvailable,
  };
}

type SignalMask = {
  composite: boolean;
  keyword: boolean;
  graph: boolean;
};

const ALL_SIGNALS: SignalMask = { composite: true, keyword: true, graph: true };

async function runQuery(
  pipeline: PipelineState,
  query: string,
  topK: number,
  mask: SignalMask = ALL_SIGNALS,
): Promise<string[]> {
  const { config, linkGraph, graphMetrics, bm25Index, allTitles, embeddingsAvailable, vaultRoot } =
    pipeline;

  // 1. Classify intent
  const classified: ClassifiedQuery = classifyIntent(query, allTitles);

  // 2. BM25 search
  const candidateLimit = topK * config.retrieval.candidate_multiplier;
  const bm25Results = mask.keyword
    ? searchBM25(query, bm25Index, config.bm25, candidateLimit)
    : [];

  // 3. Graph signal: PPR seeded from BM25 top hits
  let graphResults: ScoredNote[] = [];
  if (mask.graph) {
    const seeds = bm25Results.length > 0
      ? bm25Results.slice(0, 3).map((r) => r.title)
      : allTitles.slice(0, 3); // fallback seeds if BM25 disabled
    const graphologyGraph = buildGraphologyGraph(linkGraph);
    const pprScores = personalizedPageRank(graphologyGraph, seeds, 0.85, 20);
    graphResults = rankByImportance(allTitles, pprScores, candidateLimit);
  }

  // 4. Composite embedding search (if available)
  let compositeResults: ScoredNote[] = [];
  if (mask.composite && embeddingsAvailable && searchComposite && initDB && loadVectors) {
    try {
      const dbPath = path.resolve(vaultRoot, config.engine.db_path);
      const db = initDB(dbPath);
      const storedVectors = loadVectors(db);
      db.close();

      // Compute vitality scores (simplified — uniform for benchmark)
      const vitalityScores = new Map<string, number>();
      for (const title of allTitles) {
        vitalityScores.set(title, 0.7); // Uniform baseline for benchmark
      }

      compositeResults = await searchComposite({
        queryText: query,
        intent: classified,
        storedVectors,
        graphMetrics,
        vitalityScores,
        limit: candidateLimit,
        config: config.engine,
      });
    } catch {
      // Embedding search failed — continue without it
    }
  }

  // 5. Fuse signals
  const signals: SignalResults = {
    composite: compositeResults,
    keyword: bm25Results,
    graph: graphResults,
  };

  const fused = fuseScoreWeightedRRF(signals, config.retrieval);

  // 6. Return top-K titles
  return fused.slice(0, topK).map((r) => r.title);
}

// ---------------------------------------------------------------------------
// External Data Loader
// ---------------------------------------------------------------------------

interface ExternalData {
  notes: SyntheticNote[];
  queries: TestQuery[];
}

async function loadExternalData(dataPath: string): Promise<ExternalData> {
  const content = await fs.readFile(dataPath, "utf-8");
  const data = JSON.parse(content) as ExternalData;
  if (!Array.isArray(data.notes) || !Array.isArray(data.queries)) {
    throw new Error("External data must have 'notes' and 'queries' arrays");
  }
  return data;
}

// ---------------------------------------------------------------------------
// CLI Arg Parsing
// ---------------------------------------------------------------------------

interface BenchArgs {
  dataPath: string | null;
  topK: number;
  useEmbeddings: boolean;
  ablation: boolean;
  jsonOutput: boolean;
}

function parseArgs(): BenchArgs {
  const args = process.argv.slice(2);
  let dataPath: string | null = null;
  let topK = 5;
  let useEmbeddings = true;
  let ablation = false;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--data" && i + 1 < args.length) {
      dataPath = args[++i];
    } else if (args[i] === "--k" && i + 1 < args.length) {
      topK = parseInt(args[++i], 10);
    } else if (args[i] === "--no-embeddings") {
      useEmbeddings = false;
    } else if (args[i] === "--ablation") {
      ablation = true;
    } else if (args[i] === "--json") {
      jsonOutput = true;
    }
  }

  return { dataPath, topK, useEmbeddings, ablation, jsonOutput };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

interface QueryResult {
  query: string;
  intent: string;
  classifiedIntent: string;
  retrieved: string[];
  expected: string[];
  precision: number;
  recall: number;
  f1: number;
  mrr: number;
}

interface AblationResult {
  config: string;
  mask: SignalMask;
  meanPrecision: number;
  meanRecall: number;
  meanF1: number;
  meanMRR: number;
  perQuery: QueryResult[];
}

function printAblationTable(ablationResults: AblationResult[], topK: number): void {
  const divider = "=".repeat(80);

  console.log("\n" + divider);
  console.log("  SIGNAL ABLATION COMPARISON");
  console.log(`  Top-K: ${topK}`);
  console.log(divider + "\n");

  // Header
  const header = [
    "Config".padEnd(30),
    "P@K".padStart(8),
    "R@K".padStart(8),
    "F1@K".padStart(8),
    "MRR".padStart(8),
  ].join("  ");
  console.log("  " + header);
  console.log("  " + "-".repeat(header.length));

  for (const ar of ablationResults) {
    const row = [
      ar.config.padEnd(30),
      ar.meanPrecision.toFixed(4).padStart(8),
      ar.meanRecall.toFixed(4).padStart(8),
      ar.meanF1.toFixed(4).padStart(8),
      ar.meanMRR.toFixed(4).padStart(8),
    ].join("  ");
    console.log("  " + row);
  }

  // Find best config
  const best = ablationResults.reduce((a, b) => (a.meanF1 > b.meanF1 ? a : b));
  console.log(`\n  Best config: ${best.config} (F1=${best.meanF1.toFixed(4)})`);

  // Show delta from full pipeline
  const full = ablationResults.find((r) => r.config.includes("Full"));
  if (full && full !== best) {
    const delta = best.meanF1 - full.meanF1;
    console.log(`  Full pipeline delta: ${delta > 0 ? "+" : ""}${delta.toFixed(4)}`);
  }
  console.log("");
}

function printResults(results: QueryResult[], embeddingsUsed: boolean, topK: number): void {
  const divider = "=".repeat(80);
  const thinDivider = "-".repeat(80);

  console.log("\n" + divider);
  console.log("  LOCOMO BENCHMARK RESULTS");
  console.log(`  Mode: ${embeddingsUsed ? "BM25 + Embeddings + Graph" : "BM25 + Graph (no embeddings)"}`);
  console.log(`  Top-K: ${topK}`);
  console.log(`  Queries: ${results.length}`);
  console.log(divider + "\n");

  for (const r of results) {
    const intentMatch = r.intent === r.classifiedIntent ? "OK" : `MISMATCH(${r.classifiedIntent})`;
    console.log(`  Query: "${r.query}"`);
    console.log(`  Intent: ${r.intent} [${intentMatch}]`);
    console.log(`  Retrieved: ${r.retrieved.length > 0 ? "" : "(none)"}`);
    for (const t of r.retrieved) {
      const hit = r.expected.includes(t) ? " HIT" : "    ";
      console.log(`    ${hit} ${t}`);
    }
    console.log(`  Expected: ${r.expected.join(", ").substring(0, 120)}`);
    console.log(`  P=${r.precision.toFixed(3)}  R=${r.recall.toFixed(3)}  F1=${r.f1.toFixed(3)}  MRR=${r.mrr.toFixed(3)}`);
    console.log(thinDivider);
  }

  // Aggregates
  const meanP = results.reduce((s, r) => s + r.precision, 0) / results.length;
  const meanR = results.reduce((s, r) => s + r.recall, 0) / results.length;
  const meanF1 = results.reduce((s, r) => s + r.f1, 0) / results.length;
  const meanMRR = results.reduce((s, r) => s + r.mrr, 0) / results.length;

  console.log("\n" + divider);
  console.log("  AGGREGATE METRICS");
  console.log(divider);
  console.log(`  Mean Precision@${topK}:  ${meanP.toFixed(4)}`);
  console.log(`  Mean Recall@${topK}:     ${meanR.toFixed(4)}`);
  console.log(`  Mean F1@${topK}:         ${meanF1.toFixed(4)}`);
  console.log(`  Mean MRR:            ${meanMRR.toFixed(4)}`);
  console.log(divider + "\n");

  // Pass/fail heuristic
  if (meanF1 >= 0.5) {
    console.log("  PASS: Mean F1 >= 0.50");
  } else if (meanF1 >= 0.3) {
    console.log("  MARGINAL: Mean F1 in [0.30, 0.50) — room for improvement");
  } else {
    console.log("  FAIL: Mean F1 < 0.30 — retrieval quality needs work");
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();
  const startTime = Date.now();

  console.log("LOCOMO Benchmark — Ori Mnemos v0.3");
  console.log("===================================\n");

  // Load data
  let notes: SyntheticNote[];
  let queries: TestQuery[];

  if (args.dataPath) {
    console.log(`Loading external data from ${args.dataPath}...`);
    const data = await loadExternalData(args.dataPath);
    notes = data.notes;
    queries = data.queries;
    console.log(`  Loaded ${notes.length} notes, ${queries.length} queries.`);
  } else {
    console.log("Using synthetic test data...");
    notes = SYNTHETIC_NOTES;
    queries = SYNTHETIC_QUERIES;
    console.log(`  ${notes.length} notes, ${queries.length} queries.`);
  }

  // Create vault
  console.log("\nSetting up temporary vault...");
  const vaultRoot = await createTempVault(notes);
  console.log(`  Vault created at: ${vaultRoot}`);

  try {
    // Build pipeline
    console.log("\nBuilding retrieval pipeline...");
    const pipeline = await buildPipeline(vaultRoot, args.useEmbeddings);
    console.log(`  Graph: ${pipeline.allTitles.length} notes, ${pipeline.graphMetrics.communityStats.size} communities`);
    console.log(`  Bridges: ${pipeline.graphMetrics.bridges.size} bridge notes`);
    console.log(`  Embeddings: ${pipeline.embeddingsAvailable ? "YES" : "NO (BM25 + graph only)"}`);

    if (args.ablation) {
      // ----- ABLATION MODE -----
      const configs: Array<{ name: string; mask: SignalMask }> = [
        { name: "Full 3-signal", mask: { composite: true, keyword: true, graph: true } },
        { name: "Vector only", mask: { composite: true, keyword: false, graph: false } },
        { name: "BM25 only", mask: { composite: false, keyword: true, graph: false } },
        { name: "Graph only", mask: { composite: false, keyword: false, graph: true } },
        { name: "Vector + BM25", mask: { composite: true, keyword: true, graph: false } },
        { name: "Vector + Graph", mask: { composite: true, keyword: false, graph: true } },
        { name: "BM25 + Graph", mask: { composite: false, keyword: true, graph: true } },
      ];

      const ablationResults: AblationResult[] = [];

      for (const cfg of configs) {
        // Skip vector configs if embeddings unavailable
        if (cfg.mask.composite && !pipeline.embeddingsAvailable) {
          console.log(`\n  Skipping "${cfg.name}" (embeddings unavailable)`);
          continue;
        }

        console.log(`\n  Running "${cfg.name}"...`);
        const perQuery: QueryResult[] = [];

        for (const tq of queries) {
          const retrieved = await runQuery(pipeline, tq.query, args.topK, cfg.mask);
          const classified = classifyIntent(tq.query, pipeline.allTitles);

          const p = precision(retrieved, tq.expectedRelevant);
          const r = recall(retrieved, tq.expectedRelevant);
          const f = f1(p, r);
          const m = mrr(retrieved, tq.expectedRelevant);

          perQuery.push({
            query: tq.query,
            intent: tq.intent,
            classifiedIntent: classified.intent,
            retrieved,
            expected: tq.expectedRelevant,
            precision: p,
            recall: r,
            f1: f,
            mrr: m,
          });
        }

        const meanP = perQuery.reduce((s, r) => s + r.precision, 0) / perQuery.length;
        const meanR = perQuery.reduce((s, r) => s + r.recall, 0) / perQuery.length;
        const meanF = perQuery.reduce((s, r) => s + r.f1, 0) / perQuery.length;
        const meanM = perQuery.reduce((s, r) => s + r.mrr, 0) / perQuery.length;

        ablationResults.push({
          config: cfg.name,
          mask: cfg.mask,
          meanPrecision: meanP,
          meanRecall: meanR,
          meanF1: meanF,
          meanMRR: meanM,
          perQuery,
        });
      }

      printAblationTable(ablationResults, args.topK);

      // JSON output
      if (args.jsonOutput) {
        const resultsDir = path.join(path.dirname(import.meta.dirname ?? "."), "bench", "results");
        await fs.mkdir(resultsDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const outputPath = path.join(resultsDir, `ablation-${timestamp}.json`);
        const output = {
          timestamp: new Date().toISOString(),
          topK: args.topK,
          noteCount: notes.length,
          queryCount: queries.length,
          embeddingsAvailable: pipeline.embeddingsAvailable,
          results: ablationResults.map((ar) => ({
            config: ar.config,
            mask: ar.mask,
            meanPrecision: ar.meanPrecision,
            meanRecall: ar.meanRecall,
            meanF1: ar.meanF1,
            meanMRR: ar.meanMRR,
            perQuery: ar.perQuery.map((q) => ({
              query: q.query,
              precision: q.precision,
              recall: q.recall,
              f1: q.f1,
              mrr: q.mrr,
            })),
          })),
        };
        await fs.writeFile(outputPath, JSON.stringify(output, null, 2), "utf-8");
        console.log(`  Results saved to: ${outputPath}`);
      }
    } else {
      // ----- STANDARD MODE -----
      console.log(`\nRunning ${queries.length} queries (top-${args.topK})...`);
      const results: QueryResult[] = [];

      for (const tq of queries) {
        const retrieved = await runQuery(pipeline, tq.query, args.topK);
        const classified = classifyIntent(tq.query, pipeline.allTitles);

        const p = precision(retrieved, tq.expectedRelevant);
        const r = recall(retrieved, tq.expectedRelevant);
        const f = f1(p, r);
        const m = mrr(retrieved, tq.expectedRelevant);

        results.push({
          query: tq.query,
          intent: tq.intent,
          classifiedIntent: classified.intent,
          retrieved,
          expected: tq.expectedRelevant,
          precision: p,
          recall: r,
          f1: f,
          mrr: m,
        });
      }

      printResults(results, pipeline.embeddingsAvailable, args.topK);

      // JSON output in standard mode too
      if (args.jsonOutput) {
        const resultsDir = path.join(path.dirname(import.meta.dirname ?? "."), "bench", "results");
        await fs.mkdir(resultsDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const outputPath = path.join(resultsDir, `locomo-${timestamp}.json`);
        const meanP = results.reduce((s, r) => s + r.precision, 0) / results.length;
        const meanR = results.reduce((s, r) => s + r.recall, 0) / results.length;
        const meanF = results.reduce((s, r) => s + r.f1, 0) / results.length;
        const meanM = results.reduce((s, r) => s + r.mrr, 0) / results.length;
        const output = {
          timestamp: new Date().toISOString(),
          topK: args.topK,
          noteCount: notes.length,
          queryCount: queries.length,
          embeddingsAvailable: pipeline.embeddingsAvailable,
          aggregate: { meanPrecision: meanP, meanRecall: meanR, meanF1: meanF, meanMRR: meanM },
          perQuery: results.map((q) => ({
            query: q.query,
            precision: q.precision,
            recall: q.recall,
            f1: q.f1,
            mrr: q.mrr,
          })),
        };
        await fs.writeFile(outputPath, JSON.stringify(output, null, 2), "utf-8");
        console.log(`  Results saved to: ${outputPath}`);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Total time: ${elapsed}s`);
  } finally {
    // Cleanup
    console.log("Cleaning up temporary vault...");
    await cleanupVault(vaultRoot);
    console.log("Done.");
  }
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
