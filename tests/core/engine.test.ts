import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdirSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";

import {
  cosine,
  encodePiecewiseLinear,
  encodeType,
  encodeCommunity,
  hashContent,
  buildKnowledgeEnrichedText,
  initDB,
  loadVectors,
  buildIndex,
  removeNoteFromDB,
} from "../../src/core/engine.js";
import { stringifyFrontmatter } from "../../src/core/frontmatter.js";
import { runInit } from "../../src/cli/init.js";
import { loadConfig } from "../../src/core/config.js";
import type { LinkGraph } from "../../src/core/graph.js";

function vectorBuffer(fill: number = 0.1): Buffer {
  const vec = new Float32Array(4).fill(fill);
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function insertEmbeddingRow(
  db: ReturnType<typeof initDB>,
  title: string,
  contentHash: string = "hash",
) {
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
    contentHash,
    "2026-03-01T00:00:00.000Z",
  );
}

function insertBoostRow(db: ReturnType<typeof initDB>, title: string, boost = 0.5) {
  db.prepare(
    "INSERT INTO boosts (title, boost, updated) VALUES (?, ?, ?)",
  ).run(title, boost, "2026-03-01T00:00:00.000Z");
}

// ---------------------------------------------------------------------------
// cosine
// ---------------------------------------------------------------------------

