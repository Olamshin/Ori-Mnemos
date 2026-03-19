import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  initQValueTables,
  getQ,
  getDecayedQ,
  getRewardStats,
  getExposureCount,
  getTotalQUpdates,
  getTotalQueryCount,
  updateQ,
  incrementExposure,
  logRetrieval,
  explorationBonus,
  batchUpdateQ,
  ALPHA,
  DEFAULT_Q,
} from "../../src/core/qvalue.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  initQValueTables(db);
});

describe("initQValueTables", () => {
  it("creates all three tables", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("note_q");
    expect(names).toContain("q_history");
    expect(names).toContain("retrieval_log");
  });

  it("is idempotent", () => {
    expect(() => initQValueTables(db)).not.toThrow();
  });
});

describe("getQ / updateQ", () => {
  it("returns DEFAULT_Q for unknown notes", () => {
    expect(getQ(db, "unknown-note")).toBe(DEFAULT_Q);
  });

  it("updates Q with EMA formula", () => {
    updateQ(db, "note-a", 1.0, "session-1");
    const q = getQ(db, "note-a");
    // Q = 0.5 + 0.1 * (1.0 - 0.5) = 0.55
    expect(q).toBeCloseTo(0.55, 10);
  });

  it("accumulates updates correctly", () => {
    updateQ(db, "note-a", 1.0, "s1");
    updateQ(db, "note-a", 1.0, "s1");
    const q = getQ(db, "note-a");
    // Round 1: 0.5 + 0.1*(1.0-0.5) = 0.55
    // Round 2: 0.55 + 0.1*(1.0-0.55) = 0.595
    expect(q).toBeCloseTo(0.595, 10);
  });

  it("decreases Q for negative rewards", () => {
    updateQ(db, "note-a", -0.15, "s1");
    const q = getQ(db, "note-a");
    // Q = 0.5 + 0.1*(-0.15-0.5) = 0.5 - 0.065 = 0.435
    expect(q).toBeCloseTo(0.435, 10);
  });

  it("writes to q_history", () => {
    updateQ(db, "note-a", 1.0, "session-1");
    const history = db
      .prepare("SELECT * FROM q_history WHERE note_id = ?")
      .all("note-a") as any[];
    expect(history).toHaveLength(1);
    expect(history[0].old_q).toBeCloseTo(0.5, 10);
    expect(history[0].new_q).toBeCloseTo(0.55, 10);
    expect(history[0].session_id).toBe("session-1");
  });
});

describe("getDecayedQ", () => {
  it("returns DEFAULT_Q for unknown notes", () => {
    expect(getDecayedQ(db, "unknown")).toBe(DEFAULT_Q);
  });

  it("returns current Q for recently updated notes", () => {
    updateQ(db, "note-a", 1.0, "s1");
    // Just updated — daysSince ≈ 0, decay ≈ 1.0
    const decayed = getDecayedQ(db, "note-a");
    expect(decayed).toBeCloseTo(0.55, 1);
  });
});

describe("getRewardStats", () => {
  it("returns defaults for unknown notes", () => {
    const stats = getRewardStats(db, "unknown");
    expect(stats.mean).toBe(0);
    expect(stats.variance).toBe(0.25);
    expect(stats.count).toBe(0);
  });

  it("computes mean and variance after updates", () => {
    updateQ(db, "note-a", 1.0, "s1");
    updateQ(db, "note-a", 0.5, "s1");
    const stats = getRewardStats(db, "note-a");
    expect(stats.count).toBe(2);
    expect(stats.mean).toBeCloseTo(0.75, 10);
    // variance = (1^2+0.5^2)/2 - 0.75^2 = 0.625 - 0.5625 = 0.0625
    expect(stats.variance).toBeCloseTo(0.0625, 10);
  });
});

describe("exposure", () => {
  it("starts at 0", () => {
    expect(getExposureCount(db, "note-a")).toBe(0);
  });

  it("increments correctly", () => {
    incrementExposure(db, "note-a");
    expect(getExposureCount(db, "note-a")).toBe(1);
    incrementExposure(db, "note-a");
    expect(getExposureCount(db, "note-a")).toBe(2);
  });
});

describe("getTotalQUpdates", () => {
  it("sums update counts across all notes", () => {
    expect(getTotalQUpdates(db)).toBe(0);
    updateQ(db, "note-a", 1.0, "s1");
    updateQ(db, "note-b", 0.5, "s1");
    expect(getTotalQUpdates(db)).toBe(2);
  });
});

describe("getTotalQueryCount", () => {
  it("counts distinct session+query pairs", () => {
    expect(getTotalQueryCount(db)).toBe(0);
    logRetrieval(db, "s1", "query1", "semantic", "note-a", 0, 0.9, 0.5, 0.1, 0.8);
    logRetrieval(db, "s1", "query1", "semantic", "note-b", 1, 0.8, 0.5, 0.1, 0.7);
    logRetrieval(db, "s1", "query2", "semantic", "note-a", 0, 0.9, 0.5, 0.1, 0.8);
    expect(getTotalQueryCount(db)).toBe(2); // 2 distinct queries
  });
});

describe("explorationBonus", () => {
  it("returns c * 2.5 for new notes (count=0)", () => {
    const bonus = explorationBonus({ mean: 0, variance: 0.25, count: 0 }, 100);
    expect(bonus).toBeCloseTo(0.2 * 2.5, 10);
  });

  it("is higher for rarely-retrieved notes", () => {
    const rare = explorationBonus(
      { mean: 0.5, variance: 0.1, count: 2 },
      100,
    );
    const frequent = explorationBonus(
      { mean: 0.5, variance: 0.1, count: 50 },
      100,
    );
    expect(rare).toBeGreaterThan(frequent);
  });

  it("decreases as note is retrieved more", () => {
    const bonuses = [5, 10, 50, 100].map((count) =>
      explorationBonus({ mean: 0.5, variance: 0.1, count }, 200),
    );
    for (let i = 1; i < bonuses.length; i++) {
      expect(bonuses[i]).toBeLessThanOrEqual(bonuses[i - 1]);
    }
  });
});

describe("batchUpdateQ", () => {
  it("updates multiple notes in a transaction", () => {
    const rewards = new Map([
      ["note-a", 1.0],
      ["note-b", -0.15],
      ["note-c", 0.5],
    ]);
    batchUpdateQ(db, rewards, "session-1");

    expect(getQ(db, "note-a")).toBeCloseTo(0.55, 10);
    expect(getQ(db, "note-b")).toBeCloseTo(0.435, 10);
    expect(getQ(db, "note-c")).toBeCloseTo(0.5 + 0.1 * (0.5 - 0.5), 10); // stays 0.5
  });
});

describe("logRetrieval", () => {
  it("writes to retrieval_log", () => {
    logRetrieval(db, "s1", "test query", "semantic", "note-a", 0, 0.9, 0.5, 0.1, 0.8);
    const rows = db.prepare("SELECT * FROM retrieval_log").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe("s1");
    expect(rows[0].query_text).toBe("test query");
    expect(rows[0].note_id).toBe("note-a");
    expect(rows[0].rank).toBe(0);
  });
});
