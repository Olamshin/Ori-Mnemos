import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildWakePayload } from "../../src/core/wake.js";
import { assembleWakeInputs, loadWakeSources } from "../../src/core/wake-sources.js";
import { loadConfig } from "../../src/core/config.js";

/**
 * Regression tests for `ori wake` against REAL vault files, which are written
 * with YAML frontmatter. Without stripping it, the briefing degenerates to a
 * list of `---` delimiters: `---` is the first non-heading line of identity.md
 * (so it becomes the identity line) and it also passes the "starts with -"
 * goal-bullet test.
 *
 * Observed on the live tayo vault before the fix:
 *   lines: ["---", "---", "---", "Notes: 66", "Inbox: 1"]
 */

const FRONTMATTER_IDENTITY = `---
description: Agent identity
type: self
---

# Identity

## Who I Am

- I am Tayo, Olamide's virtual assistant.
`;

const FRONTMATTER_GOALS = `---
description: Active threads
type: self
---

# Goals

## Active Threads

- Ship the gateway migration
`;

function inputs(overrides: Record<string, unknown> = {}) {
  return {
    identity: FRONTMATTER_IDENTITY,
    goals: FRONTMATTER_GOALS,
    reminders: "",
    daily: "",
    warmNotes: [],
    vaultStats: { noteCount: 66, inboxCount: 1 },
    notices: [],
    ...overrides,
  };
}

describe("wake: frontmatter never becomes briefing content", () => {
  it("no output line is a bare frontmatter delimiter", () => {
    const out = buildWakePayload(inputs() as never, 96);
    expect(out.lines).not.toContain("---");
    expect(out.lines.some((l) => /^(-{3,}|\*{3,}|_{3,})$/.test(l.trim()))).toBe(false);
  });

  it("identity line is the first real content line, not the delimiter", () => {
    const out = buildWakePayload(inputs() as never, 96);
    expect(out.lines[0]).toContain("Tayo");
  });

  it("goals count only real bullets — a `---` rule is not a goal", () => {
    const out = buildWakePayload(inputs() as never, 96);
    expect(out.sections["active_goals"]).toBe(1);
    expect(out.lines).toContain("- Ship the gateway migration");
  });

  it("a goals file with only headers yields zero goals, not two delimiters", () => {
    const empty = `---\ndescription: x\ntype: self\n---\n\n# Goals\n\n## Active Threads\n\n## Completed\n`;
    const out = buildWakePayload(inputs({ goals: empty }) as never, 96);
    expect(out.sections["active_goals"]).toBe(0);
  });
});

describe("wake: reminders", () => {
  const reminders = "---\ntype: ops\n---\n\n# Reminders\n\n- [ ] 2026-08-09: ship the thing\n- [ ] call the bank\n";

  it("keyword fallback drops undated lines when the caller has NOT pre-filtered", () => {
    const out = buildWakePayload(inputs({ reminders }) as never, 96);
    expect(out.lines).not.toContain("- [ ] call the bank");
  });

  it("remindersPreFiltered keeps caller-selected lines that lack the word 'due'", () => {
    const out = buildWakePayload(
      inputs({ reminders, remindersPreFiltered: true }) as never,
      96,
    );
    expect(out.lines).toContain("- [ ] call the bank");
    expect(out.sections["reminders_due"]).toBe(2);
  });

  it("frontmatter delimiters are never counted as reminders", () => {
    const out = buildWakePayload(
      inputs({ reminders, remindersPreFiltered: true }) as never,
      96,
    );
    expect(out.lines).not.toContain("---");
  });
});

describe("wake-sources: activity modes", () => {
  let vault: string;

  beforeEach(async () => {
    vault = await fs.mkdtemp(path.join(os.tmpdir(), "ori-wake-src-"));
    await fs.mkdir(path.join(vault, "ops"), { recursive: true });
    await fs.writeFile(
      path.join(vault, "ops", "daily.md"),
      "---\ndate: 2026-07-20\n---\n\n# Daily State\n\n## Completed Today\n\n- [x] first\n- [x] second\n\n## Notes\n\n- trailing note\n",
      "utf8",
    );
  });

  afterEach(async () => {
    await fs.rm(vault, { recursive: true, force: true });
  });

  it("head mode takes the TOP of a single-day state file, frontmatter stripped", async () => {
    const out = await assembleWakeInputs(vault, [
      { path: "ops/daily.md", role: "activity", cap: 4, mode: "head" },
    ]);
    expect(out.activity).toEqual(["# Daily State", "## Completed Today", "- [x] first", "- [x] second"]);
    expect(out.activity.some((l) => l.startsWith("---") || l.startsWith("date:"))).toBe(false);
  });

  it("tail mode still takes the END of the file", async () => {
    const out = await assembleWakeInputs(vault, [
      { path: "ops/daily.md", role: "activity", cap: 2, mode: "tail" },
    ]);
    expect(out.activity).toEqual(["## Notes", "- trailing note"]);
  });
});

describe("wake.sources survives config load (was silently dropped)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ori-wake-cfg-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const write = (body: string) =>
    fs.writeFile(path.join(dir, "ori.config.yaml"), `vault:\n  version: "1"\n${body}`, "utf8");

  it("a user manifest reaches loadWakeSources instead of the scaffold defaults", async () => {
    await write(
      "wake:\n  sources:\n" +
        '    - path: "ops/daily.md"\n      role: "activity"\n      cap: 12\n      mode: "head"\n',
    );
    const cfg = await loadConfig(path.join(dir, "ori.config.yaml"));
    const sources = loadWakeSources(cfg as never);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toEqual({ path: "ops/daily.md", role: "activity", cap: 12, mode: "head" });
  });

  it("no wake block still yields the scaffold defaults", async () => {
    await write("");
    const cfg = await loadConfig(path.join(dir, "ori.config.yaml"));
    expect(loadWakeSources(cfg as never).map((s) => s.path)).toContain("self/identity.md");
  });

  it("a typo'd role is rejected loudly rather than yielding a short briefing", async () => {
    await write(
      "wake:\n  sources:\n" +
        '    - path: "ops/daily.md"\n      role: "activty"\n      cap: 12\n      mode: "head"\n',
    );
    await expect(loadConfig(path.join(dir, "ori.config.yaml"))).rejects.toThrow(/wake\.sources\[0\]\.role/);
  });
});
