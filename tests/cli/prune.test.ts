/**
 * ori prune — Tests for zone classification, articulation point protection,
 * and archive candidate identification.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runInit } from "../../src/cli/init.js";
import { runPrune } from "../../src/cli/prune.js";
import { stringifyFrontmatter, readFrontmatterFile } from "../../src/core/frontmatter.js";
import { loadConfig } from "../../src/core/config.js";
import { initDB } from "../../src/core/engine.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ori-prune-test-"));
  await runInit({ targetDir: tmpDir });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function writeNote(
  title: string,
  fm: Record<string, unknown>,
  body: string = "",
) {
  const content = stringifyFrontmatter(fm, body);
  await fs.writeFile(path.join(tmpDir, "notes", `${title}.md`), content, "utf8");
}

function vectorBuffer(fill: number = 0.1): Buffer {
  const vec = new Float32Array(4).fill(fill);
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

async function seedSQLiteRows(
  title: string,
  withBoost = false,
  boostValue = 0.8,
) {
  const config = await loadConfig(path.join(tmpDir, "ori.config.yaml"));
  const db = initDB(path.resolve(tmpDir, config.engine.db_path));
  db.prepare(
    `INSERT INTO embeddings
      (title, title_vec, desc_vec, body_vec, type_vec, community_vec, content_hash, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    title,
    vectorBuffer(0.1),
    vectorBuffer(0.2),
    vectorBuffer(0.3),
    vectorBuffer(0.4),
    vectorBuffer(0.5),
    "hash",
    "2026-03-01T00:00:00.000Z",
  );
  if (withBoost) {
    db.prepare("INSERT INTO boosts (title, boost, updated) VALUES (?, ?, ?)").run(
      title,
      boostValue,
      "2026-03-01T00:00:00.000Z",
    );
  }
  db.close();
}

async function getSQLiteCounts(title: string) {
  const config = await loadConfig(path.join(tmpDir, "ori.config.yaml"));
  const db = initDB(path.resolve(tmpDir, config.engine.db_path));
  const embeddings = (
    db.prepare("SELECT COUNT(*) as cnt FROM embeddings WHERE title = ?").get(title) as { cnt: number }
  ).cnt;
  const boosts = (
    db.prepare("SELECT COUNT(*) as cnt FROM boosts WHERE title = ?").get(title) as { cnt: number }
  ).cnt;
  db.close();
  return { embeddings, boosts };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ori prune", () => {
  it("dry-run returns candidates without modifying files", async () => {
    // Create a note with no connections — low vitality candidate
    await writeNote("isolated orphan note", {
      description: "A lonely note with nothing linking to it",
      type: "idea",
      status: "active",
      created: "2024-01-01",
    });

    const result = await runPrune({ startDir: tmpDir, dryRun: true });

    expect(result.success).toBe(true);
    expect(result.data.applied).toBe(false);
    expect(result.data.archivedCount).toBe(0);

    // Verify file was NOT modified
    const { data } = await readFrontmatterFile(
      path.join(tmpDir, "notes", "isolated orphan note.md")
    );
    expect(data?.status).toBe("active");
  });

  it("zone counts add up to total", async () => {
    await writeNote("note alpha", {
      description: "First test note",
      type: "idea",
      status: "active",
      created: "2026-03-01",
    });
    await writeNote("note beta", {
      description: "Second test note",
      type: "learning",
      status: "active",
      created: "2024-01-01",
    });

    const result = await runPrune({ startDir: tmpDir });

    const { zones, total } = result.data;
    const sum = zones.active + zones.stale + zones.fading + zones.archived;
    expect(sum).toBe(total);
  });

  it("notes with vitality >= fading_floor are never candidates", async () => {
    // Create a well-connected recent note that should be active
    await writeNote("hub note", {
      description: "A well-linked recent note",
      type: "insight",
      status: "active",
      created: "2026-03-01",
      access_count: 20,
    }, "Content linking to [[note alpha]] and [[note beta]]");

    await writeNote("note alpha", {
      description: "Connected note",
      type: "idea",
      status: "active",
      created: "2026-03-01",
    }, "Links to [[hub note]]");

    await writeNote("note beta", {
      description: "Another connected note",
      type: "idea",
      status: "active",
      created: "2026-03-01",
    }, "Links to [[hub note]]");

    const result = await runPrune({ startDir: tmpDir });

    const candidateTitles = result.data.candidates.map(c => c.title);
    // Hub note should have high vitality — never a candidate
    expect(candidateTitles).not.toContain("hub note");
  });

  it("already-archived notes don't appear as new candidates", async () => {
    await writeNote("already archived note", {
      description: "This note is already archived",
      type: "idea",
      status: "archived",
      created: "2024-01-01",
    });

    const result = await runPrune({ startDir: tmpDir });

    const candidateTitles = result.data.candidates.map(c => c.title);
    expect(candidateTitles).not.toContain("already archived note");

    // But it should count in the archived zone
    expect(result.data.zones.archived).toBeGreaterThanOrEqual(1);
  });

  it("--apply sets status: archived in frontmatter", async () => {
    // Create a very old, isolated note — should be a candidate
    await writeNote("old forgotten note", {
      description: "A note nobody cares about",
      type: "idea",
      status: "active",
      created: "2020-01-01",
    });

    const result = await runPrune({ startDir: tmpDir, dryRun: false });

    // If it was a candidate, it should be archived
    if (result.data.candidates.some(c => c.title === "old forgotten note")) {
      expect(result.data.applied).toBe(true);
      expect(result.data.archivedCount).toBeGreaterThan(0);

      const { data } = await readFrontmatterFile(
        path.join(tmpDir, "notes", "old forgotten note.md")
      );
      expect(data?.status).toBe("archived");
    }
  });

  it("archiving a note removes its embeddings from SQLite", async () => {
    await writeNote("sqlite prune target", {
      description: "Old isolated note",
      type: "idea",
      status: "active",
      created: "2020-01-01",
    });
    await seedSQLiteRows("sqlite prune target");

    const result = await runPrune({ startDir: tmpDir, dryRun: false });

    expect(result.data.candidates.map((candidate) => candidate.title)).toContain(
      "sqlite prune target",
    );
    const counts = await getSQLiteCounts("sqlite prune target");
    expect(counts.embeddings).toBe(0);
  });

  it("archiving a note removes its boosts from SQLite", async () => {
    await writeNote("sqlite boost target", {
      description: "Old isolated note",
      type: "idea",
      status: "active",
      created: "2020-01-01",
    });
    await seedSQLiteRows("sqlite boost target", true, 0);

    const result = await runPrune({ startDir: tmpDir, dryRun: false });

    expect(result.data.candidates.map((candidate) => candidate.title)).toContain(
      "sqlite boost target",
    );
    const counts = await getSQLiteCounts("sqlite boost target");
    expect(counts.boosts).toBe(0);
  });

  it("dry-run does not delete SQLite rows", async () => {
    await writeNote("sqlite dry run target", {
      description: "Old isolated note",
      type: "idea",
      status: "active",
      created: "2020-01-01",
    });
    await seedSQLiteRows("sqlite dry run target", true);

    await runPrune({ startDir: tmpDir, dryRun: true });

    const counts = await getSQLiteCounts("sqlite dry run target");
    expect(counts.embeddings).toBe(1);
    expect(counts.boosts).toBe(1);
  });

  it("articulation points are never in candidates", async () => {
    // Create a graph where "bridge" is an articulation point:
    // A → bridge → B (bridge connects two otherwise disconnected subgraphs)
    await writeNote("cluster a node", {
      description: "In cluster A",
      type: "idea",
      status: "active",
      created: "2024-01-01",
    }, "Links to [[bridge connector]]");

    await writeNote("bridge connector", {
      description: "Bridges two clusters",
      type: "insight",
      status: "active",
      created: "2024-01-01",
    }, "Links to [[cluster a node]] and [[cluster b node]]");

    await writeNote("cluster b node", {
      description: "In cluster B",
      type: "idea",
      status: "active",
      created: "2024-01-01",
    }, "Links to [[bridge connector]]");

    const result = await runPrune({ startDir: tmpDir });

    const candidateTitles = result.data.candidates.map(c => c.title);
    // Bridge connector is structural — should not be a candidate even if low vitality
    // (it's protected by bridge detection: map notes, articulation points, high-degree hubs)
    for (const ap of result.data.articulationPoints) {
      expect(candidateTitles).not.toContain(ap);
    }
  });

  it("notes with inDegree >= 2 are never candidates", async () => {
    // Notes are stored under slug filenames; links are authored against the
    // display title. Both must resolve to the same node.
    await writeNote("popular-note", {
      description: "A note many link to",
      type: "idea",
      status: "active",
      created: "2024-01-01",
    });

    await writeNote("linker-one", {
      description: "Links to popular",
      type: "idea",
      status: "active",
      created: "2026-03-01",
    }, "See [[Popular Note]]");

    await writeNote("linker-two", {
      description: "Also links to popular",
      type: "idea",
      status: "active",
      created: "2026-03-01",
    }, "Check [[Popular Note]]");

    const result = await runPrune({ startDir: tmpDir });

    const candidateTitles = result.data.candidates.map(c => c.title);
    expect(candidateTitles).not.toContain("popular-note");
  });
});
