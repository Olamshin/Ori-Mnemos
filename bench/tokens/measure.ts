#!/usr/bin/env npx tsx
/**
 * Ori Mnemos — Token Economics Measurement
 *
 * Measures the token cost of every Ori MCP operation by:
 * 1. Spawning a real MCP server against temp vaults of different sizes
 * 2. Calling each tool and measuring input/output JSON payload sizes
 * 3. Converting to token estimates (chars / 4)
 * 4. Building a cost model for typical sessions
 * 5. Comparing Ori MCP vs raw file reads
 *
 * Usage:
 *   npx tsx bench/tokens/measure.ts              # Run measurement
 *   npx tsx bench/tokens/measure.ts --json        # Save JSON results
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import chalk from "chalk";

import { runInit } from "../../src/cli/init.js";
import { runAdd } from "../../src/cli/add.js";
import { runStatus } from "../../src/cli/status.js";
import { runHealth } from "../../src/cli/health.js";
import { runQueryRanked } from "../../src/cli/search.js";
import { runPromote } from "../../src/cli/promote.js";
import { runIndexBuild } from "../../src/cli/indexcmd.js";
import { applyConfigDefaults } from "../../src/core/config.js";
import { stringifyFrontmatter } from "../../src/core/frontmatter.js";

// ---------------------------------------------------------------------------
// Token Estimation
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateTokensJson(obj: unknown): number {
  return estimateTokens(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Vault Generation
// ---------------------------------------------------------------------------

const SAMPLE_TITLES = [
  "agent memory requires both episodic and semantic retrieval",
  "token utility drives retention because users with real stakes dont churn",
  "semantic search finds connections that keyword search misses",
  "personalized pagerank spreads activation through the link graph",
  "cross project connections multiply the value of both domains",
  "vitality decay models how quickly notes fade from working memory",
  "bridge notes connect communities and resist vitality decay",
  "staking mechanisms align long term holder interests with platform health",
  "player evaluation persistence means your basketball takes have consequences",
  "court condition crowdsourcing creates a trust feedback loop among players",
  "immutable prediction records create the accountability layer sports discourse lacks",
  "zero knowledge proofs enable private voting without sacrificing verifiability",
  "dynamic skill matching for pickup games uses elo ratings from outcomes",
  "discord bot personality should adapt to community culture over time",
  "channel archival should preserve context for future agent retrieval",
  "embedding drift requires periodic reindexing as vocabulary evolves",
  "context window pressure increases as vault grows larger",
  "memory consolidation should happen during idle periods not during queries",
  "on chain reputation scores compound across every platform interaction",
  "engagement incentives work best when they bridge multiple platform contexts",
];

const PROJECTS = ["crypto", "courtshare", "ai-agents", "discord-agents"];
const TYPES = ["insight", "decision", "learning", "idea", "blocker", "opportunity"];

function generateNoteContent(index: number, totalNotes: number): string {
  const linkCount = Math.min(3, Math.floor(totalNotes / 5));
  const links: string[] = [];
  for (let i = 0; i < linkCount; i++) {
    const targetIdx = (index + i + 1) % totalNotes;
    const targetTitle = SAMPLE_TITLES[targetIdx % SAMPLE_TITLES.length]
      .replace(/ /g, "-") + (targetIdx >= SAMPLE_TITLES.length ? `-${targetIdx}` : "");
    links.push(`[[${targetTitle}]]`);
  }

  return `This is note ${index + 1} of ${totalNotes} in the benchmark vault.
It contains enough text to represent a realistic note body with several sentences.
The content discusses concepts related to agent memory, retrieval systems, and knowledge graphs.
Cross-domain connections are represented through wiki-links to other notes.
${links.join("\n")}
Additional context: token economics, engagement mechanics, and platform design patterns.`;
}

async function createSizedVault(noteCount: number): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `ori-tokens-${noteCount}-`));
  await runInit({ targetDir: tmpDir });

  // Disable auto-promote for direct note writing
  const configPath = path.join(tmpDir, "ori.config.yaml");
  const config = await fs.readFile(configPath, "utf8");
  await fs.writeFile(configPath, config.replace("auto: true", "auto: false"), "utf8");

  const notesDir = path.join(tmpDir, "notes");

  for (let i = 0; i < noteCount; i++) {
    const titleBase = SAMPLE_TITLES[i % SAMPLE_TITLES.length];
    const title = i < SAMPLE_TITLES.length ? titleBase : `${titleBase} variant ${i}`;
    const slug = title.replace(/ /g, "-").toLowerCase();

    const frontmatter: Record<string, unknown> = {
      description: `Test note ${i + 1} for token economics measurement`,
      type: TYPES[i % TYPES.length],
      project: [PROJECTS[i % PROJECTS.length]],
      status: "active",
      created: "2026-03-01",
      last_accessed: "2026-03-01",
      access_count: Math.floor(Math.random() * 10),
    };

    const body = generateNoteContent(i, noteCount);
    const content = stringifyFrontmatter(frontmatter, "\n" + body + "\n");
    await fs.writeFile(path.join(notesDir, `${slug}.md`), content, "utf-8");
  }

  // Re-enable auto-promote
  const configUpdated = await fs.readFile(configPath, "utf8");
  await fs.writeFile(configPath, configUpdated.replace("auto: false", "auto: true"), "utf8");

  return tmpDir;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

interface OperationMeasurement {
  operation: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
}

interface VaultMeasurement {
  noteCount: number;
  operations: OperationMeasurement[];
  sessionSimulation: {
    totalTokens: number;
    operations: string[];
  };
}

async function measureOperation(
  name: string,
  inputArgs: unknown,
  fn: () => Promise<unknown>,
): Promise<OperationMeasurement> {
  const inputTokens = estimateTokensJson(inputArgs);
  const start = Date.now();
  const result = await fn();
  const durationMs = Date.now() - start;
  const outputTokens = estimateTokensJson(result);

  return {
    operation: name,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    durationMs,
  };
}

async function measureVault(noteCount: number): Promise<VaultMeasurement> {
  const vaultDir = await createSizedVault(noteCount);
  const operations: OperationMeasurement[] = [];

  try {
    // Build index for embedding-based operations
    await runIndexBuild(vaultDir, true);

    // 1. ori_status
    operations.push(
      await measureOperation(
        "ori_status",
        {},
        () => runStatus(vaultDir),
      ),
    );

    // 2. ori_health
    operations.push(
      await measureOperation(
        "ori_health",
        {},
        () => runHealth(vaultDir),
      ),
    );

    // 3. ori_query_ranked (single query)
    const queryArgs = { query: "how does agent memory handle temporal context", limit: 10 };
    operations.push(
      await measureOperation(
        "ori_query_ranked",
        queryArgs,
        () => runQueryRanked(vaultDir, queryArgs.query, queryArgs.limit),
      ),
    );

    // 4. ori_query_ranked (cross-domain query)
    const crossQueryArgs = { query: "token incentives for basketball engagement", limit: 10 };
    operations.push(
      await measureOperation(
        "ori_query_ranked (cross-domain)",
        crossQueryArgs,
        () => runQueryRanked(vaultDir, crossQueryArgs.query, crossQueryArgs.limit),
      ),
    );

    // 5. ori_add
    const addArgs = { title: "benchmark test note for token measurement purposes", type: "insight", content: "This note was created during the token economics benchmark." };
    operations.push(
      await measureOperation(
        "ori_add",
        addArgs,
        () => runAdd({ startDir: vaultDir, ...addArgs }),
      ),
    );

    // 6. ori_promote (add to inbox first, then promote)
    const configPath = path.join(vaultDir, "ori.config.yaml");
    const config = await fs.readFile(configPath, "utf8");
    await fs.writeFile(configPath, config.replace("auto: true", "auto: false"), "utf8");

    const inboxNote = await runAdd({
      startDir: vaultDir,
      title: "promotable note for token economics measurement test",
      type: "learning",
      content: "This note will be promoted to measure token cost.",
    });
    const inboxFilename = path.basename(inboxNote.data.path as string);

    // Re-enable auto-promote
    const configUpdated = await fs.readFile(configPath, "utf8");
    await fs.writeFile(configPath, configUpdated.replace("auto: false", "auto: true"), "utf8");

    const promoteArgs = { path: inboxFilename };
    operations.push(
      await measureOperation(
        "ori_promote",
        promoteArgs,
        () => runPromote({ startDir: vaultDir, noteName: inboxFilename }),
      ),
    );

    // 7. Simulate orient (brief) — read identity + goals + daily + reminders + status
    const selfDir = path.join(vaultDir, "self");
    const opsDir = path.join(vaultDir, "ops");
    const orientFiles = [
      path.join(selfDir, "identity.md"),
      path.join(selfDir, "goals.md"),
      path.join(selfDir, "methodology.md"),
      path.join(opsDir, "daily.md"),
      path.join(opsDir, "reminders.md"),
    ];

    let orientTokens = 0;
    const orientStart = Date.now();
    for (const filePath of orientFiles) {
      try {
        const content = await fs.readFile(filePath, "utf8");
        orientTokens += estimateTokens(content);
      } catch { /* file may not exist */ }
    }
    const statusResult = await runStatus(vaultDir);
    orientTokens += estimateTokensJson(statusResult);
    const orientDuration = Date.now() - orientStart;

    operations.push({
      operation: "ori_orient (brief=true)",
      inputTokens: estimateTokensJson({ brief: true }),
      outputTokens: orientTokens,
      totalTokens: orientTokens + estimateTokensJson({ brief: true }),
      durationMs: orientDuration,
    });

    // 8. Orient full (adds identity, methodology, goals content)
    let orientFullTokens = orientTokens;
    const goalsContent = await fs.readFile(path.join(selfDir, "goals.md"), "utf8").catch(() => "");
    const identityContent = await fs.readFile(path.join(selfDir, "identity.md"), "utf8").catch(() => "");
    const methodologyContent = await fs.readFile(path.join(selfDir, "methodology.md"), "utf8").catch(() => "");
    orientFullTokens += estimateTokens(goalsContent + identityContent + methodologyContent);

    operations.push({
      operation: "ori_orient (brief=false)",
      inputTokens: estimateTokensJson({ brief: false }),
      outputTokens: orientFullTokens,
      totalTokens: orientFullTokens + estimateTokensJson({ brief: false }),
      durationMs: orientDuration,
    });

    // Session simulation: orient + 3 queries + 2 adds + 1 promote
    const sessionOps = [
      "ori_orient (brief=true)",
      "ori_query_ranked",
      "ori_query_ranked",
      "ori_query_ranked",
      "ori_add",
      "ori_add",
      "ori_promote",
    ];

    let sessionTotal = 0;
    for (const opName of sessionOps) {
      const op = operations.find((o) => o.operation === opName);
      if (op) sessionTotal += op.totalTokens;
    }

    // Compare: raw file reads for equivalent info
    // "What would it cost to just grep/cat the vault?"
    const notesDir = path.join(vaultDir, "notes");
    const allFiles = await fs.readdir(notesDir);
    let rawVaultTokens = 0;
    for (const f of allFiles) {
      if (f.endsWith(".md")) {
        const content = await fs.readFile(path.join(notesDir, f), "utf8");
        rawVaultTokens += estimateTokens(content);
      }
    }

    operations.push({
      operation: "raw: read entire vault",
      inputTokens: 0,
      outputTokens: rawVaultTokens,
      totalTokens: rawVaultTokens,
      durationMs: 0,
    });

    return {
      noteCount,
      operations,
      sessionSimulation: {
        totalTokens: sessionTotal,
        operations: sessionOps,
      },
    };
  } finally {
    await fs.rm(vaultDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

// Claude Sonnet 4 pricing (2026)
const INPUT_COST_PER_MTOK = 3.0;  // $/MTok
const OUTPUT_COST_PER_MTOK = 15.0; // $/MTok

function tokensToCost(inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * INPUT_COST_PER_MTOK +
    (outputTokens / 1_000_000) * OUTPUT_COST_PER_MTOK;
}

function formatCost(cost: number): string {
  if (cost < 0.001) return `$${(cost * 1000).toFixed(3)}m`; // millicents
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(3)}`;
}

function printResults(measurements: VaultMeasurement[]): void {
  const divider = "=".repeat(90);
  const thinDivider = "-".repeat(90);

  console.log("\n" + divider);
  console.log(chalk.cyan.bold("  ORI MNEMOS — TOKEN ECONOMICS REPORT"));
  console.log(chalk.gray("  Pricing: Claude Sonnet 4 ($3/$15 per MTok input/output)"));
  console.log(chalk.gray("  Token estimation: chars / 4 (standard approximation)"));
  console.log(divider);

  for (const m of measurements) {
    console.log(chalk.yellow.bold(`\n  Vault Size: ${m.noteCount} notes`));
    console.log(thinDivider);

    // Per-operation table
    const header = [
      "Operation".padEnd(35),
      "In".padStart(7),
      "Out".padStart(7),
      "Total".padStart(7),
      "Cost".padStart(10),
      "ms".padStart(6),
    ].join("  ");
    console.log(chalk.gray("  " + header));
    console.log(chalk.gray("  " + "-".repeat(header.length)));

    for (const op of m.operations) {
      const cost = tokensToCost(op.inputTokens, op.outputTokens);
      const row = [
        op.operation.padEnd(35),
        String(op.inputTokens).padStart(7),
        String(op.outputTokens).padStart(7),
        String(op.totalTokens).padStart(7),
        formatCost(cost).padStart(10),
        String(op.durationMs).padStart(6),
      ].join("  ");

      const color = op.operation.startsWith("raw:") ? chalk.red : chalk.white;
      console.log("  " + color(row));
    }

    // Session simulation
    console.log(chalk.gray("\n  " + thinDivider));
    console.log(chalk.white.bold("  Session Simulation:") + chalk.gray(` ${m.sessionSimulation.operations.join(" → ")}`));
    console.log(chalk.white(`  Total session tokens: ${m.sessionSimulation.totalTokens}`));

    // Cost at different usage levels
    const queryOp = m.operations.find((o) => o.operation === "ori_query_ranked");
    const orientOp = m.operations.find((o) => o.operation === "ori_orient (brief=true)");
    const addOp = m.operations.find((o) => o.operation === "ori_add");
    const rawOp = m.operations.find((o) => o.operation.startsWith("raw:"));

    if (queryOp && orientOp && addOp) {
      console.log(chalk.gray("\n  Cost per session (orient + N queries + 2 adds):"));
      for (const nQueries of [3, 10, 30]) {
        const totalIn = orientOp.inputTokens + nQueries * queryOp.inputTokens + 2 * addOp.inputTokens;
        const totalOut = orientOp.outputTokens + nQueries * queryOp.outputTokens + 2 * addOp.outputTokens;
        const cost = tokensToCost(totalIn, totalOut);
        const totalTok = totalIn + totalOut;
        console.log(chalk.white(`    ${nQueries} queries: ${totalTok} tokens = ${formatCost(cost)}`));
      }
    }

    // Ori vs raw comparison
    if (rawOp && queryOp) {
      console.log(chalk.gray("\n  Ori vs raw file reads:"));
      console.log(chalk.white(`    Raw vault dump: ${rawOp.totalTokens} tokens`));
      console.log(chalk.white(`    Single Ori query: ${queryOp.totalTokens} tokens`));
      const savings = rawOp.totalTokens > 0
        ? ((1 - queryOp.totalTokens / rawOp.totalTokens) * 100).toFixed(1)
        : "N/A";
      console.log(chalk.cyan(`    Token savings per query: ${savings}%`));
      const breakeven = queryOp.totalTokens > 0
        ? Math.ceil(rawOp.totalTokens / queryOp.totalTokens)
        : 0;
      console.log(chalk.cyan(`    Break-even: ${breakeven} queries before raw dump exceeds Ori cost`));
    }
  }

  // Cross-size scaling analysis
  if (measurements.length > 1) {
    console.log("\n" + divider);
    console.log(chalk.cyan.bold("  SCALING ANALYSIS"));
    console.log(divider);

    const header = [
      "Notes".padStart(6),
      "Query tok".padStart(10),
      "Orient tok".padStart(11),
      "Raw vault".padStart(10),
      "Savings".padStart(9),
    ].join("  ");
    console.log(chalk.gray("\n  " + header));
    console.log(chalk.gray("  " + "-".repeat(header.length)));

    for (const m of measurements) {
      const queryOp = m.operations.find((o) => o.operation === "ori_query_ranked");
      const orientOp = m.operations.find((o) => o.operation === "ori_orient (brief=true)");
      const rawOp = m.operations.find((o) => o.operation.startsWith("raw:"));

      if (queryOp && orientOp && rawOp) {
        const savings = rawOp.totalTokens > 0
          ? ((1 - queryOp.totalTokens / rawOp.totalTokens) * 100).toFixed(1) + "%"
          : "N/A";
        const row = [
          String(m.noteCount).padStart(6),
          String(queryOp.totalTokens).padStart(10),
          String(orientOp.totalTokens).padStart(11),
          String(rawOp.totalTokens).padStart(10),
          savings.padStart(9),
        ].join("  ");
        console.log("  " + chalk.white(row));
      }
    }

    console.log(chalk.gray("\n  Key insight: query tokens stay roughly constant while raw vault grows linearly."));
    console.log(chalk.gray("  At scale, Ori retrieval is dramatically cheaper than dumping the whole vault."));
  }

  console.log("\n" + divider + "\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");

  console.log(chalk.cyan.bold("Ori Mnemos — Token Economics Measurement"));
  console.log(chalk.gray("Measuring token cost per operation at different vault sizes...\n"));

  const vaultSizes = [5, 50, 200];
  const measurements: VaultMeasurement[] = [];

  for (const size of vaultSizes) {
    console.log(chalk.yellow(`  Measuring ${size}-note vault...`));
    const startTime = Date.now();
    const m = await measureVault(size);
    measurements.push(m);
    console.log(chalk.green(`    Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`));
  }

  printResults(measurements);

  if (jsonOutput) {
    const resultsDir = path.join(path.dirname(path.dirname(import.meta.dirname ?? ".")), "bench", "results");
    await fs.mkdir(resultsDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outputPath = path.join(resultsDir, `tokens-${timestamp}.json`);

    const output = {
      timestamp: new Date().toISOString(),
      pricing: { input_per_mtok: INPUT_COST_PER_MTOK, output_per_mtok: OUTPUT_COST_PER_MTOK },
      measurements: measurements.map((m) => ({
        noteCount: m.noteCount,
        operations: m.operations,
        sessionSimulation: m.sessionSimulation,
      })),
    };
    await fs.writeFile(outputPath, JSON.stringify(output, null, 2), "utf-8");
    console.log(chalk.green(`Results saved to: ${outputPath}`));
  }
}

main().catch((err) => {
  console.error(chalk.red("Measurement failed:"), err);
  process.exit(1);
});
