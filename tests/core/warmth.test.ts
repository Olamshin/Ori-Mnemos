import { describe, expect, it, vi } from "vitest";
import type { StoredVectors } from "../../src/core/engine.js";
import type { LinkGraph } from "../../src/core/graph.js";
import { applyConfigDefaults } from "../../src/core/config.js";
import {
  WarmthService,
  computePPR,
  detectSurprise,
  mergeWarmthScores,
  selectSeeds,
} from "../../src/core/warmth.js";

function vector(values: number[]): Float32Array {
  return new Float32Array(values);
}

function stored(body: number[], desc: number[] = body): StoredVectors {
  return {
    titleVec: vector(body),
    descVec: vector(desc),
    bodyVec: vector(body),
    typeVec: vector([0, 0, 0, 0, 0, 0]),
    communityVec: vector([0, 0]),
    contentHash: "hash",
    indexedAt: "2026-03-09T00:00:00.000Z",
  };
}

function graph(edges: Record<string, string[]>): LinkGraph {
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();

  for (const [source, targets] of Object.entries(edges)) {
    outgoing.set(source, new Set(targets));
    for (const target of targets) {
      if (!incoming.has(target)) incoming.set(target, new Set());
      incoming.get(target)!.add(source);
    }
  }

  return { outgoing, incoming };
}

describe("detectSurprise", () => {
  it("treats a missing cache as surprising", () => {
    expect(detectSurprise(vector([1, 0]), null, 0.15)).toBe(true);
  });

  it("does not recompute for identical vectors", () => {
    expect(detectSurprise(vector([1, 0]), vector([1, 0]), 0.15)).toBe(false);
  });

  it("recomputes for distant vectors", () => {
    expect(detectSurprise(vector([1, 0]), vector([0, 1]), 0.15)).toBe(true);
  });
});

describe("selectSeeds", () => {
  it("filters below threshold and respects natural gaps", () => {
    const seeds = selectSeeds(
      [
        { title: "a", sim: 0.82 },
        { title: "b", sim: 0.74 },
        { title: "c", sim: 0.52 },
        { title: "d", sim: 0.30 },
      ],
      0.35,
      30,
      0.15,
    );

    expect(Array.from(seeds.keys())).toEqual(["a", "b"]);
  });
});

describe("computePPR", () => {
  it("returns empty scores when no seeds are provided", () => {
    expect(computePPR(new Map(), graph({ a: ["b"] }), 0.15, 20)).toEqual(new Map());
  });

  it("propagates activation along the graph without leaking to disconnected nodes", () => {
    const scores = computePPR(
      new Map([["a", 1]]),
      graph({ a: ["b"], b: ["c"], isolated: [] }),
      0.15,
      20,
    );

    expect(scores.get("a")).toBeGreaterThan(0);
    expect(scores.get("b")).toBeGreaterThan(0);
    expect(scores.get("c")).toBeGreaterThan(0);
    expect(scores.get("isolated") ?? 0).toBe(0);
  });
});

describe("mergeWarmthScores", () => {
  const warmthConfig = applyConfigDefaults({}).warmth;

  it("tags embedding, graph, and both sources correctly", () => {
    const merged = mergeWarmthScores(
      [
        { title: "seed", sim: 0.80 },
        { title: "semantic", sim: 0.50 },
      ],
      new Map([
        ["seed", 1.0],
        ["graph-only", 0.9],
      ]),
      new Map([["seed", 0.80], ["semantic", 0.50]]),
      warmthConfig,
      10,
    );

    expect(merged.find((note) => note.title === "seed")?.source).toBe("both");
    expect(merged.find((note) => note.title === "semantic")?.source).toBe("embedding");
    expect(merged.find((note) => note.title === "graph-only")?.source).toBe("graph");
  });
});

describe("WarmthService", () => {
  const config = applyConfigDefaults({});

  it("returns empty signals when the vault is empty", async () => {
    const service = new WarmthService(async () => vector([1, 0, 0]));
    const results = await service.scan(
      "context",
      new Map(),
      graph({}),
      config.engine,
      config.warmth,
    );

    expect(results).toEqual([]);
  });

  it("uses the cached result when the context does not meaningfully shift", async () => {
    const embedder = vi.fn().mockResolvedValue(vector([1, 0, 0]));
    const service = new WarmthService(async () => embedder());
    const storedVectors = new Map<string, StoredVectors>([
      ["seed", stored([1, 0, 0])],
      ["linked", stored([0.2, 0.9, 0])],
    ]);

    const first = await service.scan(
      "context one",
      storedVectors,
      graph({ seed: ["linked"] }),
      config.engine,
      config.warmth,
    );
    const second = await service.scan(
      "context two",
      storedVectors,
      graph({ seed: ["linked"] }),
      config.engine,
      config.warmth,
    );

    expect(first).toEqual(second);
    expect(embedder).toHaveBeenCalledTimes(2);
  });

  it("surfaces linked graph neighbors when the seed is warm", async () => {
    const service = new WarmthService(async () => vector([1, 0, 0]));
    const storedVectors = new Map<string, StoredVectors>([
      ["seed", stored([1, 0, 0])],
      ["graph-neighbor", stored([0.1, 0.1, 0.98])],
      ["cold", stored([0, 1, 0])],
    ]);

    const results = await service.scan(
      "token incentives",
      storedVectors,
      graph({ seed: ["graph-neighbor"] }),
      config.engine,
      config.warmth,
      { limit: 10 },
    );

    expect(results[0]?.title).toBe("seed");
    expect(results.some((note) => note.title === "graph-neighbor")).toBe(true);
    expect(results.find((note) => note.title === "graph-neighbor")?.source).toBe("graph");
  });
});
