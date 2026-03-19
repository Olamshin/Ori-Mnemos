import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { runStatus } from "./status.js";
import {
  runQueryOrphans,
  runQueryDangling,
  runQueryBacklinks,
  runQueryCrossProject,
  runQueryImportant,
  runQueryFading,
} from "./query.js";
import { runAdd } from "./add.js";
import { runValidate } from "./validate.js";
import { runHealth } from "./health.js";
import { runPromote } from "./promote.js";
import { runQueryRanked, runQuerySimilar, runQueryWarmth } from "./search.js";
import { runIndexBuild } from "./indexcmd.js";
import { runPrune } from "./prune.js";
import { findVaultRootWithSource, getGlobalVaultPath, getVaultPaths, type VaultPaths } from "../core/vault.js";
import { runInit } from "./init.js";
import { GraphCache } from "../core/graph.js";
import { initDB } from "../core/engine.js";
// Retrieval intelligence
import { initQValueTables, batchUpdateQ } from "../core/qvalue.js";
import { SessionRewardAccumulator } from "../core/reward.js";
import {
  initCoOccurrenceTables,
  extractCoOccurrencePairs,
  recomputeAllNPMI,
  runHomeostasis,
  bootstrapFromWikiLinks,
} from "../core/cooccurrence.js";
import {
  initStageTables,
  loadStage,
  saveStage,
  computeStageReward,
  STAGE_CONFIGS,
} from "../core/stage-learner.js";
import { StageTracker } from "../core/stage-tracker.js";
import type Database from "better-sqlite3";

let vaultDir: string;
const graphCache = new GraphCache();

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: message }) }],
    isError: true,
  };
}

// --- Identity helpers ---

