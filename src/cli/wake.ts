/**
 * ori wake — bounded session boot runner (manifest -> engine).
 */
import { findVaultRoot, getVaultPaths } from "../core/vault.js";
import { loadConfig } from "../core/config.js";
import { loadWakeSources, assembleWakeInputs } from "../core/wake-sources.js";
import { buildWakePayload } from "../core/wake.js";
import { parseTemporal, classifyReminder } from "../core/temporal.js";

export async function runWake(startDir: string, budgetLines: number): Promise<{
  success: boolean;
  lines: string[];
  sections: Record<string, number>;
}> {
  const vaultRoot = await findVaultRoot(startDir);
  const config = await loadConfig(getVaultPaths(vaultRoot).config);
  const sources = loadWakeSources(config as never);
  const inputs = await assembleWakeInputs(vaultRoot, sources);

  const today = new Date().toISOString().slice(0, 10);

  // Mechanical temporal filter (design v2): only due/upcoming reminders survive.
  // Words like "today" are never trusted — only ISO dates. Undated lines stay
  // (classifyReminder returns "note") so plain reminders are not lost.
  const reminderLines = inputs.reminders
    .split("\n")
    .filter((l) => l.trim().startsWith("-"))
    // `---` passes the bullet test above; it is frontmatter, not a reminder.
    .filter((l) => !/^(-{3,}|\*{3,}|_{3,})$/.test(l.trim()))
    .filter((l) => {
      const t = parseTemporal(l, null);
      const cls = classifyReminder(t, today);
      if (cls === "due" || cls === "upcoming") return true;
      if (cls !== "note") return false; // expired never surfaces
      // Undated notes: keep only if captured recently (30d) or capture date unknown.
      if (t.capturedAt === null) return true;
      const ageDays = (Date.parse(today) - Date.parse(t.capturedAt)) / 86400000;
      return ageDays <= 30;
    });
  const wakeInputs = {
    ...inputs,
    reminders: reminderLines.join("\n"),
    // Already reduced to due/upcoming above — tell the engine not to re-apply
    // its keyword fallback, which would drop every due line lacking the literal
    // word "due"/"today" and silently undo the mechanical grammar.
    remindersPreFiltered: true,
    // ONE entry holding today's activity, not one entry per line. Per-line
    // entries make coverDaily see N same-day entries, so everything past the
    // fovea window gets rewritten as "<today>: <line>" — stamping today's date
    // onto lines that came out of a file written days ago.
    daily: inputs.activity.length ? [{ date: today, lines: inputs.activity }] : []
  };

  const out = buildWakePayload(wakeInputs, budgetLines);
  return { success: true, lines: out.lines, sections: out.sections };
}
