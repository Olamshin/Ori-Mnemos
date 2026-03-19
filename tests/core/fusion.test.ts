import { describe, it, expect } from "vitest";
import {
  fuseScoreWeightedRRF,
  fuseSimpleRRF,
  normalizeSignalWeights,
  type SignalResults,
} from "../../src/core/fusion.js";
import type { ScoredNote } from "../../src/core/ranking.js";
import type { RetrievalConfig } from "../../src/core/config.js";

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const compositeResults: ScoredNote[] = [
  { title: "note-a", score: 0.95, signals: { composite: 0.95 } },
  { title: "note-b", score: 0.80, signals: { composite: 0.80 } },
  { title: "note-c", score: 0.60, signals: { composite: 0.60 } },
];

const keywordResults: ScoredNote[] = [
  { title: "note-b", score: 0.90, signals: { keyword: 0.90 } },
  { title: "note-d", score: 0.70, signals: { keyword: 0.70 } },
  { title: "note-a", score: 0.50, signals: { keyword: 0.50 } },
];

const graphResults: ScoredNote[] = [
  { title: "note-c", score: 0.85, signals: { graph: 0.85 } },
  { title: "note-a", score: 0.75, signals: { graph: 0.75 } },
  { title: "note-e", score: 0.65, signals: { graph: 0.65 } },
];

const warmthResults: ScoredNote[] = [
  { title: "note-d", score: 0.95, signals: { warmth: 0.95 } },
  { title: "note-c", score: 0.65, signals: { warmth: 0.65 } },
  { title: "note-a", score: 0.45, signals: { warmth: 0.45 } },
];

const testConfig: RetrievalConfig = {
  default_limit: 10,
  candidate_multiplier: 5,
  rrf_k: 60,
  signal_weights: { composite: 0.36, keyword: 0.18, graph: 0.26, warmth: 0.20 },
  exploration_budget: 0.10,
};

const allSignals: SignalResults = {
  composite: compositeResults,
  keyword: keywordResults,
  graph: graphResults,
  warmth: warmthResults,
};

/* ------------------------------------------------------------------ */
/*  fuseScoreWeightedRRF                                               */
/* ------------------------------------------------------------------ */

describe("fuseScoreWeightedRRF", () => {
  it("returns all unique notes from all signals", () => {
    const result = fuseScoreWeightedRRF(allSignals, testConfig);
    const titles = result.map((n) => n.title).sort();
    expect(titles).toEqual(["note-a", "note-b", "note-c", "note-d", "note-e"]);
  });

  it("ranks note-a highest (appears in all 3 signals)", () => {
    const result = fuseScoreWeightedRRF(allSignals, testConfig);
    expect(result[0].title).toBe("note-a");
  });

  it("ranks single-signal notes lower than multi-signal notes", () => {
    const result = fuseScoreWeightedRRF(allSignals, testConfig);
    const noteA = result.find((n) => n.title === "note-a")!;
    const noteD = result.find((n) => n.title === "note-d")!;
    const noteE = result.find((n) => n.title === "note-e")!;

    // note-d only in keyword, note-e only in graph
    expect(noteA.score).toBeGreaterThan(noteD.score);
    expect(noteA.score).toBeGreaterThan(noteE.score);
  });

  it("preserves all signal scores on each output note", () => {
    const result = fuseScoreWeightedRRF(allSignals, testConfig);
    const noteA = result.find((n) => n.title === "note-a")!;

    expect(noteA.signals.composite).toBe(0.95);
    expect(noteA.signals.keyword).toBe(0.50);
    expect(noteA.signals.graph).toBe(0.75);
    expect(noteA.signals.warmth).toBe(0.45);
    expect(noteA.signals.rrf_base).toBeDefined();
    expect(noteA.signals.rrf).toBe(noteA.score);
  });

  it("sets rrf signal equal to the fused score", () => {
    const result = fuseScoreWeightedRRF(allSignals, testConfig);
    for (const note of result) {
      expect(note.signals.rrf).toBeCloseTo(note.score, 10);
    }
  });

  it("computes correct score for note-a (manual calculation)", () => {
    const k = 60;
    const weights = normalizeSignalWeights(testConfig.signal_weights);
    const comp = (weights.composite * 0.95) / (k + 0 + 1);
    const kw = (weights.keyword * 0.50) / (k + 2 + 1);
    const gr = (weights.graph * 0.75) / (k + 1 + 1);
    const warmth = (weights.warmth * 0.45) / (k + 2 + 1);

    const expected = comp + kw + gr + warmth;

    const result = fuseScoreWeightedRRF(allSignals, testConfig);
    const noteA = result.find((n) => n.title === "note-a")!;
    expect(noteA.score).toBeCloseTo(expected, 10);
  });

  it("tracks the pre-warmth fused score separately", () => {
    const k = 60;
    const weights = normalizeSignalWeights(testConfig.signal_weights);
    const expectedBase =
      (weights.composite * 0.95) / (k + 0 + 1) +
      (weights.keyword * 0.50) / (k + 2 + 1) +
      (weights.graph * 0.75) / (k + 1 + 1);

    const result = fuseScoreWeightedRRF(allSignals, testConfig);
    const noteA = result.find((n) => n.title === "note-a")!;
    expect(noteA.signals.rrf_base).toBeCloseTo(expectedBase, 10);
    expect(noteA.score).toBeGreaterThan(expectedBase);
  });

  it("returns results sorted by score descending", () => {
    const result = fuseScoreWeightedRRF(allSignals, testConfig);
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].score).toBeGreaterThanOrEqual(result[i].score);
    }
  });

  it("returns empty array when all signals are empty", () => {
    const empty: SignalResults = { composite: [], keyword: [], graph: [], warmth: [] };
    const result = fuseScoreWeightedRRF(empty, testConfig);
    expect(result).toEqual([]);
  });

  it("handles a single signal correctly", () => {
    const single: SignalResults = {
      composite: compositeResults,
      keyword: [],
      graph: [],
      warmth: [],
    };
    const result = fuseScoreWeightedRRF(single, testConfig);

    expect(result).toHaveLength(3);
    expect(result[0].title).toBe("note-a");

    // score = normalized weight * rawScore / (k + rank + 1)
    const k = 60;
    const expected =
      (normalizeSignalWeights(testConfig.signal_weights).composite * 0.95) /
      (k + 0 + 1);
    expect(result[0].score).toBeCloseTo(expected, 10);
  });

  it("only sets signal keys for signals the note appeared in", () => {
    const result = fuseScoreWeightedRRF(allSignals, testConfig);
    const noteD = result.find((n) => n.title === "note-d")!;

    expect(noteD.signals.keyword).toBe(0.70);
    expect(noteD.signals.composite).toBeUndefined();
    expect(noteD.signals.graph).toBeUndefined();
    expect(noteD.signals.rrf).toBeDefined();
  });

  it("lets warmth promote a note relative to the base fused ranking", () => {
    const result = fuseScoreWeightedRRF(allSignals, testConfig);
    const finalIndex = result.findIndex((n) => n.title === "note-d");
    const baseOrder = [...result].sort(
      (a, b) => (b.signals.rrf_base ?? 0) - (a.signals.rrf_base ?? 0),
    );
    const baseIndex = baseOrder.findIndex((n) => n.title === "note-d");

    expect(finalIndex).toBeLessThan(baseIndex);
  });
});

