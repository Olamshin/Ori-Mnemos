/**
 * Q-value storage, update, decay, and exploration bonus.
 * Layer 1 of retrieval intelligence — learns which notes are useful
 * via exponential moving average Q-updates with UCB-Tuned exploration.
 *
 * Research: MemRL, Drift, Tempera, bandit theory (63-source synthesis)
 */

import type Database from "better-sqlite3";

// Constants
const ALPHA = 0.1;
const DEFAULT_Q = 0.5;
const DECAY_RATE = 0.007; // half-life ~99 days
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
  const row = db
    .prepare("SELECT q_value FROM note_q WHERE note_id = ?")
    .get(noteId) as { q_value: number } | undefined;
  return row?.q_value ?? DEFAULT_Q;
}

export function getDecayedQ(db: Database.Database, noteId: string): number {
  const row = db
    .prepare("SELECT q_value, last_updated FROM note_q WHERE note_id = ?")
    .get(noteId) as { q_value: number; last_updated: string } | undefined;

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
  noteId: string,
): { mean: number; variance: number; count: number } {
  const row = db
    .prepare(
      "SELECT update_count, reward_sum, reward_sq_sum FROM note_q WHERE note_id = ?",
    )
    .get(noteId) as
    | { update_count: number; reward_sum: number; reward_sq_sum: number }
    | undefined;

  if (!row || row.update_count === 0)
    return { mean: 0, variance: 0.25, count: 0 };

  const mean = row.reward_sum / row.update_count;
  const variance = row.reward_sq_sum / row.update_count - mean * mean;
  return { mean, variance: Math.max(0, variance), count: row.update_count };
}

export function getExposureCount(
  db: Database.Database,
  noteId: string,
): number {
  const row = db
    .prepare("SELECT exposure_count FROM note_q WHERE note_id = ?")
    .get(noteId) as { exposure_count: number } | undefined;
  return row?.exposure_count ?? 0;
}

export function getTotalQUpdates(db: Database.Database): number {
  const row = db
    .prepare("SELECT COALESCE(SUM(update_count), 0) as total FROM note_q")
    .get() as { total: number };
  return row.total;
}

export function getTotalQueryCount(db: Database.Database): number {
  const row = db
    .prepare(
      "SELECT COUNT(DISTINCT session_id || '|' || query_text) as total FROM retrieval_log",
    )
    .get() as { total: number };
  return row.total;
}

// --- Write ---

export function updateQ(
  db: Database.Database,
  noteId: string,
  reward: number,
  sessionId: string,
): void {
  const oldQ = getQ(db, noteId);
  const newQ = oldQ + ALPHA * (reward - oldQ);

  db.prepare(
    `
    INSERT INTO note_q (note_id, q_value, update_count, reward_sum, reward_sq_sum, last_updated, last_reward)
    VALUES (?, ?, 1, ?, ?, datetime('now'), ?)
    ON CONFLICT(note_id) DO UPDATE SET
      q_value = ?,
      update_count = update_count + 1,
      reward_sum = reward_sum + ?,
      reward_sq_sum = reward_sq_sum + ?,
      last_updated = datetime('now'),
      last_reward = ?
  `,
  ).run(
    noteId,
    newQ,
    reward,
    reward * reward,
    reward,
    newQ,
    reward,
    reward * reward,
    reward,
  );

  db.prepare(
    `
    INSERT INTO q_history (note_id, old_q, new_q, reward, reward_source, session_id)
    VALUES (?, ?, ?, ?, 'session_batch', ?)
  `,
  ).run(noteId, oldQ, newQ, reward, sessionId);
}

export function incrementExposure(
  db: Database.Database,
  noteId: string,
): void {
  db.prepare(
    `
    INSERT INTO note_q (note_id, exposure_count)
    VALUES (?, 1)
    ON CONFLICT(note_id) DO UPDATE SET exposure_count = exposure_count + 1
  `,
  ).run(noteId);
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
  finalScore: number,
): void {
  db.prepare(
    `
    INSERT INTO retrieval_log
      (session_id, query_text, query_type, note_id, rank,
       similarity_score, q_score, ucb_bonus, final_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    sessionId,
    queryText,
    queryType,
    noteId,
    rank,
    simScore,
    qScore,
    ucbBonus,
    finalScore,
  );
}

// --- Exploration: UCB-Tuned ---

export function explorationBonus(
  stats: { mean: number; variance: number; count: number },
  totalQueries: number,
  c: number = 0.2,
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
  sessionId: string,
): void {
  const tx = db.transaction(() => {
    for (const [noteId, reward] of rewards) {
      updateQ(db, noteId, reward, sessionId);
    }
  });
  tx();
}

// Re-export constants for tests
export { ALPHA, DEFAULT_Q, DECAY_RATE, EXPOSURE_BETA };
