import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyActivationBoosts, loadBoosts } from "./activation.js";

function createDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS boosts (
      title TEXT PRIMARY KEY,
      boost REAL NOT NULL,
      updated TEXT NOT NULL,
      access_count INTEGER DEFAULT 1,
      sessions TEXT DEFAULT ''
    )
  `);
  return db;
}

describe("applyActivationBoosts", () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = createDb();
  });

  afterEach(() => {
    db.close();
  });

  it("caps per-query contribution", () => {
    // A single query producing a large boost should be capped
    const boosts = new Map([["note-a", 0.20]]);
    applyActivationBoosts(db, boosts);

    const stored = loadBoosts(db);
    expect(stored.get("note-a")).toBeCloseTo(0.05, 5);
  });

  it("accumulates with diminishing returns (log-scale)", () => {
    // Apply the same boost 20 times rapidly (same timestamp effectively)
    for (let i = 0; i < 20; i++) {
      applyActivationBoosts(db, new Map([["note-a", 0.05]]));
    }

    const stored = loadBoosts(db);
    const value = stored.get("note-a")!;

    // With log-scale, 20 applications of 0.05 should NOT reach 1.0
    // Linear: 20 * 0.05 = 1.0 (saturated)
    // Log-scale: 1 - (1-0.05)^20 ≈ 0.64
    expect(value).toBeLessThan(0.80);
    expect(value).toBeGreaterThan(0.30);
  });

  it("does not saturate under bulk ingestion", () => {
    // Simulate 100 queries hitting the same neighbor
    for (let i = 0; i < 100; i++) {
      applyActivationBoosts(db, new Map([["note-a", 0.10]]));
    }

    const stored = loadBoosts(db);
    const value = stored.get("note-a")!;

    // Should be high but not at ceiling
    expect(value).toBeLessThan(0.995);
  });

  it("preserves human-pace accumulation", () => {
    // A few queries should still produce meaningful boost
    applyActivationBoosts(db, new Map([["note-a", 0.05]]));
    const after1 = loadBoosts(db).get("note-a")!;

    applyActivationBoosts(db, new Map([["note-a", 0.05]]));
    const after2 = loadBoosts(db).get("note-a")!;

    // Second application should add something meaningful
    expect(after2).toBeGreaterThan(after1);
    expect(after2 - after1).toBeGreaterThan(0.01);
  });
});
