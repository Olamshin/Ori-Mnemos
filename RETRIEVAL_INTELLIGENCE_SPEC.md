# Ori Retrieval Intelligence — Implementation Spec

Three layers built on the existing 4-signal RRF pipeline. Each layer has its own file(s), its own SQLite tables, and clear integration points into the existing code.

**Research reference:** `brain/notes/ori-retrieval-intelligence-final-build-plan-synthesizes-63-sources-into-three-layered-systems-with-exact-formulas-and-justified-cuts.md`

---

## LAYER 1: Q-Value Reranking

### New files

```
src/core/qvalue.ts          — Q-value storage, update, decay, exploration bonus
src/core/rerank.ts          — Phase B reranking (z-norm, lambda blend, bias cap)
src/core/reward.ts          — Session reward accumulator, credit assignment
```

### Modified files

```
src/core/engine.ts          — Add Q-value tables to initDB()
src/cli/search.ts           — Insert Phase B after RRF fusion in runQueryRanked()
src/cli/serve.ts            — Wire session reward accumulator, flush on server close
src/core/tracking.ts        — Extend logAccess() to write retrieval_log table
```

---

### `src/core/qvalue.ts`

```typescript
import Database from "better-sqlite3";

// Constants
const ALPHA = 0.1;
const DEFAULT_Q = 0.5;
const DECAY_RATE = 0.007;          // half-life ~99 days
const EXPOSURE_BETA = 0.5;

// --- Schema ---

export function initQValueTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_q (
      note_id TEXT PRIMARY KEY,
      q_value REAL NOT NULL DEFAULT 0.5,
      update_count INTEGER NOT NULL DEFAULT 0,
      exposure_count INTEGER NOT NULL DEFAULT 0,
      reward_sum REAL NOT NULL DEFAULT 0,
      reward_sq_sum REAL NOT NULL DEFAULT 0,
      last_updated TEXT NOT NULL DEFAULT (datetime('now')),
      last_reward REAL,
      created TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS q_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id TEXT NOT NULL,
      old_q REAL NOT NULL,
      new_q REAL NOT NULL,
      reward REAL NOT NULL,
      reward_source TEXT NOT NULL,
      session_id TEXT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS retrieval_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      query_text TEXT NOT NULL,
      query_type TEXT,
      note_id TEXT NOT NULL,
      rank INTEGER NOT NULL,
      similarity_score REAL,
      q_score REAL,
      ucb_bonus REAL,
      final_score REAL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_q_history_note ON q_history(note_id);
    CREATE INDEX IF NOT EXISTS idx_retrieval_session ON retrieval_log(session_id);
    CREATE INDEX IF NOT EXISTS idx_retrieval_note ON retrieval_log(note_id);
  `);
}

// --- Read ---

export function getQ(db: Database.Database, noteId: string): number {
  const row = db.prepare("SELECT q_value FROM note_q WHERE note_id = ?").get(noteId) as
    | { q_value: number }
    | undefined;
  return row?.q_value ?? DEFAULT_Q;
}

export function getDecayedQ(db: Database.Database, noteId: string): number {
  const row = db.prepare(
    "SELECT q_value, last_updated FROM note_q WHERE note_id = ?"
  ).get(noteId) as { q_value: number; last_updated: string } | undefined;

  if (!row) return DEFAULT_Q;

  const daysSince =
    (Date.now() - new Date(row.last_updated).getTime()) / 86_400_000;

  // Q-informed decay: high-Q notes decay slower
  let mult = 1.0;
  if (row.q_value >= 0.7) mult = 0.7;
  else if (row.q_value <= 0.3) mult = 1.3;

  return row.q_value * Math.exp(-DECAY_RATE * mult * daysSince);
}

export function getRewardStats(
  db: Database.Database,
  noteId: string
): { mean: number; variance: number; count: number } {
  const row = db.prepare(
    "SELECT update_count, reward_sum, reward_sq_sum FROM note_q WHERE note_id = ?"
  ).get(noteId) as
    | { update_count: number; reward_sum: number; reward_sq_sum: number }
    | undefined;

  if (!row || row.update_count === 0)
    return { mean: 0, variance: 0.25, count: 0 };

  const mean = row.reward_sum / row.update_count;
  const variance =
    row.reward_sq_sum / row.update_count - mean * mean;
  return { mean, variance: Math.max(0, variance), count: row.update_count };
}

export function getExposureCount(db: Database.Database, noteId: string): number {
  const row = db.prepare(
    "SELECT exposure_count FROM note_q WHERE note_id = ?"
  ).get(noteId) as { exposure_count: number } | undefined;
  return row?.exposure_count ?? 0;
}

export function getTotalQUpdates(db: Database.Database): number {
  const row = db.prepare(
    "SELECT COALESCE(SUM(update_count), 0) as total FROM note_q"
  ).get() as { total: number };
  return row.total;
}

export function getTotalQueryCount(db: Database.Database): number {
  const row = db.prepare(
    "SELECT COUNT(DISTINCT session_id || query_text) as total FROM retrieval_log"
  ).get() as { total: number };
  return row.total;
}

// --- Write ---

