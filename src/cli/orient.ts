import { promises as fs } from "node:fs";
import path from "node:path";
import { runStatus } from "./status.js";
import { findVaultRootWithSource, getVaultPaths, type VaultPaths } from "../core/vault.js";
import { GraphCache } from "../core/graph.js";
import { initDB } from "../core/engine.js";
import { parseFrontmatter } from "../core/frontmatter.js";
import { checkForUpdate } from "../core/update-check.js";

// --- Identity helpers (mirrors serve.ts; intentionally small + stable) ---

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

export interface BuildOrientOptions {
  vaultDir: string;
  paths: VaultPaths;
  graphCache: GraphCache;
  /** Quick status only — skip identity and methodology. */
  brief: boolean;
}

/**
 * Build the session-briefing payload returned by both the `ori_orient` MCP
 * tool and the `ori orient` CLI command. Keeping this in one place means the
 * MCP transport and the CLI never drift, and a deterministic session-start
 * hook can shell out to `ori orient` to get exactly what the model would get
 * from calling the tool itself.
 */
export async function buildOrientPayload(
  opts: BuildOrientOptions,
): Promise<Record<string, unknown>> {
  const { vaultDir, paths, graphCache, brief: isBrief } = opts;

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
    const db = initDB(dbPath);
    const boostCount = (
      db.prepare("SELECT COUNT(*) as cnt FROM boosts").get() as { cnt: number }
    ).cnt;
    if (boostCount > 0) {
      payload.activationActive = true;
      payload.boostCount = boostCount;
    }

    // --- Warmth landscape: what's active in memory ---
    const topBoosts = db.prepare(`
      SELECT title, boost, updated,
        boost * exp(-0.1 * (julianday('now') - julianday(updated))) as decayed,
        (julianday('now') - julianday(updated)) as days_since
      FROM boosts
      WHERE boost * exp(-0.1 * (julianday('now') - julianday(updated))) > 0.001
      ORDER BY decayed DESC
      LIMIT 15
    `).all() as Array<{ title: string; boost: number; updated: string; decayed: number; days_since: number }>;

    const topQ = db.prepare(`
      SELECT note_id, q_value, update_count
      FROM note_q
      WHERE q_value > 0.5
      ORDER BY q_value DESC
      LIMIT 10
    `).all() as Array<{ note_id: string; q_value: number; update_count: number }>;

    // Merge and deduplicate
    const qMap = new Map(topQ.map(r => [r.note_id, r.q_value]));
    const seen = new Set<string>();
    const warmNotes: Array<{
      title: string; boost: number; qValue: number;
      warmth: number; daysSince: number; project: string[];
    }> = [];

    for (const b of topBoosts) {
      seen.add(b.title);
      const q = qMap.get(b.title) ?? 0.5;
      warmNotes.push({
        title: b.title,
        boost: Math.round(b.decayed * 1000) / 1000,
        qValue: Math.round(q * 1000) / 1000,
        warmth: Math.round((0.6 * b.decayed + 0.4 * Math.max(0, q - 0.5) * 2) * 1000) / 1000,
        daysSince: Math.round(b.days_since * 10) / 10,
        project: [],
      });
    }
    for (const q of topQ) {
      if (seen.has(q.note_id)) continue;
      warmNotes.push({
        title: q.note_id,
        boost: 0,
        qValue: Math.round(q.q_value * 1000) / 1000,
        warmth: Math.round(0.4 * Math.max(0, q.q_value - 0.5) * 2 * 1000) / 1000,
        daysSince: -1,
        project: [],
      });
    }
    warmNotes.sort((a, b) => b.warmth - a.warmth);

    // Read frontmatter for top warm notes to get project tags
    for (const note of warmNotes.slice(0, 20)) {
      try {
        const content = await fs.readFile(
          path.join(paths.notes, `${note.title}.md`), "utf-8"
        );
        const { data } = parseFrontmatter(content);
        note.project = Array.isArray(data?.project) ? data.project as string[] : [];
      } catch { /* note file missing */ }
    }

    // Aggregate by project
    const byProject: Record<string, { totalWarmth: number; noteCount: number }> = {};
    for (const note of warmNotes) {
      for (const proj of note.project) {
        if (!byProject[proj]) byProject[proj] = { totalWarmth: 0, noteCount: 0 };
        byProject[proj].totalWarmth = Math.round((byProject[proj].totalWarmth + note.warmth) * 1000) / 1000;
        byProject[proj].noteCount++;
      }
    }

    // Heating/cooling detection
    const heating = warmNotes.filter(n => n.daysSince >= 0 && n.daysSince < 1 && n.boost > 0.1).map(n => n.title);
    const cooling = warmNotes.filter(n => n.daysSince > 3).map(n => n.title);

    if (warmNotes.length > 0) {
      payload.warmthLandscape = {
        topNotes: warmNotes.slice(0, 10).map(n => ({
          title: n.title,
          boost: n.boost,
          qValue: n.qValue,
          project: n.project,
          daysSinceActive: n.daysSince,
        })),
        byProject,
        heating,
        cooling,
      };
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

  // Check for updates (best-effort, cached 24h)
  try {
    const update = await checkForUpdate();
    if (update.updateAvailable) {
      payload.updateAvailable = update;
    }
  } catch {
    // Never fail orient for an update check
  }

  return payload;
}

export interface RunOrientOptions {
  /** Quick status only — skip identity and methodology (default true). */
  brief?: boolean;
  /** Explicit vault root path. */
  vault?: string;
}

export interface OrientResult {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
}

/**
 * CLI entry point: resolve the vault, then build the same briefing the
 * `ori_orient` MCP tool returns. Throws if no vault is found (callers that
 * want a soft failure should catch).
 */
export async function runOrient(
  startDir: string,
  options: RunOrientOptions = {},
): Promise<OrientResult> {
  const { path: vaultDir } = await findVaultRootWithSource(startDir, options.vault);
  const paths = getVaultPaths(vaultDir);
  const graphCache = new GraphCache();
  const payload = await buildOrientPayload({
    vaultDir,
    paths,
    graphCache,
    brief: options.brief !== false,
  });
  return { success: true, data: payload, warnings: [] };
}
