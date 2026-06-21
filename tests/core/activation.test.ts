import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import {
  computeActivationSpread,
  loadBoosts,
  applyActivationBoosts,
  DEFAULT_ACTIVATION_CONFIG,
} from "../../src/core/activation.js";
import type { LinkGraph } from "../../src/core/graph.js";
import { initDB } from "../../src/core/engine.js";

// ---------------------------------------------------------------------------
// Helper: build a simple link graph from edge list
// ---------------------------------------------------------------------------

function makeGraph(edges: Array<[string, string]>): LinkGraph {
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();

  for (const [source, target] of edges) {
    if (!outgoing.has(source)) outgoing.set(source, new Set());
    outgoing.get(source)!.add(target);
    if (!incoming.has(target)) incoming.set(target, new Set());
    incoming.get(target)!.add(source);
  }

  return { outgoing, incoming };
}

// ---------------------------------------------------------------------------
// computeActivationSpread
// ---------------------------------------------------------------------------

describe("computeActivationSpread", () => {
  it("linear chain A→B→C: B gets u×0.6, C gets u×0.36", () => {
    const graph = makeGraph([["A", "B"], ["B", "C"]]);
    const result = computeActivationSpread("A", 1.0, graph);

    expect(result.propagated.get("B")).toBeCloseTo(0.6, 6);
    expect(result.propagated.get("C")).toBeCloseTo(0.36, 6);
    expect(result.propagated.has("A")).toBe(false); // no self-boost
  });

  it("star graph A→{B,C,D}: all get u×0.6", () => {
    const graph = makeGraph([["A", "B"], ["A", "C"], ["A", "D"]]);
    const result = computeActivationSpread("A", 1.0, graph);

    expect(result.propagated.get("B")).toBeCloseTo(0.6, 6);
    expect(result.propagated.get("C")).toBeCloseTo(0.6, 6);
    expect(result.propagated.get("D")).toBeCloseTo(0.6, 6);
  });

  it("max hops: 3-hop neighbor gets nothing with max_hops=2", () => {
    const graph = makeGraph([["A", "B"], ["B", "C"], ["C", "D"]]);
    const result = computeActivationSpread("A", 1.0, graph);

    expect(result.propagated.has("B")).toBe(true);
    expect(result.propagated.has("C")).toBe(true);
    expect(result.propagated.has("D")).toBe(false);
  });

  it("bidirectional: A→B also flows B→A via incoming", () => {
    const graph = makeGraph([["A", "B"]]);
    const result = computeActivationSpread("B", 1.0, graph);

    // B is source. A is reachable via incoming edge (B← A, i.e. A→B, so A is in outgoing.A but B is in incoming.B)
    // Actually: A→B means outgoing.A has B, incoming.B has A.
    // From B, undirected neighbors = outgoing.B ∪ incoming.B = {} ∪ {A} = {A}
    expect(result.propagated.get("A")).toBeCloseTo(0.6, 6);
  });

  it("cycle A→B→C→A: each counted once (shortest path)", () => {
    const graph = makeGraph([["A", "B"], ["B", "C"], ["C", "A"]]);
    const result = computeActivationSpread("A", 1.0, graph);

    // B: hop 1 via outgoing A→B = 0.6
    // C: hop 1 via incoming C→A = 0.6 (undirected, A sees C as neighbor via incoming)
    // No double-counting — both B and C visited at hop 1
    expect(result.propagated.get("B")).toBeCloseTo(0.6, 6);
    expect(result.propagated.get("C")).toBeCloseTo(0.6, 6);
    expect(result.propagated.has("A")).toBe(false); // no self-boost
  });

  it("isolated node: empty map", () => {
    const graph = makeGraph([]);
    const result = computeActivationSpread("A", 1.0, graph);
    expect(result.propagated.size).toBe(0);
  });

  it("disabled config: empty map", () => {
    const graph = makeGraph([["A", "B"]]);
    const result = computeActivationSpread("A", 1.0, graph, {
      ...DEFAULT_ACTIVATION_CONFIG,
      enabled: false,
    });
    expect(result.propagated.size).toBe(0);
  });

  it("utility 0: empty map", () => {
    const graph = makeGraph([["A", "B"]]);
    const result = computeActivationSpread("A", 0, graph);
    expect(result.propagated.size).toBe(0);
  });

  it("min_boost filter: very low damped boost excluded", () => {
    const graph = makeGraph([["A", "B"], ["B", "C"]]);
    const result = computeActivationSpread("A", 0.02, graph, {
      ...DEFAULT_ACTIVATION_CONFIG,
      min_boost: 0.01,
    });

    // Hop 1: 0.02 * 0.6 = 0.012 >= 0.01 → included
    expect(result.propagated.has("B")).toBe(true);
    // Hop 2: 0.02 * 0.36 = 0.0072 < 0.01 → excluded
    expect(result.propagated.has("C")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SQLite persistence tests
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: InstanceType<typeof Database>;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ori-activation-test-"));
  const dbPath = path.join(tmpDir, ".ori", "embeddings.db");
  db = initDB(dbPath);
});

afterEach(async () => {
  try { db?.close(); } catch { /* already closed */ }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("applyActivationBoosts", () => {
  it("writes boost to DB", () => {
    const boosts = new Map([["noteA", 0.5]]);
    applyActivationBoosts(db, boosts);

    const row = db.prepare("SELECT boost, updated FROM boosts WHERE title = ?").get("noteA") as {
      boost: number;
      updated: string;
    };
    // Per-query cap limits any single boost to 0.05
    expect(row.boost).toBeCloseTo(0.05, 4);
    expect(row.updated).toBeTruthy();
  });

  it("accumulates with decay-before-add", () => {
    // Insert an old boost: 0.5, 20 days ago
    const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("INSERT INTO boosts (title, boost, updated) VALUES (?, ?, ?)")
      .run("noteA", 0.5, oldDate);

    // Apply new boost of 0.1 (capped to 0.05)
    const boosts = new Map([["noteA", 0.1]]);
    applyActivationBoosts(db, boosts);

    const row = db.prepare("SELECT boost FROM boosts WHERE title = ?").get("noteA") as {
      boost: number;
    };

    // Default rows have access_count=1/session_count=1, so decay uses
    // Ebbinghaus strengthening rather than the base 0.1 rate.
    const decayRate = DEFAULT_ACTIVATION_CONFIG.enabled
      ? 0.1 / (1 + 0.2 * Math.log1p(1) + 0.3 * Math.log1p(1))
      : 0.1;
    const decayed = 0.5 * Math.exp(-decayRate * 20);
    const expected = 1 - (1 - decayed) * (1 - 0.05);
    expect(row.boost).toBeCloseTo(expected, 2);
    expect(row.boost).toBeLessThan(0.6);
  });

  it("clamps at 1.0", () => {
    // Insert a recent boost of 0.9
    const recentDate = new Date().toISOString();
    db.prepare("INSERT INTO boosts (title, boost, updated) VALUES (?, ?, ?)")
      .run("noteA", 0.9, recentDate);

    // Apply new boost of 0.5 — should clamp at 1.0
    const boosts = new Map([["noteA", 0.5]]);
    applyActivationBoosts(db, boosts);

    const row = db.prepare("SELECT boost FROM boosts WHERE title = ?").get("noteA") as {
      boost: number;
    };
    expect(row.boost).toBeLessThanOrEqual(1.0);
  });

  it("updates timestamp", () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("INSERT INTO boosts (title, boost, updated) VALUES (?, ?, ?)")
      .run("noteA", 0.3, oldDate);

    applyActivationBoosts(db, new Map([["noteA", 0.1]]));

    const row = db.prepare("SELECT updated FROM boosts WHERE title = ?").get("noteA") as {
      updated: string;
    };
    const updatedTime = new Date(row.updated).getTime();
    // Should be very recent (within last few seconds)
    expect(Date.now() - updatedTime).toBeLessThan(5000);
  });
});

describe("loadBoosts", () => {
  it("fresh boost returns full value", () => {
    const nowISO = new Date().toISOString();
    db.prepare("INSERT INTO boosts (title, boost, updated) VALUES (?, ?, ?)")
      .run("noteA", 0.8, nowISO);

    const boosts = loadBoosts(db);
    expect(boosts.get("noteA")).toBeCloseTo(0.8, 2);
  });

  it("7-day-old boost is approximately half", () => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("INSERT INTO boosts (title, boost, updated) VALUES (?, ?, ?)")
      .run("noteA", 1.0, sevenDaysAgo);

    const boosts = loadBoosts(db);
    const decayRate = 0.1 / (1 + 0.2 * Math.log1p(1) + 0.3 * Math.log1p(1));
    expect(boosts.get("noteA")).toBeCloseTo(Math.exp(-decayRate * 7), 2);
  });

  it("30-day-old boost is effectively zero", () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("INSERT INTO boosts (title, boost, updated) VALUES (?, ?, ?)")
      .run("noteA", 1.0, thirtyDaysAgo);

    const boosts = loadBoosts(db);
    const decayRate = 0.1 / (1 + 0.2 * Math.log1p(1) + 0.3 * Math.log1p(1));
    const val = boosts.get("noteA") ?? 0;
    expect(val).toBeCloseTo(Math.exp(-decayRate * 30), 2);
    expect(val).toBeLessThan(0.12);
  });

  it("missing title returns undefined (not in map)", () => {
    const boosts = loadBoosts(db);
    expect(boosts.has("nonexistent")).toBe(false);
  });
});
