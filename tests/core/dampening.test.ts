import { describe, it, expect } from "vitest";
import {
  extractKeyTerms,
  applyGravityDampening,
  applyHubDampening,
  applyResolutionBoost,
} from "../../src/core/dampening.js";
import type { ScoredNote } from "../../src/core/ranking.js";
import type { LinkGraph } from "../../src/core/graph.js";

/* ------------------------------------------------------------------ */
/*  extractKeyTerms                                                    */
/* ------------------------------------------------------------------ */

describe("extractKeyTerms", () => {
  it("removes stopwords", () => {
    const terms = extractKeyTerms("what is the best way to do this");
    expect(terms.has("what")).toBe(false);
    expect(terms.has("the")).toBe(false);
    expect(terms.has("best")).toBe(true);
    expect(terms.has("way")).toBe(true);
  });

  it("lowercases all terms", () => {
    const terms = extractKeyTerms("TypeScript Compiler Options");
    expect(terms.has("typescript")).toBe(true);
    expect(terms.has("TypeScript")).toBe(false);
  });

  it("strips punctuation", () => {
    const terms = extractKeyTerms("what's the q-value?");
    expect(terms.has("q-value")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  Gravity Dampening                                                  */
/* ------------------------------------------------------------------ */

describe("applyGravityDampening", () => {
  const results: ScoredNote[] = [
    { title: "typescript compiler options for production", score: 0.8, signals: {} },
    { title: "rust memory model explained", score: 0.7, signals: {} },
    { title: "low score note about nothing", score: 0.1, signals: {} },
  ];

  const titleMap = new Map(results.map((r) => [r.title, r.title]));

  it("halves score for high-scoring notes with zero term overlap", () => {
    const dampened = applyGravityDampening(results, "typescript compiler", titleMap);
    const ts = dampened.find((r) => r.title.includes("typescript"))!;
    const rust = dampened.find((r) => r.title.includes("rust"))!;

    // "typescript compiler" overlaps with first note — no dampening
    expect(ts.score).toBe(0.8);
    // "rust memory model" has no overlap with "typescript compiler" — halved
    expect(rust.score).toBeCloseTo(0.35, 10);
  });

  it("does not dampen notes below threshold", () => {
    const dampened = applyGravityDampening(results, "unrelated query", titleMap, 0.3);
    const low = dampened.find((r) => r.title.includes("low score"))!;
    // score 0.1 < threshold 0.3 → no dampening
    expect(low.score).toBe(0.1);
  });

  it("does not dampen when query terms appear in title", () => {
    const dampened = applyGravityDampening(results, "rust memory", titleMap);
    const rust = dampened.find((r) => r.title.includes("rust"))!;
    expect(rust.score).toBe(0.7);
  });
});

/* ------------------------------------------------------------------ */
/*  Hub Dampening                                                      */
/* ------------------------------------------------------------------ */

describe("applyHubDampening", () => {
  // Build a link graph where "index-note" is a hub (many connections)
  const graph: LinkGraph = {
    outgoing: new Map([
      ["index-note", new Set(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"])],
      ["a", new Set(["b"])],
      ["b", new Set(["c"])],
      ["c", new Set(["d"])],
      ["d", new Set(["e"])],
      ["e", new Set(["f"])],
      ["f", new Set(["g"])],
      ["g", new Set(["h"])],
      ["h", new Set(["i"])],
      ["i", new Set(["j"])],
    ]),
    incoming: new Map([
      ["a", new Set(["index-note"])],
      ["b", new Set(["index-note", "a"])],
      ["c", new Set(["index-note", "b"])],
      ["d", new Set(["index-note", "c"])],
      ["e", new Set(["index-note", "d"])],
      ["f", new Set(["index-note", "e"])],
      ["g", new Set(["index-note", "f"])],
      ["h", new Set(["index-note", "g"])],
      ["i", new Set(["index-note", "h"])],
      ["j", new Set(["index-note", "i"])],
    ]),
  };

  const results: ScoredNote[] = [
    { title: "index-note", score: 0.9, signals: {} },
    { title: "a", score: 0.8, signals: {} },
    { title: "b", score: 0.7, signals: {} },
  ];

  it("dampens hub notes (top 10% by degree)", () => {
    const dampened = applyHubDampening(results, graph);
    const hub = dampened.find((r) => r.title === "index-note")!;
    // index-note has degree 10 (outgoing), way above P90
    expect(hub.score).toBeLessThan(0.9);
  });

  it("does not dampen non-hub notes", () => {
    const dampened = applyHubDampening(results, graph);
    const noteA = dampened.find((r) => r.title === "a")!;
    // "a" has degree 2 (1 outgoing + 1 incoming), well below P90
    expect(noteA.score).toBe(0.8);
  });

  it("exempts entity-matched notes", () => {
    const dampened = applyHubDampening(results, graph, ["index-note"]);
    const hub = dampened.find((r) => r.title === "index-note")!;
    expect(hub.score).toBe(0.9); // exempt
  });

  it("has a floor of 0.2x original score", () => {
    const dampened = applyHubDampening(results, graph);
    const hub = dampened.find((r) => r.title === "index-note")!;
    expect(hub.score).toBeGreaterThanOrEqual(0.9 * 0.2);
  });
});

/* ------------------------------------------------------------------ */
/*  Resolution Boost                                                   */
/* ------------------------------------------------------------------ */

describe("applyResolutionBoost", () => {
  const results: ScoredNote[] = [
    { title: "how to fix the build", score: 0.6, signals: {} },
    { title: "random thought about life", score: 0.5, signals: {} },
    { title: "api design decision", score: 0.7, signals: {} },
  ];

  it("boosts decision and learning type notes by 1.25x", () => {
    const types = new Map([
      ["how to fix the build", "learning"],
      ["random thought about life", "idea"],
      ["api design decision", "decision"],
    ]);

    const boosted = applyResolutionBoost(results, types);
    expect(boosted.find((r) => r.title === "how to fix the build")!.score).toBeCloseTo(0.75, 10);
    expect(boosted.find((r) => r.title === "api design decision")!.score).toBeCloseTo(0.875, 10);
  });

  it("does not boost non-resolution types", () => {
    const types = new Map([
      ["random thought about life", "idea"],
    ]);

    const boosted = applyResolutionBoost(results, types);
    expect(boosted.find((r) => r.title === "random thought about life")!.score).toBe(0.5);
  });

  it("handles notes with no type", () => {
    const boosted = applyResolutionBoost(results, new Map());
    // No types → no boosts → scores unchanged
    for (const r of boosted) {
      const orig = results.find((o) => o.title === r.title)!;
      expect(r.score).toBe(orig.score);
    }
  });
});