describe("cosine", () => {
  it("returns 1.0 for identical vectors", () => {
    const a = new Float32Array([1, 2, 3]);
    expect(cosine(a, a)).toBeCloseTo(1.0, 5);
  });

  it("returns 0.0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosine(a, b)).toBeCloseTo(0.0, 5);
  });

  it("returns -1.0 for opposite vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(cosine(a, b)).toBeCloseTo(-1.0, 5);
  });

  it("returns 0 for empty vectors", () => {
    const a = new Float32Array([]);
    expect(cosine(a, a)).toBe(0);
  });

  it("returns 0 for mismatched lengths", () => {
    const a = new Float32Array([1, 2]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosine(a, b)).toBe(0);
  });

  it("returns 0 for zero vectors", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosine(a, b)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// encodePiecewiseLinear
// ---------------------------------------------------------------------------

describe("encodePiecewiseLinear", () => {
  it("value 0.0 -> first bin zero, all bins zero", () => {
    const vec = encodePiecewiseLinear(0.0, 8);
    expect(vec.length).toBe(8);
    // 0 * 8 = 0, bin 0, frac 0 -> all zeros
    for (let i = 0; i < 8; i++) {
      expect(vec[i]).toBe(0);
    }
  });

  it("value 1.0 -> all bins full", () => {
    const vec = encodePiecewiseLinear(1.0, 8);
    expect(vec.length).toBe(8);
    for (let i = 0; i < 8; i++) {
      expect(vec[i]).toBe(1.0);
    }
  });

  it("value 0.5 -> first 4 bins active (thermometer encoding)", () => {
    const vec = encodePiecewiseLinear(0.5, 8);
    expect(vec.length).toBe(8);
    // 0.5 * 8 = 4.0, binIndex = 4, frac = 0
    // bins 0-3 = 1.0, bin 4 = 0, bins 5-7 = 0
    for (let i = 0; i < 4; i++) {
      expect(vec[i]).toBe(1.0);
    }
    expect(vec[4]).toBeCloseTo(0.0, 5);
    for (let i = 5; i < 8; i++) {
      expect(vec[i]).toBe(0);
    }
  });

  it("value 0.73 with 8 bins -> partial activation in bin 5", () => {
    const vec = encodePiecewiseLinear(0.73, 8);
    // 0.73 * 8 = 5.84, binIndex = 5, frac = 0.84
    // bins 0-4 = 1.0, bin 5 = 0.84, bins 6-7 = 0
    for (let i = 0; i < 5; i++) {
      expect(vec[i]).toBe(1.0);
    }
    expect(vec[5]).toBeCloseTo(0.84, 2);
    expect(vec[6]).toBe(0);
    expect(vec[7]).toBe(0);
  });

  it("clamps values below 0", () => {
    const vec = encodePiecewiseLinear(-0.5, 4);
    for (let i = 0; i < 4; i++) {
      expect(vec[i]).toBe(0);
    }
  });

  it("clamps values above 1", () => {
    const vec = encodePiecewiseLinear(1.5, 4);
    for (let i = 0; i < 4; i++) {
      expect(vec[i]).toBe(1.0);
    }
  });
});

// ---------------------------------------------------------------------------
// encodeType
// ---------------------------------------------------------------------------

describe("encodeType", () => {
  it("encodes 'idea' as one-hot at index 0", () => {
    const vec = encodeType("idea");
    expect(vec.length).toBe(6);
    expect(vec[0]).toBe(1.0);
    for (let i = 1; i < 6; i++) {
      expect(vec[i]).toBe(0);
    }
  });

  it("encodes 'decision' as one-hot at index 1", () => {
    const vec = encodeType("decision");
    expect(vec[1]).toBe(1.0);
    expect(vec[0]).toBe(0);
  });

  it("encodes 'learning' at index 2", () => {
    expect(encodeType("learning")[2]).toBe(1.0);
  });

  it("encodes 'insight' at index 3", () => {
    expect(encodeType("insight")[3]).toBe(1.0);
  });

  it("encodes 'blocker' at index 4", () => {
    expect(encodeType("blocker")[4]).toBe(1.0);
  });

  it("encodes 'opportunity' at index 5", () => {
    expect(encodeType("opportunity")[5]).toBe(1.0);
  });

  it("returns zero vector for unknown type", () => {
    const vec = encodeType("unknown-type");
    expect(vec.length).toBe(6);
    for (let i = 0; i < 6; i++) {
      expect(vec[i]).toBe(0);
    }
  });

  it("returns zero vector for empty string", () => {
    const vec = encodeType("");
    for (let i = 0; i < 6; i++) {
      expect(vec[i]).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// encodeCommunity
// ---------------------------------------------------------------------------

describe("encodeCommunity", () => {
  it("different communities produce different vectors", () => {
    const a = encodeCommunity(0, 10, 16);
    const b = encodeCommunity(1, 10, 16);
    expect(a.length).toBe(16);
    expect(b.length).toBe(16);
    // At least one dimension must differ
    let differs = false;
    for (let i = 0; i < 16; i++) {
      if (Math.abs(a[i]! - b[i]!) > 1e-6) {
        differs = true;
        break;
      }
    }
    expect(differs).toBe(true);
  });

  it("same community produces identical vectors", () => {
    const a = encodeCommunity(5, 10, 16);
    const b = encodeCommunity(5, 10, 16);
    for (let i = 0; i < 16; i++) {
      expect(a[i]).toBe(b[i]);
    }
  });

  it("handles totalCommunities = 0 without NaN", () => {
    const vec = encodeCommunity(3, 0, 8);
    for (let i = 0; i < 8; i++) {
      expect(Number.isNaN(vec[i])).toBe(false);
    }
  });

  it("respects requested dims", () => {
    expect(encodeCommunity(1, 5, 4).length).toBe(4);
    expect(encodeCommunity(1, 5, 32).length).toBe(32);
  });
});

// ---------------------------------------------------------------------------
// hashContent
// ---------------------------------------------------------------------------

describe("hashContent", () => {
  it("returns same hash for same content", () => {
    const a = hashContent("hello world");
    const b = hashContent("hello world");
    expect(a).toBe(b);
  });

  it("returns different hash for different content", () => {
    const a = hashContent("hello");
    const b = hashContent("world");
    expect(a).not.toBe(b);
  });

  it("returns a 64-char hex string (sha256)", () => {
    const h = hashContent("test");
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// buildKnowledgeEnrichedText
// ---------------------------------------------------------------------------

describe("buildKnowledgeEnrichedText", () => {
  const emptyGraph: LinkGraph = {
    outgoing: new Map(),
    incoming: new Map(),
  };

  it("includes type and projects on first line", () => {
    const text = buildKnowledgeEnrichedText(
      "my note title",
      { type: "decision", project: ["crypto", "courtshare"] },
      "body content",
      emptyGraph,
    );
    const lines = text.split("\n");
    expect(lines[0]).toBe("[DECISION] [crypto, courtshare]");
    expect(lines[1]).toBe("my note title");
  });

  it("includes description when present", () => {
    const text = buildKnowledgeEnrichedText(
      "title",
      { type: "idea", description: "A great idea" },
      "body",
      emptyGraph,
    );
    expect(text).toContain("A great idea");
  });

  it("includes connected notes from link graph", () => {
    const graph: LinkGraph = {
      outgoing: new Map([["my note", new Set(["note a", "note b"])]]),
      incoming: new Map(),
    };
    const text = buildKnowledgeEnrichedText(
      "my note",
      { type: "insight" },
      "body",
      graph,
    );
    expect(text).toContain("Connected: note a, note b");
  });

  it("handles missing optional fields gracefully", () => {
    const text = buildKnowledgeEnrichedText("bare title", {}, "body", emptyGraph);
    // Should at least have the title
    expect(text).toContain("bare title");
    // No [TYPE] line since type is empty
    expect(text).not.toContain("[");
  });

  it("limits connected notes to 10", () => {
    const links = new Set<string>();
    for (let i = 0; i < 15; i++) links.add(`note-${i}`);
    const graph: LinkGraph = {
      outgoing: new Map([["hub", links]]),
      incoming: new Map(),
    };
    const text = buildKnowledgeEnrichedText("hub", { type: "idea" }, "body", graph);
    const connectedLine = text.split("\n").find((l) => l.startsWith("Connected:"));
    expect(connectedLine).toBeDefined();
    const parts = connectedLine!.split(",");
    expect(parts.length).toBeLessThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// initDB
// ---------------------------------------------------------------------------

describe("initDB", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `ori-engine-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  });

  it("creates database with embeddings and meta tables", () => {
    const dbPath = path.join(tmpDir, "sub", "test.db");
    const db = initDB(dbPath);

    // Check tables exist
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("embeddings");
    expect(names).toContain("meta");

    // Check embeddings columns
    const cols = db.prepare("PRAGMA table_info(embeddings)").all() as Array<{
      name: string;
      type: string;
    }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("title");
    expect(colNames).toContain("title_vec");
    expect(colNames).toContain("desc_vec");
    expect(colNames).toContain("body_vec");
    expect(colNames).toContain("type_vec");
    expect(colNames).toContain("community_vec");
    expect(colNames).toContain("content_hash");
    expect(colNames).toContain("indexed_at");

    db.close();
  });

  it("creates parent directories as needed", () => {
    const dbPath = path.join(tmpDir, "a", "b", "c", "test.db");
    const db = initDB(dbPath);
    expect(db).toBeDefined();
    db.close();
  });

  it("is idempotent — calling twice does not fail", () => {
    const dbPath = path.join(tmpDir, "idem.db");
    const db1 = initDB(dbPath);
    db1.close();
    const db2 = initDB(dbPath);
    db2.close();
  });
});

// ---------------------------------------------------------------------------
// loadVectors round-trip
// ---------------------------------------------------------------------------

describe("loadVectors", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `ori-load-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it("round-trips vectors through SQLite", () => {
    const dbPath = path.join(tmpDir, "rt.db");
    const db = initDB(dbPath);

    const titleVec = new Float32Array(384).fill(0.1);
    const descVec = new Float32Array(384).fill(0.2);
    const bodyVec = new Float32Array(384).fill(0.3);
    const typeVec = encodeType("decision");
    const communityVec = encodeCommunity(3, 10, 16);

    const toBuffer = (a: Float32Array) =>
      Buffer.from(a.buffer, a.byteOffset, a.byteLength);

    db.prepare(
      `INSERT INTO embeddings (title, title_vec, desc_vec, body_vec, type_vec, community_vec, content_hash, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "test note",
      toBuffer(titleVec),
      toBuffer(descVec),
      toBuffer(bodyVec),
      toBuffer(typeVec),
      toBuffer(communityVec),
      "abc123",
      "2026-02-25T00:00:00Z",
    );

    const loaded = loadVectors(db);
    expect(loaded.size).toBe(1);

    const entry = loaded.get("test note")!;
    expect(entry).toBeDefined();
    expect(entry.titleVec.length).toBe(384);
    expect(entry.descVec.length).toBe(384);
    expect(entry.bodyVec.length).toBe(384);
    expect(entry.typeVec.length).toBe(6);
    expect(entry.communityVec.length).toBe(16);
    expect(entry.contentHash).toBe("abc123");
    expect(entry.indexedAt).toBe("2026-02-25T00:00:00Z");

    // Check values survived the round trip
    expect(entry.titleVec[0]).toBeCloseTo(0.1, 5);
    expect(entry.descVec[0]).toBeCloseTo(0.2, 5);
    expect(entry.typeVec[1]).toBe(1.0); // decision at index 1

    db.close();
  });

  it("returns empty map for empty database", () => {
    const dbPath = path.join(tmpDir, "empty.db");
    const db = initDB(dbPath);
    const loaded = loadVectors(db);
    expect(loaded.size).toBe(0);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// searchComposite scoring logic (tested via components — embedText requires model)
// ---------------------------------------------------------------------------

describe("searchComposite scoring logic", () => {
  it("aligned query vector produces higher text score than orthogonal", () => {
    const queryVec = new Float32Array(384);
    queryVec[0] = 1.0;

    const alignedVec = new Float32Array(384);
    alignedVec[0] = 1.0;

    const orthogonalVec = new Float32Array(384);
    orthogonalVec[1] = 1.0;

    // Simulate the split-weighted text score calculation from searchComposite
    const splitW = { title: 0.5, description: 0.3, body: 0.2 };

    const textScoreAligned =
      splitW.title * cosine(queryVec, alignedVec) +
      splitW.description * cosine(queryVec, alignedVec) +
      splitW.body * cosine(queryVec, alignedVec);

    const textScoreOrthogonal =
      splitW.title * cosine(queryVec, orthogonalVec) +
      splitW.description * cosine(queryVec, orthogonalVec) +
      splitW.body * cosine(queryVec, orthogonalVec);

    expect(textScoreAligned).toBeCloseTo(1.0, 5);
    expect(textScoreOrthogonal).toBeCloseTo(0.0, 5);
    expect(textScoreAligned).toBeGreaterThan(textScoreOrthogonal);
  });

  it("space weights sum determines relative contribution of each signal", () => {
    const sw = {
      text: 0.65,
      temporal: 0.05,
      vitality: 0.10,
      importance: 0.10,
      type: 0.05,
      community: 0.05,
    };
    const total = sw.text + sw.temporal + sw.vitality + sw.importance + sw.type + sw.community;
    expect(total).toBeCloseTo(1.0, 5);
  });

  it("type encoding + cosine correctly matches intent to note type", () => {
    // A "decision" intent query should score "decision" notes higher
    // than "idea" notes via the type space.
    const decisionTypeVec = encodeType("decision");
    const ideaTypeVec = encodeType("idea");

    // Decision intent query type vector (index 1 = 1.0)
    const queryTypeVec = new Float32Array(6);
    queryTypeVec[1] = 1.0; // decision

    const decisionScore = cosine(queryTypeVec, decisionTypeVec);
    const ideaScore = cosine(queryTypeVec, ideaTypeVec);

    expect(decisionScore).toBeCloseTo(1.0, 5);
    expect(ideaScore).toBeCloseTo(0.0, 5);
  });

  it("temporal recency encoding favors recent notes", () => {
    const bins = 8;
    const queryTemporalVec = encodePiecewiseLinear(1.0, bins); // want recent

    const recentVec = encodePiecewiseLinear(0.95, bins); // very recent
    const staleVec = encodePiecewiseLinear(0.1, bins);   // old

    const recentScore = cosine(queryTemporalVec, recentVec);
    const staleScore = cosine(queryTemporalVec, staleVec);

    expect(recentScore).toBeGreaterThan(staleScore);
  });
});

// ---------------------------------------------------------------------------
// Integration: encoding -> cosine consistency
// ---------------------------------------------------------------------------

describe("encoding-cosine integration", () => {
  it("same type encodings have cosine 1.0", () => {
    const a = encodeType("decision");
    const b = encodeType("decision");
    expect(cosine(a, b)).toBeCloseTo(1.0, 5);
  });

  it("different type encodings have cosine 0.0", () => {
    const a = encodeType("decision");
    const b = encodeType("idea");
    expect(cosine(a, b)).toBeCloseTo(0.0, 5);
  });

  it("higher PWL values produce higher cosine with target=1.0 vector", () => {
    const target = encodePiecewiseLinear(1.0, 8);
    const high = encodePiecewiseLinear(0.9, 8);
    const low = encodePiecewiseLinear(0.2, 8);

    const simHigh = cosine(target, high);
    const simLow = cosine(target, low);
    expect(simHigh).toBeGreaterThan(simLow);
  });

  it("same community has perfect cosine match", () => {
    const a = encodeCommunity(7, 20, 16);
    const b = encodeCommunity(7, 20, 16);
    expect(cosine(a, b)).toBeCloseTo(1.0, 5);
  });
});

// ---------------------------------------------------------------------------
// removeNoteFromDB and buildIndex cleanup
// ---------------------------------------------------------------------------

describe("removeNoteFromDB", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(
      os.tmpdir(),
      `ori-remove-note-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("deletes from both embeddings and boosts tables", () => {
    const db = initDB(path.join(tmpDir, "cleanup.db"));
    insertEmbeddingRow(db, "cleanup target");
    insertBoostRow(db, "cleanup target");

    removeNoteFromDB(db, "cleanup target");

    const embeddingCount = (
      db.prepare("SELECT COUNT(*) as cnt FROM embeddings WHERE title = ?").get("cleanup target") as { cnt: number }
    ).cnt;
    const boostCount = (
      db.prepare("SELECT COUNT(*) as cnt FROM boosts WHERE title = ?").get("cleanup target") as { cnt: number }
    ).cnt;

    expect(embeddingCount).toBe(0);
    expect(boostCount).toBe(0);
    db.close();
  });

  it("is safe for non-existent titles", () => {
    const db = initDB(path.join(tmpDir, "cleanup-safe.db"));
    insertEmbeddingRow(db, "keep me");
    insertBoostRow(db, "keep me");

    expect(() => removeNoteFromDB(db, "missing note")).not.toThrow();

    const embeddingCount = (
      db.prepare("SELECT COUNT(*) as cnt FROM embeddings WHERE title = ?").get("keep me") as { cnt: number }
    ).cnt;
    const boostCount = (
      db.prepare("SELECT COUNT(*) as cnt FROM boosts WHERE title = ?").get("keep me") as { cnt: number }
    ).cnt;

    expect(embeddingCount).toBe(1);
    expect(boostCount).toBe(1);
    db.close();
  });
});

describe("buildIndex cleanup", () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = path.join(
      os.tmpdir(),
      `ori-build-index-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await runInit({ targetDir: vaultDir });
  });

  afterEach(() => {
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it("cleans up stale rows for deleted notes", async () => {
    const activeContent = stringifyFrontmatter(
      {
        description: "still here",
        type: "idea",
        status: "active",
        created: "2026-03-01",
      },
      "Body",
    );
    await fs.writeFile(
      path.join(vaultDir, "notes", "kept note.md"),
      activeContent,
      "utf8",
    );

    const config = await loadConfig(path.join(vaultDir, "ori.config.yaml"));
    const db = initDB(path.resolve(vaultDir, config.engine.db_path));
    insertEmbeddingRow(
      db,
      "kept note",
      hashContent("kept note\nstill here\nBody"),
    );
    insertEmbeddingRow(db, "deleted note", "stale-hash");
    insertBoostRow(db, "deleted note");
    db.close();

    const stats = await buildIndex(vaultDir, config.engine);
    const verifyDb = initDB(path.resolve(vaultDir, config.engine.db_path));
    const keptCount = (
      verifyDb.prepare("SELECT COUNT(*) as cnt FROM embeddings WHERE title = ?").get("kept note") as { cnt: number }
    ).cnt;
    const deletedEmbeddingCount = (
      verifyDb.prepare("SELECT COUNT(*) as cnt FROM embeddings WHERE title = ?").get("deleted note") as { cnt: number }
    ).cnt;
    const deletedBoostCount = (
      verifyDb.prepare("SELECT COUNT(*) as cnt FROM boosts WHERE title = ?").get("deleted note") as { cnt: number }
    ).cnt;

    expect(stats.total).toBeGreaterThanOrEqual(1);
    expect(keptCount).toBe(1);
    expect(deletedEmbeddingCount).toBe(0);
    expect(deletedBoostCount).toBe(0);
    verifyDb.close();
  });

  it("cleans up rows for archived notes and does not count them as indexable", async () => {
    await fs.writeFile(
      path.join(vaultDir, "notes", "active note.md"),
      stringifyFrontmatter(
        {
          description: "active note",
          type: "idea",
          status: "active",
          created: "2026-03-01",
        },
        "Body",
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(vaultDir, "notes", "archived note.md"),
      stringifyFrontmatter(
        {
          description: "archived note",
          type: "idea",
          status: "archived",
          created: "2026-03-01",
        },
        "Body",
      ),
      "utf8",
    );

    const config = await loadConfig(path.join(vaultDir, "ori.config.yaml"));
    const db = initDB(path.resolve(vaultDir, config.engine.db_path));
    insertEmbeddingRow(
      db,
      "active note",
      hashContent("active note\nactive note\nBody"),
    );
    insertEmbeddingRow(db, "archived note", "archived-hash");
    insertBoostRow(db, "archived note");
    db.close();

    const stats = await buildIndex(vaultDir, config.engine);
    const verifyDb = initDB(path.resolve(vaultDir, config.engine.db_path));
    const activeCount = (
      verifyDb.prepare("SELECT COUNT(*) as cnt FROM embeddings WHERE title = ?").get("active note") as { cnt: number }
    ).cnt;
    const archivedEmbeddingCount = (
      verifyDb.prepare("SELECT COUNT(*) as cnt FROM embeddings WHERE title = ?").get("archived note") as { cnt: number }
    ).cnt;
    const archivedBoostCount = (
      verifyDb.prepare("SELECT COUNT(*) as cnt FROM boosts WHERE title = ?").get("archived note") as { cnt: number }
    ).cnt;

    expect(stats.total).toBeGreaterThanOrEqual(1);
    expect(activeCount).toBe(1);
    expect(archivedEmbeddingCount).toBe(0);
    expect(archivedBoostCount).toBe(0);
    verifyDb.close();
  });
});