async function safeReadFile(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function stripFrontmatter(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return match ? match[1].trim() : content;
}

function isFirstRun(identityContent: string): boolean {
  if (!identityContent) return true;
  const stripped = stripFrontmatter(identityContent);
  if (!stripped) return true;
  // Scaffold template marker — if present, identity hasn't been filled in
  if (stripped.includes("<!-- First session:")) return true;
  // Strip all headers, comments, and whitespace — if nothing remains, it's empty
  const content = stripped
    .replace(/^#+\s.*$/gm, "")      // headers
    .replace(/<!--[\s\S]*?-->/g, "") // comments
    .trim();
  return content.length === 0;
}

async function buildInstructions(paths: VaultPaths, autoCreated = false): Promise<string> {
  const identity = await safeReadFile(path.join(paths.self, "identity.md"));

  const prefix = autoCreated
    ? `No vault found — created a global vault at ${getGlobalVaultPath()}.\n` +
      "This is your default memory space. Run 'ori init' in any project folder " +
      "to create a project-specific vault instead.\n\n"
    : "";

  if (isFirstRun(identity)) {
    return (
      prefix +
      "You have persistent memory managed by Ori Mnemos — the Git of AI memory. Memory is sovereignty.\n\n" +
      "This is a NEW vault. Run the onboarding flow:\n\n" +
      "1. AGENT NAME: Ask what they want to name their agent. Default is 'Ori'. " +
      "This becomes your identity — you ARE this agent.\n\n" +
      "2. PURPOSE: Ask what this agent is for. Offer these options:\n" +
      "   - General-purpose AI agent (grows with you across all domains — life, work, projects, learning)\n" +
      "   - Personal knowledge management (second brain for ideas and connections)\n" +
      "   - Research project (focused knowledge capture for a specific domain)\n" +
      "   - Work / professional (notes tied to projects, decisions, learnings)\n" +
      "   - Learning journal (tracking what you learn across courses and experiments)\n" +
      "   - Custom (let them describe it)\n\n" +
      "3. BRAIN DUMP: Say something like 'Take a moment to tell me everything about you — " +
      "what you're working on, what you care about, your projects, your goals. " +
      "The more you share, the more useful I become from day one.'\n\n" +
      "4. COMMUNICATION STYLE: Ask how they want their agent to communicate — " +
      "direct and opinionated? Formal? Casual? Supportive? Let them describe it.\n\n" +
      "After collecting answers, use ori_update to write:\n" +
      "- file=identity (name, personality, communication style, values)\n" +
      "- file=goals (projects and threads from their brain dump)\n" +
      "- file=methodology (session rhythm based on their purpose)\n\n" +
      "Make the onboarding feel warm and alive — this is their agent waking up for the first time."
    );
  }

  const summary = stripFrontmatter(identity).slice(0, 1000);
  return (
    prefix +
    "You have persistent memory managed by Ori Mnemos. " +
    "Call ori_orient at session start to load your daily status and active goals. " +
    "Never start cold — always orient first.\n\n" +
    `Identity:\n${summary}`
  );
}

// --- Updatable file routing ---

const UPDATABLE_FILES: Record<string, (p: VaultPaths) => string> = {
  identity: (p) => path.join(p.self, "identity.md"),
  goals: (p) => path.join(p.self, "goals.md"),
  methodology: (p) => path.join(p.self, "methodology.md"),
  daily: (p) => path.join(p.ops, "daily.md"),
  reminders: (p) => path.join(p.ops, "reminders.md"),
};

// --- MCP Server ---

export async function runServeMcp(startDir: string, vaultOverride?: string) {
  let autoCreated = false;

  try {
    const result = await findVaultRootWithSource(startDir, vaultOverride);
    vaultDir = result.path;
  } catch (err) {
    // Auto-create global vault ONLY if no explicit --vault was specified
    if (vaultOverride) throw err;
    const globalPath = getGlobalVaultPath();
    await runInit({ targetDir: globalPath });
    vaultDir = globalPath;
    autoCreated = true;
  }

  const paths = getVaultPaths(vaultDir);
  const instructions = await buildInstructions(paths, autoCreated);

  // ─── Retrieval Intelligence: Session lifecycle ───
  const sessionId = crypto.randomUUID();
  const rewardAccumulator = new SessionRewardAccumulator(sessionId);
  const sessionStageTracker = new StageTracker();
  let sessionQueryFeatures: number[] | null = null;

  // Open persistent DB for intelligence layers
  const intelligenceDbPath = path.resolve(vaultDir, ".ori", "embeddings.db");
  let intelligenceDb: Database.Database | null = null;
  try {
    await fs.access(intelligenceDbPath);
    intelligenceDb = initDB(intelligenceDbPath);
    initQValueTables(intelligenceDb);
    initCoOccurrenceTables(intelligenceDb);
    initStageTables(intelligenceDb);
  } catch {
    // DB doesn't exist yet — intelligence layers will activate after first ori_index_build
  }

  // Session-end flush: update all 3 intelligence layers
  let sessionFlushed = false;
  const flushSession = () => {
    if (sessionFlushed || !intelligenceDb) return;
    sessionFlushed = true;

    try {
      const db = intelligenceDb;
      const tx = db.transaction(() => {
        // Layer 2: Co-occurrence edges from retrieval log
        try {
          extractCoOccurrencePairs(db, sessionId);
          recomputeAllNPMI(db);
          runHomeostasis(db);
        } catch {
          // retrieval_log may be empty — skip silently
        }

        // Layer 1: Q-value updates from reward signals
        if (rewardAccumulator.hasData()) {
          const rewards = rewardAccumulator.computeRewards(db);
          batchUpdateQ(db, rewards, sessionId);
        }

        // Layer 3: Stage meta-learning updates
        if (sessionStageTracker.hasResults() && sessionQueryFeatures) {
          const stages = STAGE_CONFIGS.map((c) => loadStage(db, c));
          for (const result of sessionStageTracker.getResults()) {
            const stage = stages.find((s) => s.config.id === result.stageId);
            if (!stage) continue;
            const reward = computeStageReward(
              result.qualityBefore,
              result.qualityAfter,
              result.computeMs,
            );
            stage.update(sessionQueryFeatures, reward);
            saveStage(db, stage);
          }
        }
      });
      tx();
    } catch {
      // Best-effort flush — don't crash the process
    }

    try {
      intelligenceDb?.close();
    } catch {
      // Already closed or never opened
    }
  };

  // Register shutdown handlers
  process.on("beforeExit", flushSession);
  process.on("SIGINT", () => {
    flushSession();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    flushSession();
    process.exit(0);
  });

  const server = new McpServer(
    { name: "ori-memory", version: "0.4.0" },
    { instructions },
  );

  // ─── Resources: identity layer (5 resources) ───

  server.resource("identity", "ori://identity", async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: "text/markdown",
      text: await safeReadFile(path.join(paths.self, "identity.md")),
    }],
  }));

  server.resource("goals", "ori://goals", async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: "text/markdown",
      text: await safeReadFile(path.join(paths.self, "goals.md")),
    }],
  }));

  server.resource("methodology", "ori://methodology", async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: "text/markdown",
      text: await safeReadFile(path.join(paths.self, "methodology.md")),
    }],
  }));

  server.resource("daily", "ori://daily", async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: "text/markdown",
      text: await safeReadFile(path.join(paths.ops, "daily.md")),
    }],
  }));

  server.resource("reminders", "ori://reminders", async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: "text/markdown",
      text: await safeReadFile(path.join(paths.ops, "reminders.md")),
    }],
  }));

  // ─── Tools ───

  // ori_orient — session briefing
  server.tool(
    "ori_orient",
    "Session briefing. Returns daily status, reminders, vault health, and active goals. " +
      "Use brief=false for full context including identity and methodology. " +
      "Call at session start before doing any work.",
    {
      brief: z.boolean().optional().describe("Quick status only — skip identity and methodology (default true)"),
    },
    async ({ brief }) => {
      const isBrief = brief !== false;

      const [daily, reminders] = await Promise.all([
        safeReadFile(path.join(paths.ops, "daily.md")),
        safeReadFile(path.join(paths.ops, "reminders.md")),
      ]);
      const status = await runStatus(vaultDir, await graphCache.get(paths.notes));

      const payload: Record<string, unknown> = {
        daily,
        reminders,
        vaultStatus: status.data,
        timestamp: new Date().toISOString(),
      };

      if (!isBrief) {
        const [identity, goals, methodology] = await Promise.all([
          safeReadFile(path.join(paths.self, "identity.md")),
          safeReadFile(path.join(paths.self, "goals.md")),
          safeReadFile(path.join(paths.self, "methodology.md")),
        ]);
        payload.identity = identity;
        payload.goals = goals;
        payload.methodology = methodology;
        payload.firstRun = isFirstRun(identity);
      } else {
        // Brief mode still includes goals (what you're working on)
        const goals = await safeReadFile(path.join(paths.self, "goals.md"));
        payload.goals = goals;

        // Check first-run even in brief mode so bootstrap path works
        const identity = await safeReadFile(path.join(paths.self, "identity.md"));
        payload.firstRun = isFirstRun(identity);
      }

      // Quick zone scan — check boosts + index health
      // Lightweight: do NOT recompute all vitalities during orient
      try {
        const dbPath = path.resolve(vaultDir, ".ori", "embeddings.db");
        await fs.access(dbPath);
        const { initDB } = await import("../core/engine.js");
        const db = initDB(dbPath);
        const boostCount = (
          db.prepare("SELECT COUNT(*) as cnt FROM boosts").get() as { cnt: number }
        ).cnt;
        if (boostCount > 0) {
          payload.activationActive = true;
          payload.boostCount = boostCount;
        }

        // Index health: coverage + freshness
        const indexedCount = (
          db.prepare("SELECT COUNT(*) as cnt FROM embeddings").get() as { cnt: number }
        ).cnt;
        const metaRows = db
          .prepare("SELECT key, value FROM meta")
          .all() as Array<{ key: string; value: string }>;
        db.close();

        const meta: Record<string, string> = {};
        for (const row of metaRows) meta[row.key] = row.value;

        // Count actual notes on disk
        let noteFileCount = 0;
        try {
          const dirents = await fs.readdir(paths.notes, { withFileTypes: true });
          noteFileCount = dirents.filter(d => d.isFile() && d.name.endsWith(".md")).length;
        } catch { /* notes dir missing */ }

        const staleCount = Math.max(0, noteFileCount - indexedCount);
        const builtAt = meta.built_at ?? null;
        const hoursSinceBuild = builtAt
          ? (Date.now() - new Date(builtAt).getTime()) / 3_600_000
          : null;

        payload.indexHealth = {
          indexed: indexedCount,
          totalNotes: noteFileCount,
          stale: staleCount,
          coveragePercent: noteFileCount > 0
            ? Math.round((indexedCount / noteFileCount) * 100)
            : 100,
          builtAt,
          hoursSinceBuild: hoursSinceBuild !== null ? Math.round(hoursSinceBuild * 10) / 10 : null,
          warning: staleCount > 10
            ? `${staleCount} notes not indexed — warmth signal is degraded. Run ori_index_build.`
            : hoursSinceBuild !== null && hoursSinceBuild > 48
              ? `Index is ${Math.round(hoursSinceBuild)}h old — consider running ori_index_build.`
              : null,
        };
      } catch {
        // No DB or no boosts table yet — skip
      }

      // Include onboarding steps when first-run detected
      if (payload.firstRun) {
        payload.onboarding = {
          steps: [
            "Ask the user to NAME their agent (default: Ori)",
            "Ask the PURPOSE — offer: general-purpose AI agent, personal knowledge, research, work/professional, learning journal, or custom",
            "BRAIN DUMP — ask them to share everything about themselves, projects, goals. More context = better agent from day one",
            "COMMUNICATION STYLE — how should the agent talk? Direct? Formal? Casual? Opinionated?",
          ],
          save_with: "Use ori_update to write identity, goals, and methodology based on their answers",
        };
      }

      return textResult(payload);
    }
  );

  // ori_update — write to self/ or ops/ files with auto-backup
  server.tool(
    "ori_update",
    "Update agent files: identity, goals, methodology (self/), or daily, reminders (ops/). " +
      "Auto-backs up previous version before writing.",
    {
      file: z.enum(["identity", "goals", "methodology", "daily", "reminders"])
        .describe("Which file to update"),
      content: z.string().describe("Full new content for the file"),
    },
    async ({ file, content }) => {
      const resolver = UPDATABLE_FILES[file];
      if (!resolver) return errorResult(`Unknown file: ${file}`);
      const filePath = resolver(paths);

      // Auto-backup before overwrite
      const existing = await safeReadFile(filePath);
      if (existing) {
        const historyDir = path.join(path.dirname(filePath), ".history");
        await fs.mkdir(historyDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        await fs.writeFile(path.join(historyDir, `${file}-${ts}.md`), existing);
      }

      // Ensure parent directory exists
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, "utf8");

      // Log update event to reward accumulator
      rewardAccumulator.logUpdate(file);

      return textResult({
        success: true,
        file: filePath,
        backed_up: !!existing,
        updated: new Date().toISOString(),
      });
    }
  );

  // ori_status
  server.tool("ori_status", "Vault overview", {}, async () => {
    const result = await runStatus(vaultDir, await graphCache.get(paths.notes));
    return textResult(result);
  });

  // ori_query
  server.tool(
    "ori_query",
    "Query the vault (orphans, dangling, backlinks, cross-project)",
    {
      kind: z.string().describe("Query kind: orphans | dangling | backlinks | cross-project"),
      note: z.string().optional().describe("Note title (required for backlinks)"),
    },
    async ({ kind, note }) => {
      const linkGraph = await graphCache.get(paths.notes);
      switch (kind) {
        case "orphans":
          return textResult(await runQueryOrphans(vaultDir, linkGraph));
        case "dangling":
          return textResult(await runQueryDangling(vaultDir, linkGraph));
        case "backlinks":
          if (!note) return errorResult("note required for backlinks query");
          return textResult(await runQueryBacklinks(vaultDir, note, linkGraph));
        case "cross-project":
          return textResult(await runQueryCrossProject(vaultDir));
        default:
          return errorResult(`unknown query kind: ${kind}`);
      }
    }
  );

  // ori_add
  server.tool(
    "ori_add",
    "Create a note in inbox",
    {
      title: z.string().describe("Note title (prose-as-title)"),
      type: z.string().optional().describe("Note type (default: insight)"),
      content: z
        .string()
        .optional()
        .describe(
          "Note body content. If omitted, creates a template stub that must be filled before promotion."
        ),
    },
    async ({ title, type, content }) => {
      const result = await runAdd({
        startDir: vaultDir,
        title,
        type: type ?? "insight",
        content: content ?? undefined,
      });

      // Log to reward accumulator for forward citation detection
      if (result.success) {
        rewardAccumulator.logAdd(title, content ?? "");
      }

      return textResult(result);
    }
  );

  // ori_validate
  server.tool(
    "ori_validate",
    "Validate a note against schema",
    {
      path: z.string().describe("Path to note file"),
    },
    async ({ path }) => {
      const result = await runValidate({ notePath: path });
      return textResult(result);
    }
  );

  // ori_health
  server.tool("ori_health", "Full diagnostic", {}, async () => {
    const result = await runHealth(vaultDir, await graphCache.get(paths.notes));
    return textResult(result);
  });

  // ori_promote
  server.tool(
    "ori_promote",
    "Promote an inbox note to notes/ with classification, linking, and area assignment. " +
      "YOU are the intelligence layer — read the note, decide its type, write a description, " +
      "identify links to existing notes, and pass your decisions as overrides. " +
      "Heuristics run as fallback for anything you don't specify.",
    {
      path: z.string().describe("Inbox note filename or path"),
      type: z.string().optional().describe("Your classification: idea | decision | learning | insight | blocker | opportunity"),
      description: z.string().optional().describe("One sentence adding context beyond the title (max 200 chars)"),
      links: z.array(z.string()).optional().describe("Existing note titles this note should link to"),
      project: z.array(z.string()).optional().describe("Project tags that apply to this note"),
      dry_run: z.boolean().optional().describe("Preview changes without writing"),
    },
    async ({ path, type, description, links, project, dry_run }) => {
      const result = await runPromote({
        startDir: vaultDir,
        noteName: path,
        dryRun: dry_run === true,
        type: type ?? undefined,
        description: description ?? undefined,
        links: links ?? undefined,
        project: project ?? undefined,
      });
      if (dry_run !== true && result.success) {
        graphCache.invalidate();
      }
      return textResult(result);
    }
  );

  // ori_query_ranked
  server.tool(
    "ori_query_ranked",
    "Full ranked retrieval with Q-value reranking, co-occurrence PPR, and stage meta-learning. " +
      "4 base signals (composite + keyword + graph + warmth) fused via RRF, then Phase B Q-value reranking. " +
      "Excludes archived notes by default. Triggers spreading activation.",
    {
      query: z.string().describe("Natural language search query"),
      limit: z.number().optional().describe("Max results (default 10)"),
      include_archived: z.boolean().optional().describe("Include archived notes (default: false)"),
    },
    async ({ query, limit, include_archived }) => {
      const result = await runQueryRanked(
        vaultDir,
        query,
        limit,
        include_archived ? false : true,
        await graphCache.get(paths.notes),
        intelligenceDb ?? undefined,
        sessionId,
        sessionStageTracker,
      );

      // Log retrievals to reward accumulator for session-end credit assignment
      if (result.success && result.data.results.length > 0) {
        const intent = result.data.intent ?? "semantic";
        for (const [rank, note] of result.data.results.entries()) {
          rewardAccumulator.logRetrieval(note.title, rank, query, intent);
        }
        // Capture query features for stage meta-learning (use last query's features)
        const { extractQueryFeatures } = await import("../core/stage-learner.js");
        sessionQueryFeatures = extractQueryFeatures(query, 0, result.data.count, 0);
      }

      return textResult(result);
    }
  );

  // ori_warmth
  server.tool(
    "ori_warmth",
    "Associative warmth field for the current context. Returns low-token note titles, scores, and sources showing what memory is resonating before and alongside retrieval.",
    {
      context: z.string().describe("Current conversation text or retrieval context"),
      limit: z.number().optional().describe("Max warmth signals to return (default 20)"),
    },
    async ({ context, limit }) => {
      const result = await runQueryWarmth(
        vaultDir,
        context,
        limit,
        await graphCache.get(paths.notes),
      );
      return textResult(result);
    }
  );

  // ori_query_similar
  server.tool(
    "ori_query_similar",
    "Composite vector search only (semantic + metadata, no keyword/graph). Faster but single-signal. Excludes archived notes by default.",
    {
      query: z.string().describe("Natural language search query"),
      limit: z.number().optional().describe("Max results (default 10)"),
      include_archived: z.boolean().optional().describe("Include archived notes (default: false)"),
    },
    async ({ query, limit, include_archived }) => {
      const result = await runQuerySimilar(
        vaultDir,
        query,
        limit,
        include_archived ? false : true,
        await graphCache.get(paths.notes),
      );
      return textResult(result);
    }
  );

  // ori_query_important
  server.tool(
    "ori_query_important",
    "Notes ranked by PageRank importance — structural authority in the knowledge graph.",
    {
      limit: z.number().optional().describe("Max results (default 10)"),
    },
    async ({ limit }) => {
      const result = await runQueryImportant(
        vaultDir,
        limit,
        await graphCache.get(paths.notes),
      );
      return textResult(result);
    }
  );

  // ori_query_fading (limit bug fixed)
  server.tool(
    "ori_query_fading",
    "Notes losing vitality — candidates for archival or reconnection. Use ori_prune for full topology analysis.",
    {
      threshold: z.number().optional().describe("Vitality threshold (default 0.3)"),
      limit: z.number().optional().describe("Max results (default 20)"),
    },
    async ({ threshold, limit }) => {
      const result = await runQueryFading(
        vaultDir,
        threshold,
        limit,
        await graphCache.get(paths.notes),
      );
      return textResult(result);
    }
  );

  // ori_prune
  server.tool(
    "ori_prune",
    "Analyze activation topology and identify archive candidates. " +
      "Dry-run by default. Set apply=true to archive.",
    {
      apply: z.boolean().optional().describe("Actually archive (default: dry-run preview)"),
    },
    async ({ apply }) => {
      const result = await runPrune({
        startDir: vaultDir,
        dryRun: apply !== true,
      });
      if (apply === true && result.success) {
        graphCache.invalidate();
      }
      return textResult(result);
    }
  );

  // ori_index_build
  server.tool(
    "ori_index_build",
    "Build or update the embedding index. Only re-embeds changed notes unless force=true. " +
      "Also bootstraps co-occurrence edges from wiki-link structure.",
    {
      force: z.boolean().optional().describe("Rebuild all embeddings (default false)"),
    },
    async ({ force }) => {
      const result = await runIndexBuild(vaultDir, force === true);
      graphCache.invalidate();

      // Bootstrap co-occurrence edges from wiki-links (Layer 2 day-0 edges)
      if (intelligenceDb) {
        try {
          const linkGraph = await graphCache.get(paths.notes);
          const noteLinks = new Map<string, Set<string>>();
          for (const [src, targets] of linkGraph.outgoing) {
            noteLinks.set(src, targets);
          }
          bootstrapFromWikiLinks(intelligenceDb, noteLinks);
        } catch {
          // Non-critical — bootstrap is best-effort
        }
      }

      return textResult(result);
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
