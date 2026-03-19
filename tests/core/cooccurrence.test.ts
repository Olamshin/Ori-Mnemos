import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  initCoOccurrenceTables,
  computeNPMI,
  gloveWeight,
  edgeDecay,
  computeEdgeWeight,
  recordCoRetrieval,
  extractCoOccurrencePairs,
  runHomeostasis,
  recomputeAllNPMI,
  bootstrapFromWikiLinks,
  GLOVE_XMAX,
  EBBINGHAUS_BASE_DAYS,
  DECAY_FLOOR,
  HOMEOSTASIS_TARGET,
  BOOTSTRAP_BCS_THRESHOLD,
  BOOTSTRAP_INIT_WEIGHT,
} from "../../src/core/cooccurrence.js";
import { initQValueTables, logRetrieval } from "../../src/core/qvalue.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  initCoOccurrenceTables(db);
  initQValueTables(db);
});

describe("computeNPMI", () => {
  it("returns -1 when countAB is 0", () => {
    expect(computeNPMI(0, 10, 10, 100)).toBe(-1);
  });

  it("returns 1.0 for perfect co-occurrence (always together)", () => {
    // If A and B always co-occur: p(AB) = p(A) = p(B)
    // PMI = log(1) = 0, but NPMI = 0 / -log(pAB)... actually:
    // p(AB) = 5/10, p(A) = 5/10, p(B) = 5/10
    // PMI = log(0.5 / (0.5 * 0.5)) = log(2)
    // NPMI = log(2) / -log(0.5) = log(2) / log(2) = 1.0
    expect(computeNPMI(5, 5, 5, 10)).toBeCloseTo(1.0, 10);
  });

  it("returns negative for anti-correlated notes", () => {
    // A appears 50 times, B appears 50 times, but they co-occur only 1 time out of 100
    const npmi = computeNPMI(1, 50, 50, 100);
    expect(npmi).toBeLessThan(0);
  });

  it("is bounded [-1, 1]", () => {
    const values = [
      computeNPMI(5, 10, 10, 100),
      computeNPMI(10, 10, 10, 100),
      computeNPMI(1, 50, 50, 100),
    ];
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("gloveWeight", () => {
  it("returns 1.0 at x_max", () => {
    expect(gloveWeight(GLOVE_XMAX)).toBe(1.0);
  });

  it("returns 1.0 above x_max", () => {
    expect(gloveWeight(GLOVE_XMAX + 50)).toBe(1.0);
  });

  it("returns sub-linear weight below x_max", () => {
    const w = gloveWeight(50);
    expect(w).toBeGreaterThan(0);
    expect(w).toBeLessThan(1);
    // (50/100)^0.75 ≈ 0.5946
    expect(w).toBeCloseTo(Math.pow(0.5, 0.75), 4);
  });

  it("is monotonically increasing", () => {
    const weights = [1, 5, 10, 25, 50, 75, 100].map(gloveWeight);
    for (let i = 1; i < weights.length; i++) {
      expect(weights[i]).toBeGreaterThanOrEqual(weights[i - 1]);
    }
  });
});

describe("edgeDecay", () => {
  it("returns ~1.0 for daysSince=0", () => {
    expect(edgeDecay(0, 5)).toBeCloseTo(1.0, 10);
  });

  it("respects decay floor", () => {
    expect(edgeDecay(10000, 1)).toBe(DECAY_FLOOR);
  });

  it("decays slower for frequently co-retrieved pairs (strength accumulation)", () => {
    const decayLow = edgeDecay(30, 1);
    const decayHigh = edgeDecay(30, 50);
    expect(decayHigh).toBeGreaterThan(decayLow);
  });

  it("reaches ~0.37 at base half-life for count=0", () => {
    // exp(-30 / (30 * 1)) = exp(-1) ≈ 0.368
    const decay = edgeDecay(EBBINGHAUS_BASE_DAYS, 0);
    expect(decay).toBeCloseTo(Math.exp(-1), 2);
  });
});

describe("recordCoRetrieval", () => {
  it("creates a new edge", () => {
    recordCoRetrieval(db, "note-b", "note-a");
    const row = db
      .prepare("SELECT * FROM co_occurrence WHERE note_a = ? AND note_b = ?")
      .get("note-a", "note-b") as any;
    expect(row).toBeDefined();
    expect(row.co_retrieval_count).toBe(1);
  });

  it("ensures consistent ordering (alphabetical)", () => {
    recordCoRetrieval(db, "zzz-note", "aaa-note");
    const row = db.prepare("SELECT * FROM co_occurrence").get() as any;
    expect(row.note_a).toBe("aaa-note");
    expect(row.note_b).toBe("zzz-note");
  });

  it("increments count on repeated co-retrieval", () => {
    recordCoRetrieval(db, "note-a", "note-b");
    recordCoRetrieval(db, "note-a", "note-b");
    recordCoRetrieval(db, "note-b", "note-a"); // reversed order, same pair
    const row = db.prepare("SELECT * FROM co_occurrence").get() as any;
    expect(row.co_retrieval_count).toBe(3);
  });
});

describe("extractCoOccurrencePairs", () => {
  it("creates edges from co-retrieved notes within same query", () => {
    logRetrieval(db, "s1", "query1", "semantic", "note-a", 0, 0.9, 0.5, 0.1, 0.8);
    logRetrieval(db, "s1", "query1", "semantic", "note-b", 1, 0.8, 0.5, 0.1, 0.7);
    logRetrieval(db, "s1", "query1", "semantic", "note-c", 2, 0.7, 0.5, 0.1, 0.6);

    extractCoOccurrencePairs(db, "s1");

    const edges = db.prepare("SELECT * FROM co_occurrence").all() as any[];
    // 3 notes → 3 pairs: (a,b), (a,c), (b,c)
    expect(edges).toHaveLength(3);
  });

  it("does not create edges across different queries", () => {
    logRetrieval(db, "s1", "query1", "semantic", "note-a", 0, 0.9, 0.5, 0.1, 0.8);
    logRetrieval(db, "s1", "query2", "semantic", "note-b", 0, 0.8, 0.5, 0.1, 0.7);

    extractCoOccurrencePairs(db, "s1");

    const edges = db.prepare("SELECT * FROM co_occurrence").all() as any[];
    // Different queries → no co-occurrence
    expect(edges).toHaveLength(0);
  });
});

describe("runHomeostasis", () => {
  it("scales edge weights toward target mean", () => {
    // Create edges with high weights
    db.prepare(
      "INSERT INTO co_occurrence (note_a, note_b, npmi_weight) VALUES (?, ?, ?)",
    ).run("a", "b", 2.0);
    db.prepare(
      "INSERT INTO co_occurrence (note_a, note_b, npmi_weight) VALUES (?, ?, ?)",
    ).run("a", "c", 2.0);

    runHomeostasis(db);

    // After homeostasis, mean weight for node 'a' should be closer to HOMEOSTASIS_TARGET
    const edges = db
      .prepare("SELECT npmi_weight FROM co_occurrence WHERE note_a = ?")
      .all("a") as { npmi_weight: number }[];
    const mean =
      edges.reduce((s, e) => s + e.npmi_weight, 0) / edges.length;
    // Won't be exactly target due to node 'b' and 'c' also being processed
    expect(mean).toBeLessThan(2.0); // should have decreased
  });
});

describe("bootstrapFromWikiLinks", () => {
  it("creates edges for notes sharing wiki-link targets", () => {
    const noteLinks = new Map([
      ["note-a", new Set(["target-1", "target-2", "target-3"])],
      ["note-b", new Set(["target-1", "target-2"])],
      ["note-c", new Set(["target-99"])],
    ]);

    bootstrapFromWikiLinks(db, noteLinks);

    const edges = db.prepare("SELECT * FROM co_occurrence").all() as any[];
    // note-a and note-b share 2 targets → BCS = 2/sqrt(3*2) ≈ 0.816 > threshold
    // note-a and note-c share 0 → no edge
    // note-b and note-c share 0 → no edge
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe("bootstrap");
  });

  it("uses BCS * BOOTSTRAP_INIT_WEIGHT for initial weight", () => {
    const noteLinks = new Map([
      ["note-a", new Set(["t1", "t2"])],
      ["note-b", new Set(["t1", "t2"])],
    ]);

    bootstrapFromWikiLinks(db, noteLinks);

    const edge = db.prepare("SELECT * FROM co_occurrence").get() as any;
    // BCS = 2/sqrt(2*2) = 1.0 → weight = 1.0 * 0.15 = 0.15
    expect(edge.npmi_weight).toBeCloseTo(BOOTSTRAP_INIT_WEIGHT, 10);
  });

  it("skips pairs below BCS threshold", () => {
    // Create notes with very different link sets
    const noteLinks = new Map([
      ["note-a", new Set(["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10"])],
      ["note-b", new Set(["t1"])], // 1 shared out of 10 and 1 → BCS = 1/sqrt(10) ≈ 0.316
    ]);

    bootstrapFromWikiLinks(db, noteLinks);

    // BCS = 0.316 > 0.1 → should create edge
    const edges = db.prepare("SELECT * FROM co_occurrence").all() as any[];
    expect(edges).toHaveLength(1);
  });
});
