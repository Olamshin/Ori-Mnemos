/**
 * Personalized PageRank on the combined wiki-link + co-occurrence graph.
 * Layer 2 retrieval — surfaces notes connected by usage patterns that
 * semantic search alone would miss.
 *
 * Research: HippoRAG (PPR α=0.5 validated), SSAKG co-occurrence model
 */

import type Database from "better-sqlite3";

const PPR_ALPHA = 0.5; // damping (HippoRAG validated)
const PPR_ITERATIONS = 20;
const COOC_BLEND_BETA = 0.3; // weight of co-occurrence vs wiki-links

export interface PPRResult {
  noteId: string;
  score: number;
}

export function personalizedPageRankCombined(
  db: Database.Database,
  seeds: Map<string, number>,
  wikiLinks: Map<string, string[]>,
  maxResults: number = 15,
): PPRResult[] {
  if (seeds.size === 0) return [];

  // Build adjacency: wiki-links (weight 1.0) + co-occurrence (weight β × npmi)
  const adj = new Map<string, Map<string, number>>();

  // Wiki-links
  for (const [src, targets] of wikiLinks) {
    if (!adj.has(src)) adj.set(src, new Map());
    for (const tgt of targets) {
      adj.get(src)!.set(tgt, (adj.get(src)!.get(tgt) ?? 0) + 1.0);
    }
  }

  // Co-occurrence edges (bidirectional)
  const coocEdges = db
    .prepare(
      `
    SELECT note_a, note_b, COALESCE(npmi_weight, 0.1) as w
    FROM co_occurrence WHERE COALESCE(npmi_weight, 0.1) > 0
  `,
    )
    .all() as { note_a: string; note_b: string; w: number }[];

  for (const { note_a, note_b, w } of coocEdges) {
    if (!adj.has(note_a)) adj.set(note_a, new Map());
    if (!adj.has(note_b)) adj.set(note_b, new Map());
    adj
      .get(note_a)!
      .set(
        note_b,
        (adj.get(note_a)!.get(note_b) ?? 0) + COOC_BLEND_BETA * w,
      );
    adj
      .get(note_b)!
      .set(
        note_a,
        (adj.get(note_b)!.get(note_a) ?? 0) + COOC_BLEND_BETA * w,
      );
  }

  // All nodes
  const allNodes = new Set<string>();
  for (const [src, targets] of adj) {
    allNodes.add(src);
    for (const tgt of targets.keys()) allNodes.add(tgt);
  }
  for (const s of seeds.keys()) allNodes.add(s);

  // Initialize PPR vector from seeds
  const seedTotal =
    [...seeds.values()].reduce((a, b) => a + b, 0) || 1;
  let ppr = new Map<string, number>();
  for (const node of allNodes) {
    ppr.set(node, (seeds.get(node) ?? 0) / seedTotal);
  }

  // Iterate power method
  for (let iter = 0; iter < PPR_ITERATIONS; iter++) {
    const next = new Map<string, number>();
    for (const node of allNodes) next.set(node, 0);

    for (const [src, neighbors] of adj) {
      const srcScore = ppr.get(src) ?? 0;
      const totalWeight = [...neighbors.values()].reduce(
        (a, b) => a + b,
        0,
      );
      if (totalWeight === 0) continue;

      for (const [tgt, w] of neighbors) {
        next.set(
          tgt,
          (next.get(tgt) ?? 0) +
            (1 - PPR_ALPHA) * srcScore * (w / totalWeight),
        );
      }
    }

    // Add teleport back to seeds
    for (const node of allNodes) {
      const teleport =
        PPR_ALPHA * ((seeds.get(node) ?? 0) / seedTotal);
      next.set(node, (next.get(node) ?? 0) + teleport);
    }

    ppr = next;
  }

  // Return sorted results — FIX: include seeds (let RRF deduplicate)
  return [...ppr.entries()]
    .map(([noteId, score]) => ({ noteId, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

// Re-export constants for tests
export { PPR_ALPHA, PPR_ITERATIONS, COOC_BLEND_BETA };
