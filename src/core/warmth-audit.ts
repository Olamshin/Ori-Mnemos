import { promises as fs } from "node:fs";
import path from "node:path";

export const DEFAULT_WARMTH_AUDIT_PATH = ".ori/warmth-audit.jsonl";

export type WarmthAuditEntry = {
  title: string;
  finalRank: number | null;
  baseRank: number | null;
  finalScore: number;
  baseScore: number;
  warmthScore: number;
  movement: number;
};

export type WarmthAuditEvent = {
  timestamp: string;
  query: string;
  intent?: string;
  limit: number;
  effectiveWarmthWeight: number;
  withWarmth: WarmthAuditEntry[];
  withoutWarmth: WarmthAuditEntry[];
  promoted: WarmthAuditEntry[];
  demoted: WarmthAuditEntry[];
};

export function isWarmthAuditEnabled(): boolean {
  const value = process.env.ORI_WARMTH_AUDIT;
  if (!value) return false;
  return value !== "0" && value.toLowerCase() !== "false";
}

function getWarmthAuditPath(vaultRoot: string): string {
  const override = process.env.ORI_WARMTH_AUDIT_PATH;
  return path.resolve(vaultRoot, override && override.trim() ? override : DEFAULT_WARMTH_AUDIT_PATH);
}

export async function logWarmthAudit(
  vaultRoot: string,
  event: WarmthAuditEvent,
): Promise<void> {
  const logPath = getWarmthAuditPath(vaultRoot);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, JSON.stringify(event) + "\n", "utf8");
}

export async function loadWarmthAudit(
  vaultRoot: string,
): Promise<WarmthAuditEvent[]> {
  const logPath = getWarmthAuditPath(vaultRoot);
  let raw: string;
  try {
    raw = await fs.readFile(logPath, "utf8");
  } catch {
    return [];
  }

  const events: WarmthAuditEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as WarmthAuditEvent);
    } catch {
      // Ignore malformed local audit lines.
    }
  }
  return events;
}

export async function queryWarmthAudit(
  vaultRoot: string,
  options?: { query?: string; limit?: number },
): Promise<WarmthAuditEvent[]> {
  const events = await loadWarmthAudit(vaultRoot);
  const needle = options?.query?.trim().toLowerCase();
  const filtered = needle
    ? events.filter((event) => event.query.toLowerCase().includes(needle))
    : events;
  const limit = options?.limit ?? 10;
  return filtered.slice(-limit).reverse();
}
