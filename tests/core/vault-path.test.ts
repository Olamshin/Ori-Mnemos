import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInit } from "../../src/cli/init.js";
import { runValidate } from "../../src/cli/validate.js";
import { resolveVaultPath } from "../../src/core/vault.js";

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
