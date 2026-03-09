import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runInit } from "../../src/cli/init.js";
import { runArchive } from "../../src/cli/archive.js";
import { stringifyFrontmatter, readFrontmatterFile } from "../../src/core/frontmatter.js";
import { loadConfig } from "../../src/core/config.js";
import { initDB } from "../../src/core/engine.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ori-archive-test-"));
  await runInit({ targetDir: tmpDir });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function vectorBuffer(fill: number = 0.1): Buffer {
  const vec = new Float32Array(4).fill(fill);
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

async function writeNote(
  title: string,
  fm: Record<string, unknown>,
  body: string = "",
) {
  await fs.writeFile(
    path.join(tmpDir, "notes", `${title}.md`),
    stringifyFrontmatter(fm, body),
    "utf8",
  );
}

async function seedSQLiteRows(title: string, withBoost = false) {
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
      0.75,
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

describe("ori archive", () => {
  it("archives the note and removes its SQLite rows", async () => {
    await writeNote("archive sqlite target", {
      description: "Old isolated note",
      type: "idea",
      status: "active",
      created: "2020-01-01",
      last_accessed: "2020-01-01",
    });
    await seedSQLiteRows("archive sqlite target", true);

    const result = await runArchive({ startDir: tmpDir, dryRun: false });

    expect(result.success).toBe(true);
    expect(result.data.archived.map((note) => note.note)).toContain(
      "archive sqlite target",
    );

    const { data } = await readFrontmatterFile(
      path.join(tmpDir, "notes", "archive sqlite target.md"),
    );
    expect(data?.status).toBe("archived");

    const counts = await getSQLiteCounts("archive sqlite target");
    expect(counts.embeddings).toBe(0);
    expect(counts.boosts).toBe(0);
  });
});
