/**
 * Spreading activation engine.
 *
 * When notes are retrieved, vitality boosts propagate to neighbors along
 * wiki-link edges. Boosts are stored in SQLite, not frontmatter.
 */

import type Database from "better-sqlite3";
import type { LinkGraph } from "./graph.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ActivationConfig {
  enabled: boolean;     // default true
  damping: number;      // default 0.6
  max_hops: number;     // default 2
  min_boost: number;    // default 0.01
}

export const DEFAULT_ACTIVATION_CONFIG: ActivationConfig = {
  enabled: true,
  damping: 0.6,
  max_hops: 2,
  min_boost: 0.01,
};

// ---------------------------------------------------------------------------
// Spread computation
// ---------------------------------------------------------------------------

export interface ActivationResult {
  source: string;
  utility: number;
  propagated: Map<string, number>;  // title → boost amount
}

/**
 * BFS from source. At hop k: boost = utility × damping^k.
 * Undirected: follows both linkGraph.outgoing and linkGraph.incoming.
 * Visited set = shortest-path guarantee, no double-counting.
 * Source note does NOT self-boost.
 */
export function computeActivationSpread(
  source: string,
  utility: number,
  linkGraph: LinkGraph,
  config: ActivationConfig = DEFAULT_ACTIVATION_CONFIG,
): ActivationResult {
  const propagated = new Map<string, number>();

  if (!config.enabled || utility <= 0 || config.max_hops <= 0) {
    return { source, utility, propagated };
  }

  const visited = new Set<string>();
  visited.add(source); // source does NOT self-boost

  // BFS: queue of [title, hop_distance]
  let frontier: Array<[string, number]> = [[source, 0]];

  while (frontier.length > 0) {
    const nextFrontier: Array<[string, number]> = [];

    for (const [node, hop] of frontier) {
      if (hop >= config.max_hops) continue;

      // Get undirected neighbors
      const outgoing = linkGraph.outgoing.get(node);
      const incoming = linkGraph.incoming.get(node);
      const neighbors = new Set<string>();
      if (outgoing) for (const n of outgoing) neighbors.add(n);
      if (incoming) for (const n of incoming) neighbors.add(n);

      for (const neighbor of neighbors) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);

        const nextHop = hop + 1;
        const boost = utility * Math.pow(config.damping, nextHop);

        if (boost >= config.min_boost) {
          propagated.set(neighbor, boost);
          nextFrontier.push([neighbor, nextHop]);
        }
      }
    }

    frontier = nextFrontier;
  }

  return { source, utility, propagated };
}

// ---------------------------------------------------------------------------
// SQLite persistence
// ---------------------------------------------------------------------------

/** Base decay constant: half-life ~7 days for single-access notes */
const BASE_DECAY_RATE = 0.1;

/** Maximum boost a single query can contribute to one note */
const PER_QUERY_CAP = 0.05;

/**
 * Ebbinghaus decay rate: repeated access across sessions slows forgetting.
 *
 * Single access: decay_rate = 0.1 (half-life ~7 days)
 * 5 accesses, 3 sessions: decay_rate ≈ 0.05 (half-life ~14 days)
 * 20 accesses, 10 sessions: decay_rate ≈ 0.025 (half-life ~28 days)
 *
 * Formula: base_rate / (1 + 0.2 * ln(1 + access_count) + 0.3 * ln(1 + session_count))
 * Access count provides base strengthening, session spread provides deeper consolidation.
 */
export function ebbinghausDecayRate(accessCount: number, sessionCount: number): number {
  const strengthening = 0.2 * Math.log1p(accessCount) + 0.3 * Math.log1p(sessionCount);
  return BASE_DECAY_RATE / (1 + strengthening);
}

/**
 * Load all boosts from DB. Apply Ebbinghaus time-based decay at read time.
 * Notes accessed more frequently and across more sessions decay slower.
 */
export function loadBoosts(db: InstanceType<typeof Database>): Map<string, number> {
  const rows = db
    .prepare("SELECT title, boost, updated, access_count, sessions FROM boosts")
    .all() as Array<{ title: string; boost: number; updated: string; access_count: number; sessions: string }>;

  const now = new Date();
  const result = new Map<string, number>();

  for (const row of rows) {
    const updatedDate = new Date(row.updated);
    const daysSinceUpdate = Math.max(0, (now.getTime() - updatedDate.getTime()) / (1000 * 60 * 60 * 24));
    const accessCount = row.access_count ?? 1;
    const sessionCount = row.sessions ? row.sessions.split(",").filter(Boolean).length : 1;
    const decayRate = ebbinghausDecayRate(accessCount, sessionCount);
    const decayedBoost = row.boost * Math.exp(-decayRate * daysSinceUpdate);

    if (decayedBoost >= 0.001) {
      result.set(row.title, decayedBoost);
    }
  }

  return result;
}

/**
 * Write boosts to DB in one transaction.
 * DECAY-BEFORE-ACCUMULATE: read existing, decay to now, accumulate via log-scale, store.
 * Tracks access_count and session spread for Ebbinghaus decay.
 */
export function applyActivationBoosts(
  db: InstanceType<typeof Database>,
  boosts: Map<string, number>,
  sessionId?: string,
): void {
  if (boosts.size === 0) return;

  const now = new Date();
  const nowISO = now.toISOString();

  const selectStmt = db.prepare("SELECT boost, updated, access_count, sessions FROM boosts WHERE title = ?");
  const upsertStmt = db.prepare(
    "INSERT OR REPLACE INTO boosts (title, boost, updated, access_count, sessions) VALUES (?, ?, ?, ?, ?)"
  );

  const transaction = db.transaction(() => {
    for (const [title, newBoost] of boosts) {
      const cappedBoost = Math.min(newBoost, PER_QUERY_CAP);

      const existing = selectStmt.get(title) as {
        boost: number; updated: string; access_count: number; sessions: string;
      } | undefined;

      // Decay using Ebbinghaus rate (access-aware)
      const accessCount = (existing?.access_count ?? 0) + 1;
      const existingSessions = existing?.sessions ? existing.sessions.split(",").filter(Boolean) : [];
      const sessionSet = new Set(existingSessions);
      if (sessionId) sessionSet.add(sessionId);
      const sessionCount = sessionSet.size || 1;
      const decayRate = ebbinghausDecayRate(accessCount - 1, sessionCount); // decay existing at old rate

      const decayedExisting = existing
        ? existing.boost * Math.exp(-decayRate * Math.max(0,
            (now.getTime() - new Date(existing.updated).getTime()) / (1000 * 60 * 60 * 24)))
        : 0;

      // Log-scale accumulation: asymptotic approach to 1.0
      const finalBoost = 1 - (1 - decayedExisting) * (1 - cappedBoost);

      // Keep only last 20 session IDs to bound storage
      const sessionsStr = [...sessionSet].slice(-20).join(",");

      upsertStmt.run(title, finalBoost, nowISO, accessCount, sessionsStr);
    }
  });

  transaction();
}