export function updateQ(
  db: Database.Database,
  noteId: string,
  reward: number,
  sessionId: string
): void {
  const oldQ = getQ(db, noteId);
  const newQ = oldQ + ALPHA * (reward - oldQ);

  db.prepare(`
    INSERT INTO note_q (note_id, q_value, update_count, reward_sum, reward_sq_sum, last_updated, last_reward)
    VALUES (?, ?, 1, ?, ?, datetime('now'), ?)
    ON CONFLICT(note_id) DO UPDATE SET
      q_value = ?,
      update_count = update_count + 1,
      reward_sum = reward_sum + ?,
      reward_sq_sum = reward_sq_sum + ?,
      last_updated = datetime('now'),
      last_reward = ?
  `).run(
    noteId, newQ, reward, reward * reward, reward,
    newQ, reward, reward * reward, reward
  );

  db.prepare(`
    INSERT INTO q_history (note_id, old_q, new_q, reward, reward_source, session_id)
    VALUES (?, ?, ?, ?, 'session_batch', ?)
  `).run(noteId, oldQ, newQ, reward, sessionId);
}

export function incrementExposure(db: Database.Database, noteId: string): void {
  db.prepare(`
    INSERT INTO note_q (note_id, exposure_count)
    VALUES (?, 1)
    ON CONFLICT(note_id) DO UPDATE SET exposure_count = exposure_count + 1
  `).run(noteId);
}