/* ------------------------------------------------------------------ */
/*  fuseSimpleRRF                                                      */
/* ------------------------------------------------------------------ */

describe("fuseSimpleRRF", () => {
  const k = 60;

  it("returns all unique notes", () => {
    const result = fuseSimpleRRF(allSignals, k);
    expect(result).toHaveLength(5);
  });

  it("ignores raw scores — only uses rank", () => {
    // note-a: composite rank 0, keyword rank 2, graph rank 1
    // note-b: composite rank 1, keyword rank 0
    // For simple RRF, note-a appears in 3 signals, note-b in 2
    // note-a should rank higher regardless of scores
    const result = fuseSimpleRRF(allSignals, k);
    const noteA = result.find((n) => n.title === "note-a")!;
    const noteD = result.find((n) => n.title === "note-d")!;

    // note-a in 3 signals, note-d in 1 — note-a scores higher
    expect(noteA.score).toBeGreaterThan(noteD.score);
  });

  it("computes correct score for note-a (manual calculation)", () => {
    // composite rank 0, keyword rank 2, graph rank 1, warmth rank 2
    const expected =
      1 / (k + 0 + 1) +
      1 / (k + 2 + 1) +
      1 / (k + 1 + 1) +
      1 / (k + 2 + 1);

    const result = fuseSimpleRRF(allSignals, k);
    const noteA = result.find((n) => n.title === "note-a")!;
    expect(noteA.score).toBeCloseTo(expected, 10);
  });

  it("still preserves raw signal scores in the output", () => {
    const result = fuseSimpleRRF(allSignals, k);
    const noteA = result.find((n) => n.title === "note-a")!;

    expect(noteA.signals.composite).toBe(0.95);
    expect(noteA.signals.keyword).toBe(0.50);
    expect(noteA.signals.graph).toBe(0.75);
  });

  it("returns empty array for empty signals", () => {
    const empty: SignalResults = { composite: [], keyword: [], graph: [], warmth: [] };
    expect(fuseSimpleRRF(empty, k)).toEqual([]);
  });

  it("returns sorted results descending", () => {
    const result = fuseSimpleRRF(allSignals, k);
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].score).toBeGreaterThanOrEqual(result[i].score);
    }
  });

  it("gives equal-signal-count notes the same score regardless of raw scores", () => {
    // note-d (keyword only, rank 1) and note-e (graph only, rank 2)
    // Both appear in exactly 1 signal but at different ranks
    // note-d rank 1: 1/(60+1+1) = 1/62
    // note-e rank 2: 1/(60+2+1) = 1/63
    // So note-d should score slightly higher (lower rank = better)
    const result = fuseSimpleRRF(allSignals, k);
    const noteD = result.find((n) => n.title === "note-d")!;
    const noteE = result.find((n) => n.title === "note-e")!;

    expect(noteD.score).toBeGreaterThan(noteE.score);
  });
});
