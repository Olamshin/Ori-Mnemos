import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInit } from "../../src/cli/init.js";
import { runPromote } from "../../src/cli/promote.js";

let tmpDir: string;

async function writeInboxNote(name: string): Promise<string> {
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
      "A note that should promote regardless of how its target is addressed.",
      "",
    ].join("\n"),
    "utf8",
  );
  return filePath;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ori-promote-target-"));
  await runInit({ targetDir: tmpDir });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("runPromote target resolution", () => {
  // The gateway incident: ori_add returns an absolute path, the agent feeds it
  // straight back to promote, and promote reported "Inbox note not found" for a
  // file that was exactly where add said it was. 16 of 55 promote calls in one
  // profile's history failed this way.
  it("promotes the absolute path ori_add returns", async () => {
    const absolutePath = await writeInboxNote("absolute-target");

    const result = await runPromote({ startDir: tmpDir, noteName: absolutePath });

    expect(result.success).toBe(true);
    expect(result.data.promoted).toHaveLength(1);
    expect(result.data.promoted[0].to).toBe(
      path.join(tmpDir, "notes", "absolute-target.md"),
    );
  });

  it("promotes a vault-relative path", async () => {
    await writeInboxNote("relative-target");

    const result = await runPromote({
      startDir: tmpDir,
      noteName: "inbox/relative-target.md",
    });

    expect(result.success).toBe(true);
    expect(result.data.promoted).toHaveLength(1);
  });

  // The agent's second retry in the incident: the vault root is <profile>/brain,
  // so "brain/inbox/x.md" resolves to <vault>/brain/inbox/x.md — a path that
  // exists nowhere. The filename is still unambiguous.
  it("promotes a path whose directory prefix is wrong for this vault", async () => {
    await writeInboxNote("misprefixed-target");

    const result = await runPromote({
      startDir: tmpDir,
      noteName: "brain/inbox/misprefixed-target.md",
    });

    expect(result.success).toBe(true);
    expect(result.data.promoted).toHaveLength(1);
  });

  it("promotes a Windows-form path", async () => {
    await writeInboxNote("backslash-target");

    const result = await runPromote({
      startDir: tmpDir,
      noteName: "C:\\vault\\inbox\\backslash-target.md",
    });

    expect(result.success).toBe(true);
    expect(result.data.promoted).toHaveLength(1);
  });

  it("still promotes a bare slug, with and without the extension", async () => {
    await writeInboxNote("bare-with-ext");
    await writeInboxNote("bare-without-ext");

    const withExt = await runPromote({
      startDir: tmpDir,
      noteName: "bare-with-ext.md",
    });
    const withoutExt = await runPromote({
      startDir: tmpDir,
      noteName: "bare-without-ext",
    });

    expect(withExt.data.promoted).toHaveLength(1);
    expect(withoutExt.data.promoted).toHaveLength(1);
  });

  it("warns that directory components were ignored, but not for a bare slug", async () => {
    await writeInboxNote("warns-target");
    await writeInboxNote("quiet-target");

    const directoried = await runPromote({
      startDir: tmpDir,
      noteName: "inbox/warns-target.md",
    });
    const bare = await runPromote({ startDir: tmpDir, noteName: "quiet-target" });

    expect(directoried.warnings).toEqual([
      expect.stringContaining("directory components are ignored"),
    ]);
    expect(bare.warnings).toEqual([]);
  });

  // The failure path is where the truncation most needs explaining: the caller
  // is told about a filename they never typed.
  it("still explains the truncation when the lookup fails", async () => {
    const result = await runPromote({
      startDir: tmpDir,
      noteName: "/somewhere/else/inbox/typo-target.md",
    });

    expect(result.success).toBe(false);
    expect(result.warnings).toEqual([
      expect.stringContaining("directory components are ignored"),
      "Inbox note not found: typo-target.md",
    ]);
  });

  it("carries the warning through the require_llm skip path", async () => {
    await writeInboxNote("llm-gated-target");
    const configPath = path.join(tmpDir, "ori.config.yaml");
    const config = await fs.readFile(configPath, "utf8");
    await fs.writeFile(
      configPath,
      config.replace("require_llm: false", "require_llm: true"),
      "utf8",
    );

    const result = await runPromote({
      startDir: tmpDir,
      noteName: "inbox/llm-gated-target.md",
    });

    expect(result.data.promoted).toHaveLength(0);
    expect(result.warnings).toEqual([
      expect.stringContaining("directory components are ignored"),
      "LLM enhancement required but no provider is configured",
    ]);
  });

  it("leaves warnings empty when promoting everything", async () => {
    await writeInboxNote("all-target-one");
    await writeInboxNote("all-target-two");

    const result = await runPromote({ startDir: tmpDir, all: true });

    expect(result.success).toBe(true);
    expect(result.data.promoted).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });

  it("reports a missing note as not found", async () => {
    const result = await runPromote({ startDir: tmpDir, noteName: "no-such-note" });

    expect(result.success).toBe(false);
    expect(result.warnings).toEqual(["Inbox note not found: no-such-note.md"]);
  });

  // "Not found" for an already-promoted note sent callers hunting the
  // filesystem for a file that had simply moved on to notes/.
  it("distinguishes an already-promoted note from a missing one", async () => {
    await writeInboxNote("twice-promoted");
    const first = await runPromote({ startDir: tmpDir, noteName: "twice-promoted" });
    expect(first.data.promoted).toHaveLength(1);

    const second = await runPromote({ startDir: tmpDir, noteName: "twice-promoted" });

    expect(second.success).toBe(false);
    expect(second.warnings).toEqual([
      "Already promoted: twice-promoted.md is in notes/, not inbox/",
    ]);
  });

  it("reports already-promoted when addressed by its notes/ path", async () => {
    await writeInboxNote("promoted-by-notes-path");
    await runPromote({ startDir: tmpDir, noteName: "promoted-by-notes-path" });

    const result = await runPromote({
      startDir: tmpDir,
      noteName: path.join(tmpDir, "notes", "promoted-by-notes-path.md"),
    });

    expect(result.success).toBe(false);
    expect(result.warnings).toEqual([
      expect.stringContaining("directory components are ignored"),
      "Already promoted: promoted-by-notes-path.md is in notes/, not inbox/",
    ]);
  });
});