export function logRetrieval(
  db: Database.Database,
  sessionId: string,
  queryText: string,
  queryType: string,
  noteId: string,
  rank: number,
  simScore: number,
  qScore: number,
  ucbBonus: number,
  finalScore: number
): void {
  db.prepare(`
    INSERT INTO retrieval_log
      (session_id, query_text, query_type, note_id, rank,
       similarity_score, q_score, ucb_bonus, final_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, queryText, queryType, noteId, rank,
    simScore, qScore, ucbBonus, finalScore);
}

// --- Exploration: UCB-Tuned ---

export function explorationBonus(
  stats: { mean: number; variance: number; count: number },
  totalQueries: number,
  c: number = 0.2
): number {
  if (stats.count === 0) return c * 2.5;
  const logT = Math.log(totalQueries + 1);
  const V = stats.variance + Math.sqrt((2 * logT) / stats.count);
  return c * Math.sqrt((logT / stats.count) * Math.min(0.25, V));
}

// --- Batch update ---

export function batchUpdateQ(
  db: Database.Database,
  rewards: Map<string, number>,
  sessionId: string
): void {
  const tx = db.transaction(() => {
    for (const [noteId, reward] of rewards) {
      updateQ(db, noteId, reward, sessionId);
    }
  });
  tx();
}
```

---

### `src/core/reward.ts`

```typescript
import Database from "better-sqlite3";
import { getExposureCount } from "./qvalue.js";

const EXPOSURE_BETA = 0.5;

interface RetrievalEvent {
  noteId: string;
  rank: number;
  queryText: string;
  queryType: string;
}

interface SessionOutcome {
  forwardCitations: string[];   // note IDs cited in ori_add content
  updatedNotes: string[];       // note IDs passed to ori_update
  createdNotes: string[];       // note IDs created via ori_add
  reRecalledNotes: string[];    // notes retrieved in multiple queries this session
}

export class SessionRewardAccumulator {
  private retrievals: RetrievalEvent[] = [];
  private addedContent: string[] = [];       // raw content from ori_add calls
  private updatedNoteIds: string[] = [];     // note IDs from ori_update calls
  private createdNoteIds: string[] = [];     // note IDs from ori_add calls
  readonly sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  logRetrieval(noteId: string, rank: number, queryText: string, queryType: string): void {
    this.retrievals.push({ noteId, rank, queryText, queryType });
  }

  logAdd(noteId: string, content: string): void {
    this.createdNoteIds.push(noteId);
    this.addedContent.push(content);
  }

  logUpdate(noteId: string): void {
    this.updatedNoteIds.push(noteId);
  }

  computeRewards(db: Database.Database): Map<string, number> {
    const outcome = this.buildOutcome();
    const credits = new Map<string, number>();
    const seen = new Map<string, number[]>(); // noteId -> ranks across queries

    // Group retrievals by note
    for (const r of this.retrievals) {
      const ranks = seen.get(r.noteId) ?? [];
      ranks.push(r.rank);
      seen.set(r.noteId, ranks);
    }

    for (const [noteId, ranks] of seen) {
      const bestRank = Math.min(...ranks);
      let reward: number;

      if (outcome.forwardCitations.includes(noteId)) {
        reward = 1.0;                                          // full reward
      } else if (outcome.updatedNotes.includes(noteId)) {
        reward = 0.5;
      } else if (outcome.createdNotes.length > 0) {
        reward = 0.6 * (1 / Math.log2(bestRank + 2));         // downstream creation, position-weighted
      } else if (ranks.length > 1) {
        reward = 0.4 * (1 / ranks.length);                    // within-session re-recall, diminishing
      } else if (outcome.forwardCitations.length > 0 || outcome.updatedNotes.length > 0) {
        reward = 0.1 / Math.log2(bestRank + 2);               // some follow-up happened, position-weighted
      } else {
        reward = bestRank <= 2
          ? -0.15 / Math.pow(bestRank + 1, 1.0)               // IPS-debiased dead end (top-3 only)
          : 0;                                                 // low-ranked, not examined, no penalty
      }

      // Exposure-aware correction
      const exposure = getExposureCount(db, noteId);
      if (exposure > 1) {
        reward = reward / Math.pow(exposure, EXPOSURE_BETA);
      }

      credits.set(noteId, Math.max(-1, Math.min(1, reward)));
    }

    return credits;
  }

  private buildOutcome(): SessionOutcome {
    // Detect forward citations: [[note title]] in ori_add content
    const retrievedIds = new Set(this.retrievals.map((r) => r.noteId));
    const forwardCitations: string[] = [];

    for (const content of this.addedContent) {
      const links = content.match(/\[\[([^\]]+)\]\]/g) ?? [];
      for (const link of links) {
        const title = link.slice(2, -2);
        // Match against retrieved note IDs (which are title-based)
        if (retrievedIds.has(title)) {
          forwardCitations.push(title);
        }
      }
    }

    return {
      forwardCitations: [...new Set(forwardCitations)],
      updatedNotes: [...new Set(this.updatedNoteIds)],
      createdNotes: [...new Set(this.createdNoteIds)],
      reRecalledNotes: [],  // computed in computeRewards
    };
  }

  hasData(): boolean {
    return this.retrievals.length > 0;
  }
}
```

---

### `src/core/rerank.ts`

```typescript
import Database from "better-sqlite3";
import { ScoredNote } from "./ranking.js";
import {
  getDecayedQ,
  getRewardStats,
  getTotalQUpdates,
  getTotalQueryCount,
  explorationBonus,
  incrementExposure,
  logRetrieval,
} from "./qvalue.js";

// Constants
const LAMBDA_MIN = 0.15;
const LAMBDA_MAX = 0.50;
const LAMBDA_MATURITY = 200;
const MAX_CUMULATIVE_BIAS = 3.0;
const EXCESS_COMPRESSION = 0.3;
const K2 = 8;

const QUERY_TYPE_SHIFTS: Record<string, number> = {
  semantic: -0.10,
  procedural: 0.15,
  decision: 0.05,
  episodic: 0.0,
};

// --- Z-score normalization ---

function zNormalize(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const std =
    Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / n) || 1;
  return values.map((v) => (v - mean) / std);
}

// --- Lambda ---

function computeLambda(totalQUpdates: number, queryType: string): number {
  const base =
    LAMBDA_MIN +
    (LAMBDA_MAX - LAMBDA_MIN) * Math.min(totalQUpdates / LAMBDA_MATURITY, 1.0);
  const shift = QUERY_TYPE_SHIFTS[queryType] ?? 0;
  return Math.max(0.1, Math.min(0.6, base + shift));
}

// --- Phase B ---

export function phaseB(
  db: Database.Database,
  candidates: ScoredNote[],
  queryText: string,
  queryType: string,
  sessionId: string
): ScoredNote[] {
  if (candidates.length === 0) return [];

  const totalUpdates = getTotalQUpdates(db);
  const totalQueries = getTotalQueryCount(db);
  const lambda = computeLambda(totalUpdates, queryType);

  // Get raw scores
  const simRaw = candidates.map((c) => c.score);
  const qRaw = candidates.map((c) => getDecayedQ(db, c.title));

  // Z-score normalize both
  const simNorm = zNormalize(simRaw);
  const qNorm = zNormalize(qRaw);

  const results = candidates.map((c, i) => {
    // Lambda blend
    const blended = (1 - lambda) * simNorm[i] + lambda * qNorm[i];

    // UCB-Tuned exploration bonus
    const stats = getRewardStats(db, c.title);
    const ucb = explorationBonus(stats, totalQueries);

    // Raw Phase B score
    let score = blended + ucb;

    // Cumulative bias cap
    const maxAllowed = c.score * MAX_CUMULATIVE_BIAS;
    if (score > maxAllowed) {
      score = maxAllowed + (score - maxAllowed) * EXCESS_COMPRESSION;
    }

    // Log retrieval and increment exposure
    incrementExposure(db, c.title);

    return { ...c, score, _simNorm: simNorm[i], _qNorm: qNorm[i], _ucb: ucb };
  });

  // Sort and take top k2
  results.sort((a, b) => b.score - a.score);
  const topK = results.slice(0, K2);

  // Log all results to retrieval_log
  for (let rank = 0; rank < topK.length; rank++) {
    const r = topK[rank];
    logRetrieval(
      db, sessionId, queryText, queryType, r.title, rank,
      (r as any)._simNorm, (r as any)._qNorm, (r as any)._ucb, r.score
    );
  }

  return topK;
}
```

---

### Integration: `src/cli/search.ts`

In `runQueryRanked()`, after the existing RRF fusion call and before returning results:

```typescript
// --- EXISTING CODE ---
const fused = fuseScoreWeightedRRF(composite, keyword, graph, warmth, config);
// activation spreading, exploration injection, etc.

// --- NEW: Phase B Q-value reranking ---
import { phaseB } from "../core/rerank.js";

const reranked = phaseB(db, fused, query, intent, sessionId);
// Use `reranked` instead of `fused` for final results
```

### Integration: `src/cli/serve.ts`

```typescript
import { SessionRewardAccumulator } from "../core/reward.js";
import { batchUpdateQ, initQValueTables } from "../core/qvalue.js";

// At server init:
initQValueTables(db);
const sessionId = crypto.randomUUID();
const rewardAccumulator = new SessionRewardAccumulator(sessionId);

// In ori_query_ranked handler — after getting results:
for (const [rank, note] of results.entries()) {
  rewardAccumulator.logRetrieval(note.title, rank, query, intent);
}

// In ori_add handler:
rewardAccumulator.logAdd(noteId, content);

// In ori_update handler:
rewardAccumulator.logUpdate(noteId);

// On server close (process.on('exit') or transport close):
if (rewardAccumulator.hasData()) {
  const rewards = rewardAccumulator.computeRewards(db);
  batchUpdateQ(db, rewards, sessionId);
}
```

### Test criteria (Layer 1)

1. `note_q` table populated after first session with retrievals
2. Q-values diverge from 0.5 after sessions with forward citations
3. Phase B reranking changes result order vs Phase A alone
4. Forward-cited notes get Q > 0.5 after one session
5. Dead-end top-3 notes get Q < 0.5 after one session
6. Exposure correction: a note retrieved 50 times has diminished reward impact
7. UCB-Tuned bonus is higher for rarely-retrieved notes
8. Lambda increases as totalQUpdates grows toward 200
9. Cumulative bias cap prevents any score from exceeding 3× original

---

## LAYER 2: Co-occurrence Edges

### New files

```
src/core/cooccurrence.ts    — Edge storage, NPMI, decay, homeostasis, bootstrap
src/core/ppr.ts             — Personalized PageRank on combined graph
```

### Modified files

```
src/core/engine.ts          — Add co_occurrence table to initDB()
src/core/reward.ts          — Extract co-occurrence pairs at session end
src/cli/search.ts           — Add PPR results to Phase A candidates
```

---

### `src/core/cooccurrence.ts`

```typescript
import Database from "better-sqlite3";

// Constants
const GLOVE_XMAX = 100;
const GLOVE_ALPHA = 0.75;
const EBBINGHAUS_BASE_DAYS = 30;
const STRENGTH_RATE = 0.2;
const DECAY_FLOOR = 0.05;
const HOMEOSTASIS_TARGET = 0.5;
const BOOTSTRAP_BCS_THRESHOLD = 0.1;
const BOOTSTRAP_INIT_WEIGHT = 0.15;

// --- Schema ---

export function initCoOccurrenceTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS co_occurrence (
      note_a TEXT NOT NULL,
      note_b TEXT NOT NULL,
      co_retrieval_count INTEGER NOT NULL DEFAULT 1,
      npmi_weight REAL,
      trust_weight REAL NOT NULL DEFAULT 1.0,
      first_observed TEXT NOT NULL DEFAULT (datetime('now')),
      last_co_retrieved TEXT NOT NULL DEFAULT (datetime('now')),
      source TEXT NOT NULL DEFAULT 'retrieval',
      PRIMARY KEY (note_a, note_b)
    );
    CREATE INDEX IF NOT EXISTS idx_cooc_a ON co_occurrence(note_a);
    CREATE INDEX IF NOT EXISTS idx_cooc_b ON co_occurrence(note_b);
  `);
}

