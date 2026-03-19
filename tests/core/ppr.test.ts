import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  personalizedPageRankCombined,
  PPR_ALPHA,
} from "../../src/core/ppr.js";
import { initCoOccurrenceTables } from "../../src/core/cooccurrence.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  initCoOccurrenceTables(db);
});

describe("personalizedPageRankCombined", () => {
  it("returns empty for no seeds", () => {
    const result = personalizedPageRankCombined(
      db,
      new Map(),
      new Map(),
    );
    expect(result).toEqual([]);
  });

  it("assigns highest score to seed node in simple chain", () => {
    const wikiLinks = new Map([
      ["A", ["B"]],
      ["B", ["C"]],
    ]);
    const seeds = new Map([["A", 1.0]]);

    const result = personalizedPageRankCombined(db, seeds, wikiLinks);
    const scores = new Map(result.map((r) => [r.noteId, r.score]));

    // A should have highest score (seed + teleport)
    expect(scores.get("A")).toBeGreaterThan(scores.get("B")!);
    expect(scores.get("B")).toBeGreaterThan(scores.get("C")!);
  });

  it("includes seed nodes in results (not filtered out)", () => {
    const wikiLinks = new Map([
      ["A", ["B"]],
    ]);
    const seeds = new Map([["A", 1.0]]);

    const result = personalizedPageRankCombined(db, seeds, wikiLinks);
    const noteIds = result.map((r) => r.noteId);
    expect(noteIds).toContain("A");
  });

  it("surfaces notes connected via co-occurrence edges", () => {
    // Insert a co-occurrence edge between B and D (no wiki-link between them)
    db.prepare(
      "INSERT INTO co_occurrence (note_a, note_b, npmi_weight) VALUES (?, ?, ?)",
    ).run("B", "D", 0.8);

    const wikiLinks = new Map([
      ["A", ["B"]],
      ["B", ["C"]],
    ]);
    const seeds = new Map([["A", 1.0]]);

    const result = personalizedPageRankCombined(db, seeds, wikiLinks);
    const noteIds = result.map((r) => r.noteId);

    // D should appear via co-occurrence with B
    expect(noteIds).toContain("D");
  });

  it("returns sorted by score descending", () => {
    const wikiLinks = new Map([
      ["A", ["B", "C", "D"]],
    ]);
    const seeds = new Map([["A", 1.0]]);

    const result = personalizedPageRankCombined(db, seeds, wikiLinks);
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].score).toBeGreaterThanOrEqual(result[i].score);
    }
  });

  it("respects maxResults limit", () => {
    const wikiLinks = new Map([
      ["A", ["B", "C", "D", "E", "F", "G"]],
    ]);
    const seeds = new Map([["A", 1.0]]);

    const result = personalizedPageRankCombined(
      db,
      seeds,
      wikiLinks,
      3,
    );
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it("distributes score proportionally with multiple seeds", () => {
    const wikiLinks = new Map([
      ["A", ["C"]],
      ["B", ["C"]],
    ]);
    const seeds = new Map([
      ["A", 0.8],
      ["B", 0.2],
    ]);

    const result = personalizedPageRankCombined(db, seeds, wikiLinks);
    const scores = new Map(result.map((r) => [r.noteId, r.score]));

    // A has higher seed weight → should have higher score
    expect(scores.get("A")!).toBeGreaterThan(scores.get("B")!);
  });
});
