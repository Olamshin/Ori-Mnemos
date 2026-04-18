#!/usr/bin/env npx tsx
/**
 * Cross-Domain Retrieval Benchmark for Ori Mnemos v0.3
 *
 * Tests the core thesis: multi-project notes surface correctly when queried
 * from either domain. 20 notes across 4 project clusters, 10 queries
 * targeting cross-domain connections.
 *
 * Usage:
 *   npx tsx bench/cross-domain.ts                   # Run benchmark
 *   npx tsx bench/cross-domain.ts --no-embeddings   # BM25 + graph only
 *   npx tsx bench/cross-domain.ts --json            # Save JSON results
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

let buildIndex: typeof import("../src/core/engine.js")["buildIndex"] | null = null;
let initDB: typeof import("../src/core/engine.js")["initDB"] | null = null;
let loadVectors: typeof import("../src/core/engine.js")["loadVectors"] | null = null;
let searchComposite: typeof import("../src/core/engine.js")["searchComposite"] | null = null;

// ---------------------------------------------------------------------------
// Cross-Domain Test Data: 4 clusters with bridge notes
// ---------------------------------------------------------------------------

interface Note {
  title: string;
  type: string;
  project: string[];
  description: string;
  body: string;
  links: string[];
}

interface Query {
  query: string;
  expectedRelevant: string[];
  crossDomain: boolean; // true if the query targets cross-project notes
  description: string;  // what this query tests
}

// Cluster 1: Crypto/Tokenomics (5 notes)
// Cluster 2: Basketball/CourtShare (5 notes)
// Cluster 3: AI Agents/Memory (5 notes)
// Cluster 4: Discord/Community (5 notes)
// Cross-domain bridges woven throughout

const NOTES: Note[] = [
  // === CRYPTO CLUSTER ===
  {
    title: "token staking creates skin in the game for community governance",
    type: "insight",
    project: ["crypto"],
    description: "Requiring token stakes for governance votes ensures only committed participants influence decisions",
    body: `Governance without stakes is just opinion polling. When token holders must stake to vote,
they put real value at risk. Bad votes cost them. Good votes compound.
This directly applies to [[community engagement requires real stakes not virtual points]] —
the same psychology that makes fake points fail in CourtShare makes unstaked governance fail in DAOs.
Related: [[kashi tokenomics should reward sustained engagement over speculation]].`,
    links: [
      "community engagement requires real stakes not virtual points",
      "kashi tokenomics should reward sustained engagement over speculation",
    ],
  },
  {
    title: "kashi tokenomics should reward sustained engagement over speculation",
    type: "decision",
    project: ["crypto"],
    description: "Vesting schedules and activity multipliers prevent pump-and-dump behavior",
    body: `The token distribution model uses time-weighted engagement: tokens earned through consistent
activity are worth more than tokens bought on the market. 30-day vesting on earned tokens,
activity multiplier that decays if engagement drops.
This creates a flywheel with [[courtshare booking rewards should vest over time to prevent farming]].
See also [[token staking creates skin in the game for community governance]].`,
    links: [
      "courtshare booking rewards should vest over time to prevent farming",
      "token staking creates skin in the game for community governance",
    ],
  },
  {
    title: "zero knowledge proofs enable private on chain voting",
    type: "learning",
    project: ["crypto"],
    description: "ZK-SNARKs let voters prove eligibility without revealing their identity or stake amount",
    body: `Private voting solves the social pressure problem in small communities. ZK proofs let a voter
prove "I hold enough tokens to vote" without revealing how many or which wallet.
This matters for [[discord moderation decisions benefit from anonymous voting]] — mod votes
should be private to prevent retaliation.
Technical stack: circom for circuits, snarkjs for proof generation, on-chain verifier contract.`,
    links: [
      "discord moderation decisions benefit from anonymous voting",
    ],
  },
  {
    title: "liquidity bootstrapping pools reduce frontrunning on token launch",
    type: "learning",
    project: ["crypto"],
    description: "LBPs with decreasing weight curves prevent bots from sniping the initial token offering",
    body: `Traditional token launches get frontrun by MEV bots within milliseconds. Liquidity Bootstrapping
Pools solve this by starting with a high token weight that decreases over time, naturally
creating a falling price curve that punishes early snipers.
For Kashi launch, target 72-hour LBP window on Balancer v2.
No direct cross-project link but relates to fair access patterns.`,
    links: [],
  },
  {
    title: "on chain reputation scores compound across platforms",
    type: "idea",
    project: ["crypto", "courtshare", "ai-agents"],
    description: "A single reputation score built from CourtShare bookings, Discord contributions, and agent interactions creates cross-platform trust",
    body: `Reputation is the cross-project primitive. A user who books courts reliably, helps in Discord,
and provides good feedback to AI agents should have a compounding reputation score.
This score could unlock: priority booking ([[courtshare booking rewards should vest over time to prevent farming]]),
governance weight ([[token staking creates skin in the game for community governance]]),
and trusted agent interactions ([[agent trust levels should adapt based on interaction history]]).
The on-chain component makes it portable — reputation travels with the wallet.`,
    links: [
      "courtshare booking rewards should vest over time to prevent farming",
      "token staking creates skin in the game for community governance",
      "agent trust levels should adapt based on interaction history",
    ],
  },

  // === BASKETBALL / COURTSHARE CLUSTER ===
  {
    title: "courtshare booking rewards should vest over time to prevent farming",
    type: "decision",
    project: ["courtshare", "crypto"],
    description: "Token rewards for court bookings vest linearly over 14 days to prevent book-and-cancel farming",
    body: `Early CourtShare had a problem: users booked courts just to earn points, then canceled.
Solution: rewards vest over 14 days. If you cancel, unvested rewards are forfeited.
This aligns with [[kashi tokenomics should reward sustained engagement over speculation]] —
the same anti-gaming mechanism works for both token distribution and booking rewards.
Implementation: reward escrow contract holds tokens, releases daily over the vesting period.`,
    links: [
      "kashi tokenomics should reward sustained engagement over speculation",
    ],
  },
  {
    title: "community engagement requires real stakes not virtual points",
    type: "insight",
    project: ["courtshare", "crypto"],
    description: "Loss aversion only activates when something of real value is at risk — virtual points create no behavioral change",
    body: `CourtShare v1 used virtual points. Users earned them, ignored them, churned.
CourtShare v2 with Kashi tokens changes the game: tokens have market value, losing them hurts.
This is the bridge between [[token staking creates skin in the game for community governance]]
and retention mechanics. The same psychology drives both.
Behavioral economics reference: Kahneman & Tversky prospect theory — losses loom larger than gains,
but only when the loss is real.`,
    links: [
      "token staking creates skin in the game for community governance",
    ],
  },
  {
    title: "pickup basketball games need dynamic skill matching",
    type: "idea",
    project: ["courtshare"],
    description: "ELO-style rating from game outcomes creates balanced pickup games without manual team selection",
    body: `Current pickup games are first-come-first-served, leading to mismatched skill levels and blowouts.
An ELO-style rating system that updates after each game could automatically suggest balanced teams.
Input: self-reported outcomes (winning team confirms). ELO adjustment based on expected vs actual result.
Over time, ratings stabilize and matchmaking improves game quality.
No direct crypto link, but rating could feed into [[on chain reputation scores compound across platforms]].`,
    links: [
      "on chain reputation scores compound across platforms",
    ],
  },
  {
    title: "court condition reporting creates a trust feedback loop",
    type: "idea",
    project: ["courtshare"],
    description: "Users report court conditions after playing; consistent reporters earn reputation, improving data quality",
    body: `After each session, players rate: surface quality, net condition, lighting, safety.
Reporters who consistently match consensus get higher trust weights.
This feeds directly into [[on chain reputation scores compound across platforms]] —
court condition reporting is one signal in the cross-platform reputation system.
Gamification: streak bonuses for consecutive reports, weighted more if you played longer.`,
    links: [
      "on chain reputation scores compound across platforms",
    ],
  },
  {
    title: "weather integration prevents wasted trips to outdoor courts",
    type: "blocker",
    project: ["courtshare"],
    description: "Real-time weather API integration needed to warn users before booking outdoor courts in rain",
    body: `Users book outdoor courts and show up to rain. Weather API integration should:
1. Show forecast alongside court availability
2. Auto-warn for bookings during high precipitation probability
3. Offer free cancellation for weather-affected bookings
API candidate: OpenWeatherMap (free tier covers 1000 calls/day).
Pure CourtShare infrastructure — no cross-project dependencies.`,
    links: [],
  },

  // === AI AGENTS / MEMORY CLUSTER ===
  {
    title: "agent trust levels should adapt based on interaction history",
    type: "insight",
    project: ["ai-agents", "crypto"],
    description: "Agents that consistently provide good responses should gain elevated trust and capabilities over time",
    body: `Static trust is wrong. An agent that has accurately answered 1000 questions deserves more autonomy
than a fresh instance. Trust adaptation needs:
- Interaction outcome tracking (helpful/not helpful feedback)
- Gradual capability elevation (trusted agents can take more actions)
- Trust decay if quality drops
This connects to [[on chain reputation scores compound across platforms]] — agent interaction
quality is one input to the cross-platform reputation primitive.
Also relates to [[discord bot personality should adapt to community culture over time]].`,
    links: [
      "on chain reputation scores compound across platforms",
      "discord bot personality should adapt to community culture over time",
    ],
  },
  {
    title: "memory consolidation should happen during idle periods not during queries",
    type: "decision",
    project: ["ai-agents"],
    description: "Background consolidation (re-indexing, link discovery, vitality updates) runs async to keep query latency low",
    body: `Early Ori ran consolidation inline with queries — if a note was accessed, it would trigger
re-indexing, graph updates, and vitality recalculation in the same request. This made queries slow.
Decision: consolidation happens in background passes. Queries read stale-but-fast indexes.
Background passes run: on session end (stop hook), on explicit build command, and optionally on a timer.
This is the database principle of separating OLTP from OLAP applied to agent memory.`,
    links: [],
  },
  {
    title: "semantic search finds connections that keyword search misses",
    type: "learning",
    project: ["ai-agents"],
    description: "Vector similarity surfaces conceptually related notes even when they share no common terms",
    body: `Keyword search for "engagement incentives" misses notes titled "token utility drives retention"
because the terms don't overlap. Embedding-based search maps both to similar vector regions.
This is the core argument for multi-signal retrieval in Ori:
- BM25 catches exact terms (good for proper nouns, technical terms)
- Embeddings catch semantic similarity (good for conceptual connections)
- Graph signals catch structural proximity (good for clustered knowledge)
The combination finds more relevant results than any single signal.
See also [[agent trust levels should adapt based on interaction history]] for a cross-domain example.`,
    links: [
      "agent trust levels should adapt based on interaction history",
    ],
  },
  {
    title: "context window pressure increases as vault grows",
    type: "insight",
    project: ["ai-agents"],
    description: "Larger vaults need smarter retrieval to avoid flooding the context window with marginally relevant notes",
    body: `A 50-note vault can dump everything into context. A 500-note vault cannot.
As the vault grows, retrieval precision becomes critical. The cost of a false positive
(irrelevant note consuming context tokens) grows linearly with vault size.
This motivates tiered retrieval: quick title scan, then description scan, then full read.
Only the most relevant notes get full-body inclusion in context.
Related architecture pattern in [[memory consolidation should happen during idle periods not during queries]].`,
    links: [
      "memory consolidation should happen during idle periods not during queries",
    ],
  },
  {
    title: "embedding drift requires periodic reindexing as vocabulary evolves",
    type: "learning",
    project: ["ai-agents"],
    description: "New domain vocabulary added to notes may not be well-represented by embeddings trained on general text",
    body: `When Aayo started writing about "Kashi tokenomics," the embedding model had never seen "Kashi"
as a meaningful term. It mapped it to generic Asian-food-related vectors. After adding 20+ notes
with "Kashi" in crypto contexts, reindexing let the model place these notes in better vector neighborhoods
through their surrounding context.
Reindex frequency: after every 50 new notes or when a new project domain is added.
No cross-project connection, purely AI infrastructure.`,
    links: [],
  },

  // === DISCORD / COMMUNITY CLUSTER ===
  {
    title: "discord bot personality should adapt to community culture over time",
    type: "idea",
    project: ["ai-agents", "discord-agents"],
    description: "Bot tone and behavior should evolve based on community feedback signals — formal communities get formal bots",
    body: `A Discord bot that sounds the same in a crypto trading server and a book club is wrong.
The bot should learn community norms from: emoji reaction patterns, message length distributions,
formality level of top contributors, explicit feedback (/bot-too-formal, /bot-too-casual).
This connects to [[agent trust levels should adapt based on interaction history]] — personality
adaptation is a dimension of trust. A well-adapted bot earns more trust.
Implementation: personality vector updated weekly from community interaction signals.`,
    links: [
      "agent trust levels should adapt based on interaction history",
    ],
  },
  {
    title: "discord moderation decisions benefit from anonymous voting",
    type: "insight",
    project: ["discord-agents", "crypto"],
    description: "Mod teams make better decisions when individual votes are private, preventing groupthink and retaliation",
    body: `In small Discord communities, mods know each other. Public mod votes create social pressure —
nobody wants to be the one who voted to ban a popular member.
Anonymous voting via [[zero knowledge proofs enable private on chain voting]] solves this:
mods prove they have the mod role without revealing which mod voted which way.
Result: more honest moderation, less retaliation, better community health.`,
    links: [
      "zero knowledge proofs enable private on chain voting",
    ],
  },
  {
    title: "channel archival should preserve context for future agent retrieval",
    type: "decision",
    project: ["discord-agents", "ai-agents"],
    description: "Archived Discord channels should be indexed into agent memory so historical context is retrievable",
    body: `When a Discord channel is archived, its messages disappear from active context.
But those messages contain decisions, discussions, and context that future agents need.
Decision: archive pipeline ingests channel history into the agent memory vault as source material.
Each message thread becomes a potential extraction source for the knowledge pipeline.
This bridges Discord operations with agent memory infrastructure.
See [[semantic search finds connections that keyword search misses]] for why embedding these
messages matters.`,
    links: [
      "semantic search finds connections that keyword search misses",
    ],
  },
  {
    title: "role based access control maps cleanly to agent capability tiers",
    type: "learning",
    project: ["discord-agents"],
    description: "Discord role hierarchy provides a natural model for agent permission escalation",
    body: `Discord roles (admin > mod > member > visitor) map directly to agent trust tiers:
- Admin agents: can modify system config, run destructive operations
- Mod agents: can moderate content, run analysis
- Member agents: can query, create, suggest
- Visitor agents: can only query
This reuses existing community governance rather than inventing new permission models.
Pure Discord infrastructure — no cross-project dependencies.`,
    links: [],
  },
  {
    title: "incentive alignment between token holders and community members prevents governance capture",
    type: "insight",
    project: ["crypto", "discord-agents", "courtshare"],
    description: "Governance mechanisms must ensure token-heavy whales cannot override the interests of active community participants",
    body: `The tension: token holders want price appreciation, community members want good features.
When one whale holds 20% of tokens, they can dominate governance votes.
Solution: quadratic voting (cost of N votes = N^2 tokens) combined with activity-weighted reputation.
A user who books 50 courts and contributes daily in Discord gets governance weight that pure token
holders cannot buy.
This ties together [[token staking creates skin in the game for community governance]],
[[community engagement requires real stakes not virtual points]], and
[[on chain reputation scores compound across platforms]].`,
    links: [
      "token staking creates skin in the game for community governance",
      "community engagement requires real stakes not virtual points",
      "on chain reputation scores compound across platforms",
    ],
  },
];

// Queries designed to test cross-domain retrieval specifically
const QUERIES: Query[] = [
  {
    query: "how do token incentives improve basketball court engagement",
    expectedRelevant: [
      "courtshare booking rewards should vest over time to prevent farming",
      "community engagement requires real stakes not virtual points",
      "kashi tokenomics should reward sustained engagement over speculation",
      "on chain reputation scores compound across platforms",
    ],
    crossDomain: true,
    description: "Crypto × CourtShare: tests whether token-court bridge notes surface",
  },
  {
    query: "how can reputation scores work across different platforms",
    expectedRelevant: [
      "on chain reputation scores compound across platforms",
      "agent trust levels should adapt based on interaction history",
      "court condition reporting creates a trust feedback loop",
      "incentive alignment between token holders and community members prevents governance capture",
    ],
    crossDomain: true,
    description: "3-way bridge: crypto × courtshare × ai-agents reputation primitive",
  },
  {
    query: "why does anonymous voting matter for community governance",
    expectedRelevant: [
      "discord moderation decisions benefit from anonymous voting",
      "zero knowledge proofs enable private on chain voting",
      "token staking creates skin in the game for community governance",
      "incentive alignment between token holders and community members prevents governance capture",
    ],
    crossDomain: true,
    description: "Crypto × Discord: ZK voting for mod decisions",
  },
  {
    query: "how should AI agents earn trust over time",
    expectedRelevant: [
      "agent trust levels should adapt based on interaction history",
      "on chain reputation scores compound across platforms",
      "discord bot personality should adapt to community culture over time",
    ],
    crossDomain: true,
    description: "AI agents × crypto: trust + reputation convergence",
  },
  {
    query: "what prevents reward farming and gaming the system",
    expectedRelevant: [
      "courtshare booking rewards should vest over time to prevent farming",
      "kashi tokenomics should reward sustained engagement over speculation",
      "community engagement requires real stakes not virtual points",
      "incentive alignment between token holders and community members prevents governance capture",
    ],
    crossDomain: true,
    description: "Anti-gaming across crypto × courtshare",
  },
  {
    query: "how can Discord channel history improve agent memory",
    expectedRelevant: [
      "channel archival should preserve context for future agent retrieval",
      "semantic search finds connections that keyword search misses",
      "memory consolidation should happen during idle periods not during queries",
    ],
    crossDomain: true,
    description: "Discord × AI agents: archival into memory",
  },
  {
    query: "what is the best way to match basketball players by skill",
    expectedRelevant: [
      "pickup basketball games need dynamic skill matching",
      "on chain reputation scores compound across platforms",
    ],
    crossDomain: false,
    description: "Single-domain CourtShare query (control)",
  },
  {
    query: "how does semantic search compare to keyword search for retrieval",
    expectedRelevant: [
      "semantic search finds connections that keyword search misses",
      "context window pressure increases as vault grows",
      "embedding drift requires periodic reindexing as vocabulary evolves",
    ],
    crossDomain: false,
    description: "Single-domain AI agents query (control)",
  },
  {
    query: "how does governance capture happen and how to prevent it",
    expectedRelevant: [
      "incentive alignment between token holders and community members prevents governance capture",
      "token staking creates skin in the game for community governance",
      "community engagement requires real stakes not virtual points",
    ],
    crossDomain: true,
    description: "Crypto × Discord × CourtShare: governance alignment",
  },
  {
    query: "what role does weather play in court booking",
    expectedRelevant: [
      "weather integration prevents wasted trips to outdoor courts",
    ],
    crossDomain: false,
    description: "Single-domain CourtShare query (control — tests precision on narrow queries)",
  },
];

// ---------------------------------------------------------------------------
// Metrics (same as locomo.ts)
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

function mrr(retrieved: string[], relevant: string[]): number {
  const relevantSet = new Set(relevant);
  for (let i = 0; i < retrieved.length; i++) {
    if (relevantSet.has(retrieved[i])) return 1 / (i + 1);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Vault Setup & Pipeline (same pattern as locomo.ts)
// ---------------------------------------------------------------------------

async function createVault(notes: Note[]): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ori-crossdomain-"));
  const notesDir = path.join(tmpDir, "notes");
  const oriDir = path.join(tmpDir, ".ori");
  await fs.mkdir(notesDir, { recursive: true });
  await fs.mkdir(oriDir, { recursive: true });

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
      console.log("  Building embedding index...");
      const stats = await engine.buildIndex(vaultRoot, config.engine, { force: true });
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

  const bm25Results = searchBM25(query, bm25Index, config.bm25, candidateLimit);

  let graphResults: ScoredNote[] = [];
  const seeds = bm25Results.slice(0, 3).map((r) => r.title);
  if (seeds.length > 0) {
    const graphologyGraph = buildGraphologyGraph(linkGraph);
    const pprScores = personalizedPageRank(graphologyGraph, seeds, 0.85, 20);
    graphResults = rankByImportance(allTitles, pprScores, candidateLimit);
  }

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

  const signals: SignalResults = { composite: compositeResults, keyword: bm25Results, graph: graphResults };
  const fused = fuseScoreWeightedRRF(signals, config.retrieval);
  return fused.slice(0, topK).map((r) => r.title);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

interface QueryResult {
  query: string;
  description: string;
  crossDomain: boolean;
  retrieved: string[];
  expected: string[];
  precision: number;
  recall: number;
  f1: number;
  mrr: number;
}

function printReport(results: QueryResult[], embeddingsUsed: boolean, topK: number): void {
  const divider = "=".repeat(90);
  const thinDivider = "-".repeat(90);

  console.log("\n" + divider);
  console.log("  CROSS-DOMAIN RETRIEVAL BENCHMARK");
  console.log(`  Mode: ${embeddingsUsed ? "Full 3-signal" : "BM25 + Graph (no embeddings)"}`);
  console.log(`  Notes: ${NOTES.length} across ${new Set(NOTES.flatMap((n) => n.project)).size} projects`);
  console.log(`  Queries: ${results.length} (${results.filter((r) => r.crossDomain).length} cross-domain, ${results.filter((r) => !r.crossDomain).length} single-domain)`);
  console.log(`  Top-K: ${topK}`);
  console.log(divider + "\n");

  for (const r of results) {
    const tag = r.crossDomain ? "[CROSS]" : "[SINGLE]";
    console.log(`  ${tag} "${r.query}"`);
    console.log(`    ${r.description}`);
    console.log(`    Retrieved:`);
    for (const t of r.retrieved) {
      const hit = r.expected.includes(t) ? " HIT" : "    ";
      console.log(`      ${hit} ${t}`);
    }
    console.log(`    P=${r.precision.toFixed(3)}  R=${r.recall.toFixed(3)}  F1=${r.f1.toFixed(3)}  MRR=${r.mrr.toFixed(3)}`);
    console.log(thinDivider);
  }

  // Split metrics: cross-domain vs single-domain
  const crossResults = results.filter((r) => r.crossDomain);
  const singleResults = results.filter((r) => !r.crossDomain);

  const mean = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  console.log("\n" + divider);
  console.log("  AGGREGATE METRICS");
  console.log(divider);

  const allP = mean(results.map((r) => r.precision));
  const allR = mean(results.map((r) => r.recall));
  const allF = mean(results.map((r) => r.f1));
  const allM = mean(results.map((r) => r.mrr));
  console.log(`  Overall:      P=${allP.toFixed(4)}  R=${allR.toFixed(4)}  F1=${allF.toFixed(4)}  MRR=${allM.toFixed(4)}`);

  if (crossResults.length > 0) {
    const cp = mean(crossResults.map((r) => r.precision));
    const cr = mean(crossResults.map((r) => r.recall));
    const cf = mean(crossResults.map((r) => r.f1));
    const cm = mean(crossResults.map((r) => r.mrr));
    console.log(`  Cross-domain: P=${cp.toFixed(4)}  R=${cr.toFixed(4)}  F1=${cf.toFixed(4)}  MRR=${cm.toFixed(4)}`);
  }

  if (singleResults.length > 0) {
    const sp = mean(singleResults.map((r) => r.precision));
    const sr = mean(singleResults.map((r) => r.recall));
    const sf = mean(singleResults.map((r) => r.f1));
    const sm = mean(singleResults.map((r) => r.mrr));
    console.log(`  Single-domain: P=${sp.toFixed(4)}  R=${sr.toFixed(4)}  F1=${sf.toFixed(4)}  MRR=${sm.toFixed(4)}`);
  }

  // The thesis test: cross-domain should be close to single-domain
  if (crossResults.length > 0 && singleResults.length > 0) {
    const crossF1 = mean(crossResults.map((r) => r.f1));
    const singleF1 = mean(singleResults.map((r) => r.f1));
    const gap = singleF1 - crossF1;
    console.log(`\n  Cross-domain gap: ${gap > 0 ? "+" : ""}${gap.toFixed(4)} (positive = single-domain is easier)`);
    if (gap < 0.1) {
      console.log("  THESIS SUPPORTED: Cross-domain retrieval within 0.10 of single-domain");
    } else if (gap < 0.2) {
      console.log("  THESIS MARGINAL: Cross-domain gap in [0.10, 0.20) — needs improvement");
    } else {
      console.log("  THESIS CHALLENGED: Cross-domain gap >= 0.20 — bridge notes not surfacing well");
    }
  }

  console.log(divider + "\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const useEmbeddings = !args.includes("--no-embeddings");
  const jsonOutput = args.includes("--json");
  const topK = 5;
  const startTime = Date.now();

  console.log("Cross-Domain Retrieval Benchmark — Ori Mnemos v0.3");
  console.log("====================================================\n");
  console.log(`  ${NOTES.length} notes across ${new Set(NOTES.flatMap((n) => n.project)).size} project clusters`);
  console.log(`  ${QUERIES.length} queries (${QUERIES.filter((q) => q.crossDomain).length} cross-domain)\n`);

  // Create vault
  console.log("Setting up temporary vault...");
  const vaultRoot = await createVault(NOTES);

  try {
    console.log("Building retrieval pipeline...");
    const pipeline = await buildPipeline(vaultRoot, useEmbeddings);
    console.log(`  Graph: ${pipeline.allTitles.length} notes, ${pipeline.graphMetrics.communityStats.size} communities`);
    console.log(`  Bridges: ${pipeline.graphMetrics.bridges.size}`);

    console.log(`\nRunning ${QUERIES.length} queries (top-${topK})...`);
    const results: QueryResult[] = [];

    for (const q of QUERIES) {
      const retrieved = await runQuery(pipeline, q.query, topK);
      const p = precision(retrieved, q.expectedRelevant);
      const r = recall(retrieved, q.expectedRelevant);
      const f = f1(p, r);
      const m = mrr(retrieved, q.expectedRelevant);

      results.push({
        query: q.query,
        description: q.description,
        crossDomain: q.crossDomain,
        retrieved,
        expected: q.expectedRelevant,
        precision: p,
        recall: r,
        f1: f,
        mrr: m,
      });
    }

    printReport(results, pipeline.embeddingsAvailable, topK);

    if (jsonOutput) {
      const resultsDir = path.join(path.dirname(import.meta.dirname ?? "."), "bench", "results");
      await fs.mkdir(resultsDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const outputPath = path.join(resultsDir, `cross-domain-${timestamp}.json`);

      const crossResults = results.filter((r) => r.crossDomain);
      const singleResults = results.filter((r) => !r.crossDomain);
      const mean = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

      const output = {
        timestamp: new Date().toISOString(),
        noteCount: NOTES.length,
        queryCount: QUERIES.length,
        topK,
        embeddingsAvailable: pipeline.embeddingsAvailable,
        aggregate: {
          overall: {
            meanPrecision: mean(results.map((r) => r.precision)),
            meanRecall: mean(results.map((r) => r.recall)),
            meanF1: mean(results.map((r) => r.f1)),
            meanMRR: mean(results.map((r) => r.mrr)),
          },
          crossDomain: {
            meanF1: mean(crossResults.map((r) => r.f1)),
            meanMRR: mean(crossResults.map((r) => r.mrr)),
          },
          singleDomain: {
            meanF1: mean(singleResults.map((r) => r.f1)),
            meanMRR: mean(singleResults.map((r) => r.mrr)),
          },
        },
        perQuery: results.map((r) => ({
          query: r.query,
          crossDomain: r.crossDomain,
          precision: r.precision,
          recall: r.recall,
          f1: r.f1,
          mrr: r.mrr,
        })),
      };
      await fs.writeFile(outputPath, JSON.stringify(output, null, 2), "utf-8");
      console.log(`Results saved to: ${outputPath}`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Total time: ${elapsed}s`);
  } finally {
    console.log("Cleaning up...");
    await fs.rm(vaultRoot, { recursive: true, force: true });
    console.log("Done.");
  }
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