// --- NPMI ---

export function computeNPMI(
  countAB: number,
  countA: number,
  countB: number,
  totalEvents: number
): number {
  if (countAB === 0 || totalEvents === 0) return -1;
  const pAB = countAB / totalEvents;
  const pA = countA / totalEvents;
  const pB = countB / totalEvents;
  if (pA === 0 || pB === 0) return -1;
  const pmi = Math.log(pAB / (pA * pB));
  const denom = -Math.log(pAB);
  return denom === 0 ? 0 : pmi / denom;
}

// --- GloVe frequency weight ---

function gloveWeight(count: number): number {
  return count < GLOVE_XMAX
    ? Math.pow(count / GLOVE_XMAX, GLOVE_ALPHA)
    : 1.0;
}

// --- Ebbinghaus decay with strength accumulation ---

export function edgeDecay(daysSince: number, coRetrievalCount: number): number {
  const strength = 1 + STRENGTH_RATE * Math.log1p(coRetrievalCount);
  const retention = Math.exp(-daysSince / (EBBINGHAUS_BASE_DAYS * strength));
  return Math.max(DECAY_FLOOR, retention);
}

// --- Composite edge weight ---

export function computeEdgeWeight(
  coRetrievalCount: number,
  totalRetrievalsA: number,
  totalRetrievalsB: number,
  totalEvents: number,
  daysSince: number,
  trustWeight: number = 1.0
): number {
  const npmi = computeNPMI(coRetrievalCount, totalRetrievalsA, totalRetrievalsB, totalEvents);
  const freq = gloveWeight(coRetrievalCount);
  const decay = edgeDecay(daysSince, coRetrievalCount);
  return Math.max(0, npmi * freq * trustWeight * decay);
}

// --- Record co-retrieval ---

export function recordCoRetrieval(
  db: Database.Database,
  noteA: string,
  noteB: string,
  trustWeight: number = 1.0
): void {
  // Ensure consistent ordering (alphabetical) so (A,B) == (B,A)
  const [a, b] = noteA < noteB ? [noteA, noteB] : [noteB, noteA];

  db.prepare(`
    INSERT INTO co_occurrence (note_a, note_b, co_retrieval_count, trust_weight, source)
    VALUES (?, ?, 1, ?, 'retrieval')
    ON CONFLICT(note_a, note_b) DO UPDATE SET
      co_retrieval_count = co_retrieval_count + 1,
      last_co_retrieved = datetime('now')
  `).run(a, b, trustWeight);
}

// --- Extract pairs from session retrievals ---

