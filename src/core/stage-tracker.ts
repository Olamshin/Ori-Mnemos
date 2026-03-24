/**
 * Quality snapshot tracker for stage meta-learning.
 * Records quality before/after each stage execution and compute time.
 */

export interface StageSnapshot {
  stageId: string;
  qualityBefore: number;
  startTime: number;
}

export interface StageResult {
  stageId: string;
  qualityBefore: number;
  qualityAfter: number;
  computeMs: number;
}

export class StageTracker {
  private snapshots: Map<string, StageSnapshot> = new Map();
  private results: StageResult[] = [];

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

  getResults(): StageResult[] {
    return this.results;
  }

  hasResults(): boolean {
    return this.results.length > 0;
  }

  /** Drain results for per-query processing and reset for the next query. */
  drain(): StageResult[] {
    const drained = this.results;
    this.results = [];
    return drained;
  }
}

/**
 * Measure current quality of a candidate set.
 * Average of top-5 scores as a proxy for result set quality.
 */
export function measureCurrentQuality(
  candidates: { score: number }[],
): number {
  const top5 = candidates.slice(0, 5);
  return top5.reduce((s, c) => s + c.score, 0) / (top5.length || 1);
}
