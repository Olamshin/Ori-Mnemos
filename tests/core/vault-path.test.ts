import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInit } from "../../src/cli/init.js";
import { runValidate } from "../../src/cli/validate.js";
import { getVaultPaths, resolveNotePath, resolveVaultPath } from "../../src/core/vault.js";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("vault-relative paths", () => {
  it("resolves relative paths against the vault root", () => {
    const vaultRoot = path.resolve("tmp-vault");
    expect(resolveVaultPath(vaultRoot, "notes/example.md")).toBe(
      path.resolve(vaultRoot, "notes/example.md"),
    );
  });

  it("preserves absolute paths", () => {
    const absolutePath = path.resolve("elsewhere", "example.md");
    expect(resolveVaultPath(path.resolve("tmp-vault"), absolutePath)).toBe(absolutePath);
  });

  it("validates vault-relative note paths when the caller is outside the vault", async () => {
    const vaultDir = await makeTempDir("ori-validate-vault-");
    const projectDir = await makeTempDir("ori-validate-project-");
    const originalCwd = process.cwd();

    try {
      await runInit({ targetDir: vaultDir });
      process.chdir(projectDir);
      const notePath = path.join(vaultDir, "notes", "vault-relative-validation.md");
      await fs.writeFile(
        notePath,
        [
          "---",
          "description: Validates vault-relative path handling",
          "type: insight",
          "project:",
          "  - cli",
          "status: active",
          "created: 2026-05-05",
          "---",
          "",
          "# Vault relative validation works",
          "",
          "Relative paths should resolve inside the vault even when the caller is elsewhere.",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runValidate({
        startDir: vaultDir,
        notePath: "notes/vault-relative-validation.md",
      });

      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
    } finally {
      process.chdir(originalCwd);
      await fs.rm(vaultDir, { recursive: true, force: true });
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });
});

describe("bare-slug note resolution", () => {
  it("passes absolute and directoried paths through unchanged", async () => {
    const vaultRoot = path.resolve("tmp-vault");
    const absolutePath = path.resolve("elsewhere", "example.md");
    expect(await resolveNotePath(vaultRoot, absolutePath)).toBe(absolutePath);
    expect(await resolveNotePath(vaultRoot, "notes/example.md")).toBe(
      path.resolve(vaultRoot, "notes/example.md"),
    );
  });

  it("finds a bare filename in inbox/ then notes/, inbox winning ties", async () => {
    const vaultDir = await makeTempDir("ori-bareslug-vault-");
    try {
      await runInit({ targetDir: vaultDir });
      const inboxPaths = getVaultPaths(vaultDir);
      await fs.writeFile(path.join(inboxPaths.notes, "only-in-notes.md"), "# x\n", "utf8");
      await fs.writeFile(path.join(inboxPaths.inbox, "in-both.md"), "# x\n", "utf8");
      await fs.writeFile(path.join(inboxPaths.notes, "in-both.md"), "# x\n", "utf8");

      // bare name, with and without the .md extension, resolves to notes/
      expect(await resolveNotePath(vaultDir, "only-in-notes.md")).toBe(
        path.join(inboxPaths.notes, "only-in-notes.md"),
      );
      expect(await resolveNotePath(vaultDir, "only-in-notes")).toBe(
        path.join(inboxPaths.notes, "only-in-notes.md"),
      );
      // inbox/ takes precedence when a note exists in both stages
      expect(await resolveNotePath(vaultDir, "in-both.md")).toBe(
        path.join(inboxPaths.inbox, "in-both.md"),
      );
    } finally {
      await fs.rm(vaultDir, { recursive: true, force: true });
    }
  });

  it("validates a bare slug living in notes/ when the caller is outside the vault", async () => {
    // Reproduces the gateway incident: a bare slugified title is passed to
    // validate while the process cwd is the profile dir, not the vault.
    const vaultDir = await makeTempDir("ori-bareslug-validate-");
    const projectDir = await makeTempDir("ori-bareslug-project-");
    const originalCwd = process.cwd();
    try {
      await runInit({ targetDir: vaultDir });
      process.chdir(projectDir);
      await fs.writeFile(
        path.join(vaultDir, "notes", "vikunja-gtd-workflow-conventions.md"),
        [
          "---",
          "description: Conventions for the Vikunja GTD workflow",
          "type: insight",
          "project:",
          "  - cli",
          "status: active",
          "created: 2026-05-05",
          "---",
          "",
          "# Vikunja GTD workflow conventions",
          "",
          "A bare slug should resolve even when the caller is elsewhere.",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runValidate({
        startDir: vaultDir,
        notePath: "vikunja-gtd-workflow-conventions.md",
      });

      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
    } finally {
      process.chdir(originalCwd);
      await fs.rm(vaultDir, { recursive: true, force: true });
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });
});
