/**
 * Session reward accumulator and credit assignment.
 * Tracks retrievals, adds, and updates within a session,
 * then computes per-note rewards at session end.
 *
 * Reward signals (in priority order):
 *   forward citation +1.0 | update +0.5 | downstream creation +0.6
 *   within-session re-recall +0.4 | partial follow-up +0.1 | dead end -0.15
 *
 * All rewards are exposure-corrected: reward / exposure_count^0.5
 */

import type Database from "better-sqlite3";
import { getExposureCount } from "./qvalue.js";

const EXPOSURE_BETA = 0.5;

export interface RetrievalEvent {
  noteId: string;
  rank: number;
  queryText: string;
  queryType: string;
}

export interface SessionOutcome {
  forwardCitations: string[];
  updatedNotes: string[];
  createdNotes: string[];
  reRecalledNotes: string[];
}

export class SessionRewardAccumulator {
  private retrievals: RetrievalEvent[] = [];
  private addedContent: string[] = [];
  private updatedNoteIds: string[] = [];
  private createdNoteIds: string[] = [];
  readonly sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  logRetrieval(
    noteId: string,
    rank: number,
    queryText: string,
    queryType: string,
  ): void {
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
    const seen = new Map<string, number[]>();

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
        reward = 1.0; // full reward
      } else if (outcome.updatedNotes.includes(noteId)) {
        reward = 0.5;
      } else if (outcome.createdNotes.length > 0) {
        reward = 0.6 * (1 / Math.log2(bestRank + 2)); // downstream creation, position-weighted
      } else if (ranks.length > 1) {
        reward = 0.4 * (1 / ranks.length); // within-session re-recall, diminishing
      } else if (
        outcome.forwardCitations.length > 0 ||
        outcome.updatedNotes.length > 0
      ) {
        reward = 0.1 / Math.log2(bestRank + 2); // some follow-up happened, position-weighted
      } else {
        reward =
          bestRank <= 2
            ? -0.15 / Math.pow(bestRank + 1, 1.0) // IPS-debiased dead end (top-3 only)
            : 0; // low-ranked, not examined, no penalty
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
    const retrievedIds = new Set(this.retrievals.map((r) => r.noteId));
    const forwardCitations: string[] = [];

    for (const content of this.addedContent) {
      const links = content.match(/\[\[([^\]]+)\]\]/g) ?? [];
      for (const link of links) {
        const title = link.slice(2, -2);
        if (retrievedIds.has(title)) {
          forwardCitations.push(title);
        }
      }
    }

    return {
      forwardCitations: [...new Set(forwardCitations)],
      updatedNotes: [...new Set(this.updatedNoteIds)],
      createdNotes: [...new Set(this.createdNoteIds)],
      reRecalledNotes: [],
    };
  }

  hasData(): boolean {
    return this.retrievals.length > 0;
  }
}
