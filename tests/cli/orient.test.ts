import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runInit } from "../../src/cli/init.js";
import { runOrient } from "../../src/cli/orient.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ori-orient-test-"));
  await runInit({ targetDir: tmpDir });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("runOrient", () => {
  it("returns the session briefing payload for a vault", async () => {
    const result = await runOrient(tmpDir, { vault: tmpDir });
    expect(result.success).toBe(true);
    // Core briefing fields the session-start hook depends on.
    expect(result.data).toHaveProperty("daily");
    expect(result.data).toHaveProperty("reminders");
    expect(result.data).toHaveProperty("goals");
    expect(result.data).toHaveProperty("vaultStatus");
    expect(result.data).toHaveProperty("firstRun");
    expect(result.data).toHaveProperty("timestamp");
  });

  it("surfaces ops/ files the agent should see at session start", async () => {
    await fs.writeFile(
      path.join(tmpDir, "ops", "daily.md"),
      "# Today\n- ship the orient hook\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "ops", "reminders.md"),
      "# Reminders\n- reuse ori_add's returned path\n",
      "utf8",
    );

    const result = await runOrient(tmpDir, { vault: tmpDir });
    expect(result.data.daily).toContain("ship the orient hook");
    expect(result.data.reminders).toContain("reuse ori_add's returned path");
  });

  it("brief mode omits identity/methodology; --full includes them", async () => {
    const brief = await runOrient(tmpDir, { vault: tmpDir, brief: true });
    expect(brief.data).not.toHaveProperty("identity");
    expect(brief.data).not.toHaveProperty("methodology");

    const full = await runOrient(tmpDir, { vault: tmpDir, brief: false });
    expect(full.data).toHaveProperty("identity");
    expect(full.data).toHaveProperty("methodology");
    expect(full.data).toHaveProperty("goals");
  });
});
