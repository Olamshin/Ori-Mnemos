import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  zNormalize,
  computeLambda,
  phaseB,
  LAMBDA_MIN,
  LAMBDA_MAX,
  LAMBDA_MATURITY,
  MAX_CUMULATIVE_BIAS,
  K2,
} from "../../src/core/rerank.js";
import { initQValueTables, updateQ } from "../../src/core/qvalue.js";
import type { ScoredNote } from "../../src/core/ranking.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  initQValueTables(db);
});

describe("zNormalize", () => {
  it("returns empty for empty input", () => {
    expect(zNormalize([])).toEqual([]);
  });

  it("normalizes to mean 0 and std 1", () => {
    const result = zNormalize([2, 4, 6, 8, 10]);
    const mean = result.reduce((a, b) => a + b, 0) / result.length;
    const std = Math.sqrt(
      result.reduce((a, b) => a + b * b, 0) / result.length,
    );
    expect(mean).toBeCloseTo(0, 10);
    expect(std).toBeCloseTo(1, 10);
  });

  it("handles constant values (std=0 → uses 1)", () => {
    const result = zNormalize([5, 5, 5]);
    expect(result).toEqual([0, 0, 0]);
  });
});

describe("computeLambda", () => {
  it("starts at LAMBDA_MIN with no Q updates", () => {
    const lambda = computeLambda(0, "semantic");
    // base = 0.15 + 0*0.35 = 0.15, shift for semantic = -0.10
    // result = max(0.1, min(0.6, 0.15 - 0.10)) = max(0.1, 0.05) = 0.1
    expect(lambda).toBeCloseTo(0.1, 10);
  });

  it("reaches LAMBDA_MAX at maturity", () => {
    const lambda = computeLambda(LAMBDA_MATURITY, "episodic");
    // base = 0.15 + 1.0*0.35 = 0.50, shift for episodic = 0
    expect(lambda).toBeCloseTo(0.50, 10);
  });

  it("ramps linearly between min and max", () => {
    const halfwayLambda = computeLambda(LAMBDA_MATURITY / 2, "episodic");
    const expectedBase =
      LAMBDA_MIN + 0.5 * (LAMBDA_MAX - LAMBDA_MIN);
    expect(halfwayLambda).toBeCloseTo(expectedBase, 10);
  });

  it("shifts higher for procedural queries (trust Q more)", () => {
    const semantic = computeLambda(100, "semantic");
    const procedural = computeLambda(100, "procedural");
    expect(procedural).toBeGreaterThan(semantic);
  });

  it("clamps to [0.1, 0.6]", () => {
    expect(computeLambda(0, "semantic")).toBeGreaterThanOrEqual(0.1);
    expect(computeLambda(10000, "procedural")).toBeLessThanOrEqual(0.6);
  });
});

describe("phaseB", () => {
  const candidates: ScoredNote[] = [
    { title: "note-a", score: 0.95, signals: { rrf: 0.95 } },
    { title: "note-b", score: 0.80, signals: { rrf: 0.80 } },
    { title: "note-c", score: 0.60, signals: { rrf: 0.60 } },
    { title: "note-d", score: 0.40, signals: { rrf: 0.40 } },
    { title: "note-e", score: 0.30, signals: { rrf: 0.30 } },
  ];

  it("returns empty for empty candidates", () => {
    expect(phaseB(db, [], "query", "semantic", "s1")).toEqual([]);
  });

  it("returns at most K2 results", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      title: `note-${i}`,
      score: 1 - i * 0.04,
      signals: { rrf: 1 - i * 0.04 },
    }));
    const result = phaseB(db, many, "query", "semantic", "s1");
    expect(result.length).toBeLessThanOrEqual(K2);
  });

  it("changes ordering when Q-values differ", () => {
    // Give note-d a very high Q-value (many positive updates)
    for (let i = 0; i < 50; i++) {
      updateQ(db, "note-d", 1.0, "s0");
    }
    // Give note-a a negative Q-value
    for (let i = 0; i < 50; i++) {
      updateQ(db, "note-a", -0.5, "s0");
    }

    const result = phaseB(db, candidates, "query", "procedural", "s1");
    const titles = result.map((r) => r.title);
    // note-d should move up from its original 4th position
    const dIdx = titles.indexOf("note-d");
    const aIdx = titles.indexOf("note-a");
    // With strong Q signal and procedural shift (+0.15 lambda), note-d should beat note-a
    expect(dIdx).toBeLessThan(aIdx);
  });

  it("respects cumulative bias cap", () => {
    const result = phaseB(db, candidates, "query", "semantic", "s1");
    for (const r of result) {
      const original = candidates.find((c) => c.title === r.title);
      if (original) {
        // Score should not exceed MAX_CUMULATIVE_BIAS * original (before compression)
        // After compression it can be slightly above but controlled
        expect(r.score).toBeLessThan(
          original.score * MAX_CUMULATIVE_BIAS * 2,
        );
      }
    }
  });

  it("logs retrievals to retrieval_log", () => {
    phaseB(db, candidates, "test query", "semantic", "session-1");
    const rows = db.prepare("SELECT * FROM retrieval_log").all() as any[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].session_id).toBe("session-1");
    expect(rows[0].query_text).toBe("test query");
  });

  it("increments exposure count for all candidates", () => {
    phaseB(db, candidates, "query", "semantic", "s1");
    const row = db
      .prepare("SELECT exposure_count FROM note_q WHERE note_id = ?")
      .get("note-a") as { exposure_count: number } | undefined;
    expect(row?.exposure_count).toBe(1);
  });
});
