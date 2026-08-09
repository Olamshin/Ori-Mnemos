import { promises as fs, type Dirent } from "node:fs";
import { findVaultRoot, getVaultPaths, listNoteTitles } from "../core/vault.js";
import { buildGraph, findOrphans, type LinkGraph } from "../core/graph.js";

export type StatusResult = {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
};

export async function runStatus(
  startDir: string,
  linkGraph?: LinkGraph,
): Promise<StatusResult> {
  const vaultRoot = await findVaultRoot(startDir);
  const paths = getVaultPaths(vaultRoot);

  const allNotes = await listNoteTitles(paths.notes);
  const graph = linkGraph ?? await buildGraph(paths.notes);
  const orphans = findOrphans(graph, allNotes);

  let inboxEntries: Dirent[];
  try {
    inboxEntries = await fs.readdir(paths.inbox, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      inboxEntries = [];
    } else {
      throw err;
    }
  }
  // Notes only. Counting every file makes the scaffold's own `.gitkeep` read as
  // a note pending promotion, so a freshly-initialised vault always claims
  // "1 in inbox" (wake's countMd already had this right).
  const inboxCount = inboxEntries.filter(
    (e) => e.isFile() && e.name.endsWith(".md"),
  ).length;

  return {
    success: true,
    data: {
      vaultRoot,
      noteCount: allNotes.length,
      inboxCount,
      orphanCount: orphans.length,
    },
    warnings: [],
  };
}