export function extractCoOccurrencePairs(
  db: Database.Database,
  sessionId: string
): void {
  // Get all notes retrieved in this session, grouped by query
  const rows = db.prepare(`
    SELECT query_text, GROUP_CONCAT(note_id) as notes
    FROM retrieval_log
    WHERE session_id = ?
    GROUP BY query_text
  `).all(sessionId) as { query_text: string; notes: string }[];

  for (const row of rows) {
    const notes = row.notes.split(",");
    // Create pairs from co-retrieved notes within same query
    for (let i = 0; i < notes.length; i++) {
      for (let j = i + 1; j < notes.length; j++) {
        recordCoRetrieval(db, notes[i], notes[j]);
      }
    }
  }
}

// --- Per-node homeostasis (Turrigiano) ---

export function runHomeostasis(db: Database.Database): void {
  // Get all nodes and their edge weights
  const nodes = db.prepare(`
    SELECT note_a as node, AVG(npmi_weight) as mean_w, COUNT(*) as cnt
    FROM co_occurrence WHERE npmi_weight IS NOT NULL
    GROUP BY note_a
    UNION
    SELECT note_b as node, AVG(npmi_weight) as mean_w, COUNT(*) as cnt
    FROM co_occurrence WHERE npmi_weight IS NOT NULL
    GROUP BY note_b
  `).all() as { node: string; mean_w: number; cnt: number }[];

  const tx = db.transaction(() => {
    for (const { node, mean_w } of nodes) {
      if (mean_w === 0 || mean_w === HOMEOSTASIS_TARGET) continue;
      const scale = HOMEOSTASIS_TARGET / mean_w;

      // Scale all outgoing edges from this node
      db.prepare(`
        UPDATE co_occurrence SET npmi_weight = npmi_weight * ?
        WHERE note_a = ? AND npmi_weight IS NOT NULL
      `).run(scale, node);
    }
  });
  tx();
}

// --- Recompute all NPMI weights ---

export function recomputeAllNPMI(db: Database.Database): void {
  const totalEvents = (db.prepare(
    "SELECT COUNT(DISTINCT session_id || query_text) as n FROM retrieval_log"
  ).get() as { n: number }).n;

  if (totalEvents === 0) return;

  const edges = db.prepare("SELECT note_a, note_b, co_retrieval_count FROM co_occurrence").all() as {
    note_a: string; note_b: string; co_retrieval_count: number;
  }[];

  // Count per-note retrievals
  const noteCounts = new Map<string, number>();
  const rows = db.prepare(
    "SELECT note_id, COUNT(*) as cnt FROM retrieval_log GROUP BY note_id"
  ).all() as { note_id: string; cnt: number }[];
  for (const r of rows) noteCounts.set(r.note_id, r.cnt);

  const tx = db.transaction(() => {
    for (const edge of edges) {
      const countA = noteCounts.get(edge.note_a) ?? 0;
      const countB = noteCounts.get(edge.note_b) ?? 0;
      const daysSince = 0; // Will be computed from last_co_retrieved at query time
      const weight = computeEdgeWeight(
        edge.co_retrieval_count, countA, countB, totalEvents, daysSince
      );
      db.prepare("UPDATE co_occurrence SET npmi_weight = ? WHERE note_a = ? AND note_b = ?")
        .run(weight, edge.note_a, edge.note_b);
    }
  });
  tx();
}

// --- Bootstrap from wiki-links (bibliographic coupling) ---

export function bootstrapFromWikiLinks(
  db: Database.Database,
  noteLinks: Map<string, Set<string>>
): void {
  const notes = [...noteLinks.keys()];
  const tx = db.transaction(() => {
    for (let i = 0; i < notes.length; i++) {
      for (let j = i + 1; j < notes.length; j++) {
        const linksA = noteLinks.get(notes[i])!;
        const linksB = noteLinks.get(notes[j])!;
        const intersection = new Set([...linksA].filter((x) => linksB.has(x)));
        if (intersection.size === 0) continue;

        const bcs = intersection.size / Math.sqrt(linksA.size * linksB.size);
        if (bcs < BOOTSTRAP_BCS_THRESHOLD) continue;

        db.prepare(`
          INSERT OR IGNORE INTO co_occurrence
            (note_a, note_b, co_retrieval_count, npmi_weight, source)
          VALUES (?, ?, 0, ?, 'bootstrap')
        `).run(notes[i], notes[j], bcs * BOOTSTRAP_INIT_WEIGHT);
      }
    }
  });
  tx();
}
```

---

### `src/core/ppr.ts`

PPR on the combined wiki-link + co-occurrence graph for retrieval.

```typescript
import Database from "better-sqlite3";

const PPR_ALPHA = 0.5;   // damping (HippoRAG validated)
const PPR_ITERATIONS = 20;
const COOC_BLEND_BETA = 0.3;  // weight of co-occurrence vs wiki-links

export interface PPRResult {
  noteId: string;
  score: number;
}

