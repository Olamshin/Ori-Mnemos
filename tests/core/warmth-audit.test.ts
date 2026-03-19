import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  isWarmthAuditEnabled,
  loadWarmthAudit,
  logWarmthAudit,
  queryWarmthAudit,
} from "../../src/core/warmth-audit.js";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ori-warmth-audit-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  delete process.env.ORI_WARMTH_AUDIT;
  delete process.env.ORI_WARMTH_AUDIT_PATH;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("warmth audit", () => {
  it("is opt-in via env var", () => {
    expect(isWarmthAuditEnabled()).toBe(false);
    process.env.ORI_WARMTH_AUDIT = "1";
    expect(isWarmthAuditEnabled()).toBe(true);
    process.env.ORI_WARMTH_AUDIT = "false";
    expect(isWarmthAuditEnabled()).toBe(false);
  });

  it("writes, loads, and filters local warmth audit events", async () => {
    const vaultRoot = await makeTempDir();

    await logWarmthAudit(vaultRoot, {
      timestamp: "2026-03-09T01:00:00.000Z",
      query: "token incentives",
      intent: "semantic",
      limit: 5,
      effectiveWarmthWeight: 0.2,
      withWarmth: [
        {
          title: "token incentives",
          finalRank: 1,
          baseRank: 3,
          finalScore: 0.6,
          baseScore: 0.5,
          warmthScore: 0.8,
          movement: 2,
        },
      ],
      withoutWarmth: [
        {
          title: "token incentives",
          finalRank: 1,
          baseRank: 3,
          finalScore: 0.6,
          baseScore: 0.5,
          warmthScore: 0.8,
          movement: 2,
        },
      ],
      promoted: [
        {
          title: "token incentives",
          finalRank: 1,
          baseRank: 3,
          finalScore: 0.6,
          baseScore: 0.5,
          warmthScore: 0.8,
          movement: 2,
        },
      ],
      demoted: [],
    });

    await logWarmthAudit(vaultRoot, {
      timestamp: "2026-03-09T02:00:00.000Z",
      query: "courtshare tokenomics",
      intent: "semantic",
      limit: 5,
      effectiveWarmthWeight: 0.2,
      withWarmth: [],
      withoutWarmth: [],
      promoted: [],
      demoted: [],
    });

    const all = await loadWarmthAudit(vaultRoot);
    expect(all).toHaveLength(2);

    const filtered = await queryWarmthAudit(vaultRoot, {
      query: "courtshare",
      limit: 10,
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.query).toBe("courtshare tokenomics");

    const recent = await queryWarmthAudit(vaultRoot, { limit: 1 });
    expect(recent).toHaveLength(1);
    expect(recent[0]?.query).toBe("courtshare tokenomics");
  });
});
