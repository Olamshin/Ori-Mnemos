#!/usr/bin/env npx tsx
/**
 * Ori Mnemos — Demo Script
 *
 * 30-second full flow from init to intelligent retrieval.
 * Shows Ori's complete value proposition in a single terminal session.
 *
 * Usage:
 *   npx tsx bench/demo.ts              # Run demo
 *   npx tsx bench/demo.ts --verbose    # Show token counts per operation
 *   npx tsx bench/demo.ts --keep       # Don't delete vault after demo
 *
 * v1: Functional flow with clean formatting
 * v2 (planned): ASCII animations, progress bars, Aries coin art, terminal polish
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import chalk from "chalk";

import figlet from "figlet";
import { runInit } from "../src/cli/init.js";
import { runAdd } from "../src/cli/add.js";
import { runIndexBuild } from "../src/cli/indexcmd.js";
import { runQueryRanked } from "../src/cli/search.js";
import { runHealth } from "../src/cli/health.js";
import { runStatus } from "../src/cli/status.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose");
const KEEP = args.includes("--keep");
const PAUSE = args.includes("--pause");

// ---------------------------------------------------------------------------
// Demo Notes — hand-crafted to demonstrate specific retrieval behaviors
// ---------------------------------------------------------------------------

interface DemoNote {
  title: string;
  type: string;
  project: string[];
  content: string;
  description: string;
}

const DEMO_NOTES: DemoNote[] = [
  // === CRYPTO CLUSTER ===
  {
    title: "token utility drives retention because users with real stakes dont churn",
    type: "insight",
    project: ["crypto"],
    description: "Loss aversion from real token value creates behavioral lock-in that virtual points cannot match",
    content: `Virtual points create zero loss aversion. Users earn them, ignore them, leave.
Real tokens with market value change the equation — losing tokens hurts, so users engage to protect their position.
This is Kahneman's prospect theory applied to platform design: losses loom larger than gains, but only when the loss is real.
The implication for any engagement platform: fake incentives produce fake engagement.
Related: [[engagement incentives work best when they bridge multiple platform contexts]]`,
  },
  {
    title: "staking mechanisms align long term holder interests with platform health",
    type: "decision",
    project: ["crypto"],
    description: "Requiring token lockup for governance prevents short-term speculation from dominating platform decisions",
    content: `Governance without skin in the game is opinion polling. Staking requirements ensure voters have real exposure.
30-day lockup for governance participation, with voting weight proportional to stake duration not just amount.
This prevents governance capture by whales doing quick buy-vote-sell attacks.
Combined with quadratic voting, this creates a system where consistent participants outweigh large but transient holders.
See [[token utility drives retention because users with real stakes dont churn]] for the behavioral foundation.`,
  },
  {
    title: "zero knowledge proofs enable private voting without sacrificing verifiability",
    type: "learning",
    project: ["crypto"],
    description: "ZK-SNARKs prove vote eligibility without revealing voter identity or stake size",
    content: `In small communities, public votes create social pressure and retaliation risk.
ZK proofs solve this: voters prove "I hold enough tokens to participate" without revealing which wallet or how much.
Technical approach: circom circuits for eligibility proof, snarkjs for generation, on-chain verifier.
This applies anywhere you need accountable anonymity — mod decisions, peer review, competitive analysis.
Related: [[staking mechanisms align long term holder interests with platform health]].`,
  },

  // === BASKETBALL / PLATFORM CLUSTER ===
  {
    title: "player evaluation persistence means your basketball takes have consequences",
    type: "insight",
    project: ["courtshare"],
    description: "Making predictions permanent and tracked creates accountability that transforms casual opinion into meaningful analysis",
    content: `Sports discourse is ephemeral — hot takes disappear, nobody tracks accuracy, there are no consequences for being wrong.
Persistent evaluation changes this. Every prediction is recorded, timestamped, and scored against outcomes.
Over time, users build a track record. Accurate analysts gain credibility. Consistently wrong takes are visible.
This creates a meritocracy of basketball knowledge where reputation is earned, not claimed.
See [[immutable prediction records create the accountability layer that sports discourse lacks]] for the on-chain implementation.`,
  },
  {
    title: "dynamic skill matching for pickup games uses elo ratings from game outcomes",
    type: "idea",
    project: ["courtshare"],
    description: "Self-reported game results feed an ELO system that suggests balanced teams for pickup basketball",
    content: `Pickup basketball suffers from skill mismatch — first-come-first-served teams produce blowouts.
An ELO-style system where players rate game outcomes creates automatic skill tiers.
After each game, the winning team reports results. ELO adjustments reflect expected vs actual outcomes.
Over 20+ games, ratings stabilize and the system can suggest balanced team compositions.
This feeds into [[on chain reputation scores compound across every platform interaction]].`,
  },
  {
    title: "court condition crowdsourcing creates a trust feedback loop among players",
    type: "idea",
    project: ["courtshare"],
    description: "Post-session court ratings from players build reliable facility data while rewarding consistent reporters",
    content: `After each session, players rate surface quality, net condition, lighting, safety.
Reports from players who consistently match consensus are weighted higher.
This creates a self-improving data layer — better data attracts more users, more users produce better data.
Reporters who maintain streaks earn reputation bonuses.
See [[on chain reputation scores compound across every platform interaction]] and
[[dynamic skill matching for pickup games uses elo ratings from game outcomes]].`,
  },

  // === AI AGENTS / MEMORY CLUSTER ===
  {
    title: "semantic search finds connections that keyword search misses across different vocabularies",
    type: "learning",
    project: ["ai-agents"],
    description: "Vector embeddings surface conceptually related notes even when they share zero common terms",
    content: `Searching "engagement incentives" via keywords misses a note titled "token utility drives retention" — no overlapping terms.
Embedding search maps both to nearby vector regions because the concepts are semantically similar.
This is the core argument for multi-signal retrieval:
- BM25 catches exact terms (project names, technical jargon)
- Embeddings catch conceptual similarity (different words, same idea)
- Graph signals catch structural proximity (linked notes, shared clusters)
The combination finds what no single signal can.
See [[agent memory compounds over sessions making each interaction smarter than the last]] and
[[vitality decay gives recently accessed notes priority without losing old knowledge]].`,
  },
  {
    title: "agent memory compounds over sessions making each interaction smarter than the last",
    type: "insight",
    project: ["ai-agents"],
    description: "Persistent memory creates compounding returns where past context accelerates future work",
    content: `Session 1: the agent learns your project structure. Session 10: it knows your architecture, preferences, and patterns.
Session 50: it anticipates your needs and surfaces connections you haven't seen yet.
This is the compounding thesis — memory doesn't just store, it multiplies.
Each new note increases the probability of finding cross-domain connections.
The vault is not a database, it's a growing neural network of linked knowledge.`,
  },
  {
    title: "vitality decay gives recently accessed notes priority without losing old knowledge",
    type: "learning",
    project: ["ai-agents"],
    description: "ACT-R inspired activation formula balances recency and frequency so active notes surface first while archived notes remain findable",
    content: `The vitality model borrows from cognitive science: notes accessed recently and frequently have higher activation.
Power law decay (not exponential) means old notes fade slowly — they're deprioritized, not deleted.
Well-connected notes decay slower because structural importance provides a vitality floor.
Bridge notes (connecting two otherwise separate clusters) get protected vitality to maintain cross-domain paths.
Related: [[agent memory compounds over sessions making each interaction smarter than the last]].
See also [[semantic search finds connections that keyword search misses across different vocabularies]].`,
  },

  // === CROSS-DOMAIN BRIDGES (the stars of the demo) ===
  {
    title: "engagement incentives work best when they bridge multiple platform contexts",
    type: "insight",
    project: ["crypto", "courtshare", "ai-agents"],
    description: "Token rewards that span booking, analysis, and AI interaction create a unified engagement flywheel across platforms",
    content: `The most powerful incentive isn't platform-specific — it's cross-platform.
A user who books courts, writes accurate predictions, AND provides good agent feedback should earn compounding rewards.
Single-platform rewards hit diminishing returns. Cross-platform rewards create network effects:
- Basketball engagement drives token demand
- Token value drives more basketball engagement
- Agent interactions improve both by surfacing cross-domain insights
This is why [[token utility drives retention because users with real stakes dont churn]] connects to
[[player evaluation persistence means your basketball takes have consequences]] — both are stake-based engagement,
and combining them multiplies the effect.`,
  },
  {
    title: "on chain reputation scores compound across every platform interaction",
    type: "opportunity",
    project: ["crypto", "courtshare", "ai-agents"],
    description: "A single portable reputation score built from court bookings, prediction accuracy, and AI feedback creates cross-platform trust",
    content: `Reputation is the cross-platform primitive. A reliable court booker who makes accurate predictions and gives
good agent feedback should have a single compounding score.
On-chain storage makes it portable — reputation travels with the wallet, not the platform.
This score unlocks: priority booking, governance weight, trusted agent interactions, and premium features.
The flywheel: more interactions → higher reputation → more access → more interactions.
See [[engagement incentives work best when they bridge multiple platform contexts]].`,
  },
  {
    title: "immutable prediction records create the accountability layer that sports discourse lacks",
    type: "decision",
    project: ["courtshare", "crypto"],
    description: "Publishing basketball takes on-chain makes them permanent and verifiable, solving the hot take accountability problem",
    content: `Sports media has no accountability. Analysts make bold predictions, nobody tracks accuracy, wrong takes vanish.
On-chain prediction records solve this: every take is timestamped, immutable, and scored against outcomes.
This connects crypto infrastructure to basketball content — the blockchain provides the accountability layer
that CourtShare needs, while CourtShare provides the real-world use case that gives the chain meaning.
Related: [[player evaluation persistence means your basketball takes have consequences]].`,
  },
];

// ---------------------------------------------------------------------------
// Demo Queries — designed to show different retrieval capabilities
// ---------------------------------------------------------------------------

interface DemoQuery {
  query: string;
  label: string;
  description: string;
}

const DEMO_QUERIES: (DemoQuery & { headline: string })[] = [
  {
    query: "how do token incentives improve basketball engagement",
    label: "CROSS-DOMAIN",
    description: "Should find notes from BOTH crypto and basketball clusters — the bridge notes",
    headline: "Zero keyword overlap. Found the bridge anyway.",
  },
  {
    query: "persistent state across sessions",
    label: "SEMANTIC",
    description: "No note uses these exact words — tests whether embeddings find 'agent memory compounds'",
    headline: "Different words, same concept. Keyword search returns nothing.",
  },
  {
    query: "what creates accountability in sports predictions",
    label: "MULTI-HOP",
    description: "Connects basketball predictions → immutability → on-chain records across projects",
    headline: "No single note answers this. The graph traced the path.",
  },
];

// ---------------------------------------------------------------------------
// Art
// ---------------------------------------------------------------------------

const gold = chalk.ansi256(178);
const parchment = chalk.ansi256(230);

const ELEPHANT = `⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣠⠤⠤⠶⠒⠒⠒⠶⠦⠤⠤⠤⠤⣀⠀⠀⣀⣠⡤⠤⠤⠤⠤⣄⣀⣀⠀⠀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⠞⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⠄⠚⡛⠋⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠛⠯⣍⠉⠉⠙⠢⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⣠⠞⠁⠀⠀⠀⠀⠀⠀⠰⣤⣄⠀⠐⠳⠖⠋⠛⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣌⠻⣷⢀⡀⠙⣆⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⢀⡞⠁⠀⠀⠀⠀⠀⠀⠀⠀⠙⢺⣿⣷⡐⣴⠃⢀⣦⠂⠀⠀⠀⠀⡠⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠹⣆⢻⣾⣷⠂⠈⢆⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⣠⠟⠁⠠⠤⠀⠀⠀⠀⠀⠀⠀⠀⠀⠨⣿⣿⣾⡿⠿⠃⢀⡀⠀⠀⠈⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠺⣿⠋⠀⠀⠘⡆⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⡞⣡⠄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⣿⣿⢠⠀⠀⠀⠈⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⢳⡀⠀⠀⠹⡄⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠘⡧⠋⣰⠎⠀⠐⠈⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⣾⡟⠀⠀⠀⠀⢀⣴⢦⣠⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣤⡇⠀⠀⢡⡇⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠹⣾⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⣿⡁⡀⡜⠀⠀⢺⣶⣶⣾⡿⠆⠀⠀⠀⠀⠀⠀⠀⠈⠀⠀⠀⢸⣷⠇⠀⠠⠘⡇⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⢿⠀⠀⠀⠀⠀⢀⡔⠁⠀⠀⠀⠀⠀⠀⠀⠀⣿⣧⣧⣿⡄⠀⠀⢙⠿⣫⠃⠘⠱⡠⡀⠀⠀⠀⠀⠀⠀⠀⣠⢸⣿⠀⠠⠠⠘⡇⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠘⣦⡗⣠⠂⠠⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⢹⣿⠛⠿⠒⠤⣤⣭⣽⠄⠀⠀⠀⠱⡠⠐⠀⠈⠉⠀⠄⣨⢸⣇⠀⢘⣇⢧⡇⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠈⠙⣆⣠⠂⢠⠀⢠⠃⠀⠀⠀⠀⠀⠀⠀⠈⣾⣿⡄⠀⠠⡀⠀⠘⣿⠀⠀⠀⠀⠀⠀⠁⡀⠤⠤⠤⠤⢬⡀⣿⡇⠀⣿⡼⠁⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠳⣇⣰⡿⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⢻⣟⠀⣴⣜⠔⠞⣻⠀⠀⠀⠀⠀⠐⠁⠀⢀⣀⣀⣀⡀⠄⠘⣿⣇⡟⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠻⣇⠀⢸⠀⠀⠀⠀⠀⠀⠀⢸⡏⣿⣜⣿⣏⠳⣾⣿⠀⠀⠀⢠⠀⠀⠀⠊⠁⠀⠀⠀⠈⠑⢠⠸⡿⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢰⣸⣷⣮⣀⠀⠀⠀⠀⠀⠀⠈⡁⣿⣿⣿⣟⣳⡾⣿⣀⣤⣄⡀⢧⠠⠀⠠⠐⠒⠐⠒⠒⠢⣸⣇⡷⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡏⡏⣿⣧⡝⣿⣦⣀⡀⠀⡀⠀⠇⣿⣿⣿⣿⣿⣿⣿⣿⡇⠀⢻⣾⣴⠂⠀⠠⠤⠐⠂⠤⢄⣸⣿⠹⡄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡇⣿⣿⡇⠨⡻⢿⣿⣷⣤⣤⣼⣿⣯⣻⣿⣿⣿⣿⣿⣷⠀⠀⣿⣯⢿⡀⠀⠠⠄⠂⠤⠄⡿⢻⣇⠘⢆⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⠀⢰⢸⣿⣷⠀⠀⡪⣿⣿⣿⣿⣿⣿⡿⣮⣯⣻⣿⣿⣿⣿⣷⡀⠘⢿⣏⡆⠀⠐⠒⠒⠒⠲⡇⠀⠙⠦⣀⠣⡀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠈⢹⣿⡀⠀⠔⠉⠠⠈⠉⠁⠘⣷⣬⣻⣇⣻⡹⣿⣿⣿⣿⣶⣬⣿⠵⠀⢈⣉⣉⣉⣙⡇⠀⠀⠀⠈⠙⠁⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠸⣿⡇⠀⠀⠠⠀⠁⠀⠀⢀⣻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡞⠁⠠⠤⠤⠤⢼⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⢷⠀⡀⠀⠀⠀⠀⣀⠀⠀⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣇⠀⠀⠈⢉⣉⣹⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠸⡆⣷⠀⠀⠀⠈⠀⠀⠀⠈⡙⢿⣿⣿⡿⢻⣿⣿⣿⣿⣿⡇⠀⠀⠀⠠⠤⢼⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠳⠘⠀⠀⠀⠀⠀⠀⠀⠀⠈⢸⡟⠉⠀⠀⣿⣿⠿⠃⠀⣷⠀⠀⠀⠀⠀⢽⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⡇⠀⠀⠀⢿⠉⠀⠀⠀⢹⠀⠀⠀⠀⠈⣻⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠁⠀⠀⠀⠀⠀⠀⠀⠀⢸⠆⠀⠀⠀⠀⢾⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢨⡇⠀⠀⠀⠂⣺⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣇⠀⠀⠀⡀⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣤⣀⡏⠀⠀⣠⣄⡏⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⡏⣴⣿⠃⠀⣠⣿⣾⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠙⢷⣦⣁⣤⣼⣿⡿⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠛⠛⠛⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function showBootArt(): Promise<void> {
  process.stdout.write("\x1b[2J\x1b[H");

  const titleLines = figlet.textSync("ORI MNEMOS", { font: "Standard" }).split("\n");
  for (const line of titleLines) {
    console.log(gold(line));
    await sleep(80);
  }
  await sleep(300);

  const elephantLines = ELEPHANT.split("\n");
  for (let i = 0; i < elephantLines.length; i++) {
    console.log(parchment(elephantLines[i]));
    const progress = i / elephantLines.length;
    const eased = progress < 0.3 ? 120 : progress > 0.7 ? 120 : 70;
    await sleep(eased);
  }
  await sleep(400);

  console.log("");
  console.log(gold("        Memory is Sovereignty."));
  console.log("");
}

function header(text: string): void {
  const line = "─".repeat(70);
  console.log("");
  console.log(chalk.cyan(line));
  console.log(chalk.cyan.bold(`  ${text}`));
  console.log(chalk.cyan(line));
}

function step(n: number, text: string): void {
  console.log("");
  console.log(chalk.yellow(`  [${n}/6]`) + chalk.white.bold(` ${text}`));
}

function headline(text: string): void {
  if (!PAUSE) return;
  console.log("");
  console.log(gold.bold(`  → ${text}`));
}

function info(text: string): void {
  console.log(chalk.gray(`        ${text}`));
}

function success(text: string): void {
  console.log(chalk.green(`        ${text}`));
}

function highlight(text: string): void {
  console.log(chalk.white(`        ${text}`));
}

async function pause(msg = "Press ENTER to continue..."): Promise<void> {
  if (!PAUSE) return;
  process.stdout.write(chalk.yellow(`\n  ⏎  ${msg} `));
  process.stdin.setRawMode?.(false);
  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
  console.log("");
}

function elapsed(startMs: number): string {
  return `${((Date.now() - startMs) / 1000).toFixed(1)}s`;
}

function tokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const totalStart = Date.now();

  await showBootArt();
  headline("The missing layer is memory. We built the open source alternative.");
  await pause("Press ENTER to begin demo...");

  header("Ori Mnemos — The Git of AI Memory");
  console.log(chalk.gray("        Markdown-native persistent memory for AI agents"));
  console.log(chalk.gray("        No database. No cloud. Just files, links, and intelligence."));

  // -------------------------------------------------------------------------
  // Step 1: Init
  // -------------------------------------------------------------------------
  step(1, "Initialize a fresh vault");
  let stepStart = Date.now();

  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "ori-demo-"));
  const result = await runInit({ targetDir: vaultDir });

  success(`Vault created at ${vaultDir}`);
  info(`Scaffold: ${result.created.length} files (notes/, inbox/, self/, ops/, templates/)`);
  info(`Time: ${elapsed(stepStart)}`);

  if (VERBOSE) {
    info(`Token estimate: ~${tokenEstimate(JSON.stringify(result))} tokens for init response`);
  }

  headline("Plain markdown on disk. No database, no cloud, no lock-in.");
  await pause();

  try {
    // -----------------------------------------------------------------------
    // Step 2: Add notes
    // -----------------------------------------------------------------------
    step(2, `Add ${DEMO_NOTES.length} notes across 3 project domains`);
    stepStart = Date.now();

    const projectCounts = new Map<string, number>();
    let totalTokens = 0;

    for (const note of DEMO_NOTES) {
      // Slugify wiki-link targets to match the dash-separated filenames that runAdd creates
      const slugifiedContent = note.content.replace(
        /\[\[([^\]]+)\]\]/g,
        (_, target: string) => `[[${target.trim().toLowerCase().replace(/\s+/g, "-")}]]`,
      );

      const addResult = await runAdd({
        startDir: vaultDir,
        title: note.title,
        type: note.type,
        content: slugifiedContent,
      });

      if (!addResult.success) {
        console.log(chalk.red(`        FAILED: ${note.title}`));
        console.log(chalk.red(`        ${addResult.warnings.join(", ")}`));
        continue;
      }

      for (const p of note.project) {
        projectCounts.set(p, (projectCounts.get(p) || 0) + 1);
      }

      if (VERBOSE) {
        const tokens = tokenEstimate(JSON.stringify(addResult));
        totalTokens += tokens;
      }
    }

    const projectSummary = Array.from(projectCounts.entries())
      .map(([p, c]) => `${p}(${c})`)
      .join(", ");
    success(`${DEMO_NOTES.length} notes added: ${projectSummary}`);

    // Count cross-project notes
    const crossProject = DEMO_NOTES.filter((n) => n.project.length > 1).length;
    info(`${crossProject} cross-project bridge notes linking domains together`);
    info(`Time: ${elapsed(stepStart)}`);

    if (VERBOSE) {
      info(`Token estimate: ~${totalTokens} tokens total for ${DEMO_NOTES.length} add operations`);
    }

    headline("3 projects, 3 bridge notes connecting them. Watch the queries.");
    await pause();

    // -----------------------------------------------------------------------
    // Step 3: Build embedding index
    // -----------------------------------------------------------------------
    step(3, "Build semantic embedding index");
    stepStart = Date.now();

    info("Downloading model (Xenova/all-MiniLM-L6-v2, ~22MB, cached after first run)...");

    const indexResult = await runIndexBuild(vaultDir, true);

    if (indexResult.success) {
      const stats = indexResult.data as Record<string, unknown>;
      success(`Indexed ${stats.indexed} notes in ${stats.durationMs}ms`);
      info(`Model: ${stats.model}`);
      info(`Embedding dimensions: 384 (6-space composite: text + temporal + vitality + importance + type + community)`);
    } else {
      console.log(chalk.red(`        Index build failed: ${indexResult.warnings.join(", ")}`));
    }
    info(`Time: ${elapsed(stepStart)}`);

    if (VERBOSE) {
      info(`Token estimate: ~${tokenEstimate(JSON.stringify(indexResult))} tokens for index response`);
    }

    headline("Local model, no API key. This is NOT just vector search.");
    await pause();

    // -----------------------------------------------------------------------
    // Step 4: Health check
    // -----------------------------------------------------------------------
    step(4, "Run vault health diagnostics");
    stepStart = Date.now();

    const healthResult = await runHealth(vaultDir);
    const health = healthResult.data as Record<string, unknown>;

    success(`Notes: ${health.noteCount} | Orphans: ${health.orphanCount} | Dangling links: ${health.danglingCount}`);

    if ((health.orphanCount as number) === 0 && (health.danglingCount as number) === 0) {
      info("Clean bill of health — all notes connected, no broken links");
    }
    info(`Time: ${elapsed(stepStart)}`);

    headline("Every link is a graph edge. PageRank + community detection built in.");
    await pause();

    // -----------------------------------------------------------------------
    // Step 5: Retrieval queries (the main event)
    // -----------------------------------------------------------------------
    step(5, "Run 3 retrieval queries demonstrating the thesis");

    for (const dq of DEMO_QUERIES) {
      stepStart = Date.now();
      console.log("");
      console.log(chalk.magenta(`        ┌─ Query: `) + chalk.white.bold(`"${dq.query}"`));
      console.log(chalk.magenta(`        │  `) + chalk.gray(`[${dq.label}] ${dq.description}`));

      const searchResult = await runQueryRanked(vaultDir, dq.query, 8);

      if (searchResult.success) {
        const data = searchResult.data as {
          intent: string;
          results: Array<{ title: string; score: number; signals: Record<string, number> }>;
          count: number;
        };

        // Filter out scaffold seed note
        const filtered = data.results.filter((r) => r.title !== "index");

        console.log(chalk.magenta(`        │  `) + chalk.gray(`Intent: ${data.intent} | Results: ${filtered.length} | Time: ${elapsed(stepStart)}`));
        console.log(chalk.magenta(`        │`));

        for (let i = 0; i < Math.min(filtered.length, 5); i++) {
          const r = filtered[i];
          const rank = chalk.yellow(`#${i + 1}`);
          const score = chalk.gray(`(${r.score.toFixed(3)})`);
          const title = chalk.white(r.title);

          // Show which signals contributed
          const signals: string[] = [];
          if (r.signals.composite) signals.push(chalk.blue(`vec:${r.signals.composite.toFixed(2)}`));
          if (r.signals.keyword) signals.push(chalk.green(`bm25:${r.signals.keyword.toFixed(1)}`));
          if (r.signals.graph) signals.push(chalk.red(`graph:${r.signals.graph.toFixed(3)}`));
          const signalStr = signals.length > 0 ? chalk.gray(` [${signals.join(" ")}]`) : "";

          console.log(chalk.magenta(`        │  `) + `  ${rank} ${score} ${title}`);
          if (VERBOSE && signalStr) {
            console.log(chalk.magenta(`        │  `) + `     ${signalStr}`);
          }
        }

        // Highlight cross-project results
        const crossResults = filtered.filter((r) => {
          const note = DEMO_NOTES.find((n) => n.title === r.title);
          return note && note.project.length > 1;
        });
        if (crossResults.length > 0) {
          console.log(chalk.magenta(`        │`));
          console.log(chalk.magenta(`        │  `) + chalk.cyan.bold(`↗ ${crossResults.length} cross-project note(s) surfaced from bridge connections`));
        }
      }

      console.log(chalk.magenta(`        └${"─".repeat(65)}`));

      if (VERBOSE) {
        info(`Token estimate: ~${tokenEstimate(JSON.stringify(searchResult))} tokens for this query`);
      }

      headline(dq.headline);
      await pause();
    }

    // -----------------------------------------------------------------------
    // Step 6: Summary
    // -----------------------------------------------------------------------
    step(6, "Summary");

    const statusResult = await runStatus(vaultDir);
    const status = statusResult.data as Record<string, unknown>;

    const totalTime = elapsed(totalStart);

    console.log("");
    console.log(chalk.cyan("        ┌─────────────────────────────────────────────────────────┐"));
    console.log(chalk.cyan("        │") + chalk.white.bold("  Ori Mnemos — What just happened:                        ") + chalk.cyan("│"));
    console.log(chalk.cyan("        │") + chalk.gray(`  • Initialized a vault from scratch                      `) + chalk.cyan("│"));
    console.log(chalk.cyan("        │") + chalk.gray(`  • Added ${String(status.noteCount).padEnd(2)} notes across 3 project domains              `) + chalk.cyan("│"));
    console.log(chalk.cyan("        │") + chalk.gray(`  • Built semantic embedding index (384-dim, 6-space)      `) + chalk.cyan("│"));
    console.log(chalk.cyan("        │") + chalk.gray(`  • Ran 3 queries demonstrating cross-domain retrieval     `) + chalk.cyan("│"));
    console.log(chalk.cyan("        │") + chalk.gray(`  • Total time: ${totalTime.padEnd(42)}`) + chalk.cyan("│"));
    console.log(chalk.cyan("        │                                                         │"));
    console.log(chalk.cyan("        │") + chalk.white.bold("  The thesis:                                              ") + chalk.cyan("│"));
    console.log(chalk.cyan("        │") + chalk.white(`  Cross-project notes surface when queried from             `) + chalk.cyan("│"));
    console.log(chalk.cyan("        │") + chalk.white(`  either domain. Memory compounds across sessions.          `) + chalk.cyan("│"));
    console.log(chalk.cyan("        │") + chalk.white(`  No database. No cloud. Just markdown and intelligence.    `) + chalk.cyan("│"));
    console.log(chalk.cyan("        │                                                         │"));
    console.log(chalk.cyan("        │") + chalk.gray(`  github.com/aayoawoyemi/OriMnemos                         `) + chalk.cyan("│"));
    console.log(chalk.cyan("        └─────────────────────────────────────────────────────────┘"));
    console.log("");

  } finally {
    if (KEEP) {
      console.log(chalk.yellow(`  Vault preserved at: ${vaultDir}`));
    } else {
      await fs.rm(vaultDir, { recursive: true, force: true });
      info("Temporary vault cleaned up.");
    }
  }
}

main().catch((err) => {
  console.error(chalk.red("Demo failed:"), err);
  process.exit(1);
});
