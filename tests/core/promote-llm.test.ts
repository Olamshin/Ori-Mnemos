import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInit } from "../../src/cli/init.js";
import { runPromote } from "../../src/cli/promote.js";
import { parseFrontmatter } from "../../src/core/frontmatter.js";

let tmpDir: string;

async function writeInboxNote(name: string, body: string): Promise<void> {
  const filePath = path.join(tmpDir, "inbox", `${name}.md`);
  await fs.writeFile(
    filePath,
    [
      "---",
      'description: ""',
      'type: ""',
      "project: []",
      "status: inbox",
      "created: 2026-05-05",
      "---",
      "",
      `# ${name.replace(/-/g, " ")}`,
      "",
      body,
      "",
    ].join("\n"),
    "utf8",
  );
}

async function setConfig(search: string, replacement: string): Promise<void> {
  const configPath = path.join(tmpDir, "ori.config.yaml");
  const config = await fs.readFile(configPath, "utf8");
  await fs.writeFile(configPath, config.replace(search, replacement), "utf8");
}

async function readPromotedFrontmatter(name: string): Promise<Record<string, unknown>> {
  const content = await fs.readFile(path.join(tmpDir, "notes", `${name}.md`), "utf8");
  return parseFrontmatter(content).data ?? {};
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ori-promote-llm-"));
  await runInit({ targetDir: tmpDir });
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.ORI_TEST_API_KEY;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("runPromote LLM enhancement", () => {
  it("promotes deterministically when LLM is not required and no provider is configured", async () => {
    await writeInboxNote(
      "deterministic-promote",
      "This learned behavior should promote without an LLM provider.",
    );

    const result = await runPromote({ startDir: tmpDir, noteName: "deterministic-promote" });

    expect(result.success).toBe(true);
    expect(result.data.promoted).toHaveLength(1);
    expect(result.data.skipped).toHaveLength(0);
  });

  it("skips promotion when require_llm is true and no provider is configured", async () => {
    await setConfig("require_llm: false", "require_llm: true");
    await writeInboxNote(
      "llm-required",
      "This note should not promote without an LLM provider.",
    );

    const result = await runPromote({ startDir: tmpDir, noteName: "llm-required" });

    expect(result.success).toBe(true);
    expect(result.data.promoted).toHaveLength(0);
    expect(result.data.skipped).toEqual([
      {
        path: path.join(tmpDir, "inbox", "llm-required.md"),
        reason: "LLM enhancement required but no provider is configured",
      },
    ]);
  });

  it("uses LLM type, description, and project suggestions when user overrides are absent", async () => {
    process.env.ORI_TEST_API_KEY = "test-key";
    await setConfig("provider: null", "provider: openai");
    await setConfig("api_key_env: null", "api_key_env: ORI_TEST_API_KEY");
    await writeInboxNote(
      "llm-enhanced-note",
      "We decided to change the memory boundary so agents can call from project folders.",
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              type: "decision",
              description: "Vault-relative paths keep agent harnesses independent of vault layout",
              project: ["cli"],
              reasoning: "The note records an implementation decision.",
            }),
          },
        }],
      }),
    } as Response);

    const result = await runPromote({ startDir: tmpDir, noteName: "llm-enhanced-note" });
    const frontmatter = await readPromotedFrontmatter("llm-enhanced-note");

    expect(result.success).toBe(true);
    expect(result.data.promoted).toHaveLength(1);
    expect(frontmatter.type).toBe("decision");
    expect(frontmatter.description).toBe(
      "Vault-relative paths keep agent harnesses independent of vault layout",
    );
    expect(frontmatter.project).toEqual(["cli"]);
  });

  it("keeps user overrides above LLM suggestions", async () => {
    process.env.ORI_TEST_API_KEY = "test-key";
    await setConfig("provider: null", "provider: openai");
    await setConfig("api_key_env: null", "api_key_env: ORI_TEST_API_KEY");
    await writeInboxNote(
      "override-priority-note",
      "The model may suggest fields, but explicit caller choices should win.",
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              type: "learning",
              description: "LLM description should not win",
              project: ["llm-project"],
            }),
          },
        }],
      }),
    } as Response);

    const result = await runPromote({
      startDir: tmpDir,
      noteName: "override-priority-note",
      type: "decision",
      description: "Manual description should win",
      project: ["manual-project"],
    });
    const frontmatter = await readPromotedFrontmatter("override-priority-note");

    expect(result.success).toBe(true);
    expect(frontmatter.type).toBe("decision");
    expect(frontmatter.description).toBe("Manual description should win");
    expect(frontmatter.project).toEqual(["manual-project"]);
  });
});