export function personalizedPageRankCombined(
  db: Database.Database,
  seeds: Map<string, number>,        // noteId -> seed weight
  wikiLinks: Map<string, string[]>,  // noteId -> outgoing link titles
  maxResults: number = 15
): PPRResult[] {
  // Build adjacency: wiki-links (weight 1.0) + co-occurrence (weight β * npmi)
  const adj = new Map<string, Map<string, number>>();

  // Wiki-links
  for (const [src, targets] of wikiLinks) {
    if (!adj.has(src)) adj.set(src, new Map());
    for (const tgt of targets) {
      adj.get(src)!.set(tgt, (adj.get(src)!.get(tgt) ?? 0) + 1.0);
    }
  }

  // Co-occurrence edges
  const coocEdges = db.prepare(`
    SELECT note_a, note_b, COALESCE(npmi_weight, 0.1) as w
    FROM co_occurrence WHERE npmi_weight > 0
  `).all() as { note_a: string; note_b: string; w: number }[];

  for (const { note_a, note_b, w } of coocEdges) {
    if (!adj.has(note_a)) adj.set(note_a, new Map());
    if (!adj.has(note_b)) adj.set(note_b, new Map());
    adj.get(note_a)!.set(note_b, (adj.get(note_a)!.get(note_b) ?? 0) + COOC_BLEND_BETA * w);
    adj.get(note_b)!.set(note_a, (adj.get(note_b)!.get(note_a) ?? 0) + COOC_BLEND_BETA * w);
  }

  // All nodes
  const allNodes = new Set<string>();
  for (const [src, targets] of adj) {
    allNodes.add(src);
    for (const tgt of targets.keys()) allNodes.add(tgt);
  }
  for (const s of seeds.keys()) allNodes.add(s);

  // Initialize PPR vector
  const ppr = new Map<string, number>();
  const seedTotal = [...seeds.values()].reduce((a, b) => a + b, 0) || 1;
  for (const node of allNodes) {
    ppr.set(node, (seeds.get(node) ?? 0) / seedTotal);
  }

  // Iterate
  for (let iter = 0; iter < PPR_ITERATIONS; iter++) {
    const next = new Map<string, number>();
    for (const node of allNodes) next.set(node, 0);

    for (const [src, neighbors] of adj) {
      const srcScore = ppr.get(src) ?? 0;
      const totalWeight = [...neighbors.values()].reduce((a, b) => a + b, 0);
      if (totalWeight === 0) continue;

      for (const [tgt, w] of neighbors) {
        next.set(tgt, (next.get(tgt) ?? 0) + (1 - PPR_ALPHA) * srcScore * (w / totalWeight));
      }
    }

    // Add teleport
    for (const node of allNodes) {
      const teleport = PPR_ALPHA * ((seeds.get(node) ?? 0) / seedTotal);
      next.set(node, (next.get(node) ?? 0) + teleport);
    }

    // Copy
    for (const [k, v] of next) ppr.set(k, v);
  }

  // Return sorted results, excluding seeds
  return [...ppr.entries()]
    .filter(([id]) => !seeds.has(id))
    .map(([noteId, score]) => ({ noteId, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}
```

### Integration into Phase A

In `src/cli/search.ts`, before RRF fusion:

```typescript
import { personalizedPageRankCombined } from "../core/ppr.js";

// After semantic search identifies top candidates, use them as PPR seeds
const pprSeeds = new Map(compositeResults.slice(0, 5).map(r => [r.title, r.score]));
const pprResults = personalizedPageRankCombined(db, pprSeeds, wikiLinkGraph);

// Merge PPR results into candidate pool before RRF
// PPR surfaces notes connected by co-occurrence that semantic search missed
```

### Session-end update for Layer 2

In `src/cli/serve.ts`, on server close (after Layer 1 Q-updates):

```typescript
import { extractCoOccurrencePairs, recomputeAllNPMI, runHomeostasis } from "../core/cooccurrence.js";

// 1. Extract co-occurrence pairs from this session's retrieval log
extractCoOccurrencePairs(db, sessionId);

// 2. Recompute NPMI weights across all edges
recomputeAllNPMI(db);

// 3. Per-node homeostasis
runHomeostasis(db);
```

### Bootstrap (one-time, on `ori index build`)

In the index build command, after embedding:

```typescript
import { bootstrapFromWikiLinks } from "../core/cooccurrence.js";

// Extract wiki-link graph from vault
const noteLinks = extractWikiLinks(vaultPath);
bootstrapFromWikiLinks(db, noteLinks);
```

### Test criteria (Layer 2)

1. Bootstrap creates edges for note pairs sharing 2+ wiki-link targets
2. Co-retrieval within same query creates/increments edge
3. NPMI weights are bounded [-1, 1]
4. High co-retrieval + low individual retrieval = high NPMI (genuine association)
5. High co-retrieval + high individual retrieval = lower NPMI (base rate)
6. Edge decay slows for frequently co-retrieved pairs (strength accumulation)
7. Per-node homeostasis normalizes hub nodes without affecting sparse nodes
8. PPR surfaces notes not in semantic top-15 but connected via co-occurrence

---

## LAYER 3: Stage Meta-Learning

### New files

```
src/core/stage-learner.ts   — LinUCB per stage, decisions, rewards
src/core/stage-tracker.ts   — Quality snapshots before/after each stage
```

### Modified files

```
src/core/engine.ts          — Add stage tables to initDB()
src/cli/search.ts           — Wrap each stage with tracker, consult learner
```

---

### `src/core/stage-learner.ts`

```typescript
import Database from "better-sqlite3";

// Constants
const LINUCB_ALPHA = 0.25;
const D = 8;                        // feature vector dimensions
const MIN_SAMPLES = 15;
const PRECISION_SWITCH = 50;
const VARIANCE_THRESHOLD = 0.05;
const ABSTAIN_THRESHOLD = 0.10;
const COST_PENALTY_ALPHA = 0.2;
const LOAD_BALANCE_LAMBDA = 0.01;
const TIME_BUDGET_MS = 500;
const SOFT_CUTOFF = 0.8;

// --- Schema ---

export function initStageTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stage_q (
      stage_id TEXT PRIMARY KEY,
      a_matrix TEXT NOT NULL,
      b_vector TEXT NOT NULL,
      sample_count INTEGER NOT NULL DEFAULT 0,
      total_reward REAL NOT NULL DEFAULT 0,
      last_updated TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS stage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      stage_id TEXT NOT NULL,
      query_features TEXT NOT NULL,
      decision TEXT NOT NULL,
      quality_before REAL,
      quality_after REAL,
      compute_time_ms REAL,
      reward REAL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_stage_log_stage ON stage_log(stage_id);
  `);
}

// --- Stage configs ---

export interface StageConfig {
  id: string;
  computeCostMs: number;
  skipThreshold: number;
  essential: boolean;       // true = never skip (semantic_search, rrf_fusion)
}

export const STAGE_CONFIGS: StageConfig[] = [
  { id: "semantic_search",    computeCostMs: 20,  skipThreshold: 0.15, essential: true },
  { id: "bm25",               computeCostMs: 10,  skipThreshold: 0.15, essential: false },
  { id: "pagerank",           computeCostMs: 30,  skipThreshold: 0.20, essential: false },
  { id: "warmth",             computeCostMs: 30,  skipThreshold: 0.20, essential: false },
  { id: "hub_dampening",      computeCostMs: 15,  skipThreshold: 0.20, essential: false },
  { id: "gravity_dampening",  computeCostMs: 10,  skipThreshold: 0.20, essential: false },
  { id: "q_reranking",        computeCostMs: 25,  skipThreshold: 0.20, essential: false },
  { id: "cooccurrence_ppr",   computeCostMs: 50,  skipThreshold: 0.30, essential: false },
  { id: "rrf_fusion",         computeCostMs: 5,   skipThreshold: 0.10, essential: true },
];

// --- Query features ---

export function extractQueryFeatures(
  query: string,
  embeddingEntropy: number,
  vaultSize: number,
  queryDepth: number
): number[] {
  const tokens = query.split(/\s+/);
  const unique = new Set(tokens.map((t) => t.toLowerCase()));
  return [
    tokens.length / 50,
    Math.log1p(unique.size) / 10,
    /\?/.test(query) ? 1 : 0,
    /\b(recent|latest|today|yesterday|when)\b/i.test(query) ? 1 : 0,
    /\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)*\b/.test(query) ? 1 : 0,
    embeddingEntropy / 10,
    vaultSize / 1000,
    queryDepth / 10,
  ];
}

// --- LinUCB ---

export class LinUCBStage {
  private A: number[][];
  private b: number[];
  readonly config: StageConfig;

  constructor(config: StageConfig, saved?: { a: number[][]; b: number[] }) {
    this.config = config;
    if (saved) {
      this.A = saved.a;
      this.b = saved.b;
    } else {
      // Identity matrix
      this.A = Array.from({ length: D }, (_, i) =>
        Array.from({ length: D }, (_, j) => (i === j ? 1 : 0))
      );
      this.b = new Array(D).fill(0);
    }
  }

  getUCB(x: number[]): number {
    const Ainv = invertMatrix(this.A);
    const theta = matVecMul(Ainv, this.b);
    const exploit = dot(theta, x);
    const explore = LINUCB_ALPHA * Math.sqrt(dot(x, matVecMul(Ainv, x)));
    return exploit + explore;
  }

  update(x: number[], reward: number): void {
    // A += x x^T
    for (let i = 0; i < D; i++) {
      for (let j = 0; j < D; j++) {
        this.A[i][j] += x[i] * x[j];
      }
    }
    // b += reward * x
    for (let i = 0; i < D; i++) {
      this.b[i] += reward * x[i];
    }
  }

  serialize(): { a: number[][]; b: number[] } {
    return { a: this.A, b: this.b };
  }
}

// --- Decision ---

export function getStageDecision(
  stage: LinUCBStage,
  x: number[],
  elapsedMs: number,
  sampleCount: number
): "run" | "skip" | "abstain" {
  if (stage.config.essential) return "run";
  if (elapsedMs > TIME_BUDGET_MS * SOFT_CUTOFF) return "skip";
  if (sampleCount < MIN_SAMPLES) return "run";   // exploration phase

  const ucb = stage.getUCB(x);
  if (ucb < ABSTAIN_THRESHOLD) return "abstain";
  if (ucb < stage.config.skipThreshold) return "skip";
  return "run";
}

// --- Stage reward ---

export function computeStageReward(
  qualityBefore: number,
  qualityAfter: number,
  computeTimeMs: number
): number {
  const delta = qualityAfter - qualityBefore;
  const reward = delta * 10 - COST_PENALTY_ALPHA * (computeTimeMs / 100);
  return Math.max(-1, Math.min(1, reward));
}

// --- Persistence ---

export function saveStage(db: Database.Database, stage: LinUCBStage, sampleCount: number, totalReward: number): void {
  const { a, b } = stage.serialize();
  db.prepare(`
    INSERT INTO stage_q (stage_id, a_matrix, b_vector, sample_count, total_reward, last_updated)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(stage_id) DO UPDATE SET
      a_matrix = ?, b_vector = ?, sample_count = ?, total_reward = ?, last_updated = datetime('now')
  `).run(
    stage.config.id, JSON.stringify(a), JSON.stringify(b), sampleCount, totalReward,
    JSON.stringify(a), JSON.stringify(b), sampleCount, totalReward
  );
}

export function loadStage(db: Database.Database, config: StageConfig): LinUCBStage {
  const row = db.prepare("SELECT a_matrix, b_vector FROM stage_q WHERE stage_id = ?")
    .get(config.id) as { a_matrix: string; b_vector: string } | undefined;

  if (row) {
    return new LinUCBStage(config, { a: JSON.parse(row.a_matrix), b: JSON.parse(row.b_vector) });
  }
  return new LinUCBStage(config);
}

// --- Linear algebra helpers ---

function dot(a: number[], b: number[]): number {
  return a.reduce((s, v, i) => s + v * b[i], 0);
}

function matVecMul(M: number[][], v: number[]): number[] {
  return M.map((row) => dot(row, v));
}

function invertMatrix(M: number[][]): number[][] {
  // Gauss-Jordan for small d=8 matrix
  const n = M.length;
  const aug = M.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);

  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
    }
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];

    const pivot = aug[col][col];
    if (Math.abs(pivot) < 1e-12) continue;
    for (let j = 0; j < 2 * n; j++) aug[col][j] /= pivot;

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = aug[row][col];
      for (let j = 0; j < 2 * n; j++) aug[row][j] -= factor * aug[col][j];
    }
  }

  return aug.map((row) => row.slice(n));
}
```

---

### `src/core/stage-tracker.ts`

```typescript
export interface StageSnapshot {
  stageId: string;
  qualityBefore: number;
  startTime: number;
}

export class StageTracker {
  private snapshots: Map<string, StageSnapshot> = new Map();
  private results: { stageId: string; qualityBefore: number; qualityAfter: number; computeMs: number }[] = [];

  before(stageId: string, currentQuality: number): void {
    this.snapshots.set(stageId, {
      stageId,
      qualityBefore: currentQuality,
      startTime: performance.now(),
    });
  }

  after(stageId: string, currentQuality: number): void {
    const snap = this.snapshots.get(stageId);
    if (!snap) return;
    this.results.push({
      stageId,
      qualityBefore: snap.qualityBefore,
      qualityAfter: currentQuality,
      computeMs: performance.now() - snap.startTime,
    });
    this.snapshots.delete(stageId);
  }

  getResults() {
    return this.results;
  }
}
```

### Integration into `src/cli/search.ts`

```typescript
import { LinUCBStage, loadStage, saveStage, getStageDecision, computeStageReward, extractQueryFeatures, STAGE_CONFIGS } from "../core/stage-learner.js";
import { StageTracker } from "../core/stage-tracker.js";

// At query time:
const features = extractQueryFeatures(query, embeddingEntropy, noteCount, queryDepth);
const tracker = new StageTracker();
const stages = STAGE_CONFIGS.map(c => loadStage(db, c));
let elapsed = 0;

for (const stage of stages) {
  const sampleCount = /* read from stage_q */ 0;
  const decision = getStageDecision(stage, features, elapsed, sampleCount);

  if (decision === "abstain") break;         // stop pipeline entirely
  if (decision === "skip") continue;

  const qualityBefore = measureCurrentQuality(candidates);
  tracker.before(stage.config.id, qualityBefore);

  const start = performance.now();
  runStage(stage.config.id, candidates);     // execute the actual stage
  elapsed += performance.now() - start;

  const qualityAfter = measureCurrentQuality(candidates);
  tracker.after(stage.config.id, qualityAfter);
}

// At session end — update stage Q-values:
for (const result of tracker.getResults()) {
  const stage = stages.find(s => s.config.id === result.stageId)!;
  const reward = computeStageReward(result.qualityBefore, result.qualityAfter, result.computeMs);
  stage.update(features, reward);
  saveStage(db, stage, sampleCount + 1, totalReward + reward);
}
```

### Quality measurement function

```typescript
function measureCurrentQuality(candidates: ScoredNote[]): number {
  // Average of top-5 scores as a proxy for result set quality
  const top5 = candidates.slice(0, 5);
  return top5.reduce((s, c) => s + c.score, 0) / (top5.length || 1);
}
```

### Test criteria (Layer 3)

1. All stages start with identity A matrix and zero b vector
2. After MIN_SAMPLES=15 queries, stages can be skipped
3. Expensive stages (cooccurrence_ppr, computeCostMs=50) have higher skip thresholds
4. Essential stages (semantic_search, rrf_fusion) are never skipped
5. Stage that consistently hurts (negative delta) gets UCB < skipThreshold after enough samples
6. Compute cost penalty reduces reward for slow stages
7. Time budget cutoff skips remaining stages when elapsed > 400ms
8. Abstain stops the pipeline entirely when UCB < 0.10
9. LinUCB A matrix accumulates correctly after updates
10. Saved/loaded stage state produces identical UCB scores

---

## Session-End Update Order

All updates happen in `serve.ts` on server close, in this exact order:

```typescript
// 1. Co-occurrence pairs from retrieval log → Layer 2
extractCoOccurrencePairs(db, sessionId);
recomputeAllNPMI(db);
runHomeostasis(db);

// 2. Reward computation → Layer 1
const rewards = rewardAccumulator.computeRewards(db);
batchUpdateQ(db, rewards, sessionId);

// 3. Stage deltas → Layer 3
for (const result of stageTracker.getResults()) {
  const stage = stages.find(s => s.config.id === result.stageId)!;
  const reward = computeStageReward(result.qualityBefore, result.qualityAfter, result.computeMs);
  stage.update(queryFeatures, reward);
  saveStage(db, stage, ...);
}
```

One SQLite transaction wrapping all three.
