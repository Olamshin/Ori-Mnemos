#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function findVaultRoot(startDir) {
  const explicit = process.env.ORI_VAULT;
  if (explicit && existsSync(path.join(explicit, ".ori"))) {
    return explicit;
  }

  let current = path.resolve(startDir);
  while (true) {
    if (existsSync(path.join(current, ".ori"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function parseHookInput() {
  let raw = "";
  if (!process.stdin.isTTY) {
    try {
      raw = readFileSync(0, "utf8");
    } catch {
      // stdin may be empty
    }
  }
  if (!raw) {
    raw = process.env.HOOK_INPUT ?? "";
  }
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

const input = parseHookInput();
const filePath =
  typeof input?.tool_input?.file_path === "string"
    ? input.tool_input.file_path
    : typeof input?.tool_input?.path === "string"
      ? input.tool_input.path
      : typeof input?.file_path === "string"
        ? input.file_path
        : "";

if (!filePath) {
  process.exit(0);
}
const vaultRoot = findVaultRoot(process.cwd());
if (!vaultRoot) {
  process.exit(0);
}

const normalizedVault = path.resolve(vaultRoot).toLowerCase() + path.sep;
const normalizedFile = path.resolve(filePath).toLowerCase();
if (!normalizedFile.startsWith(normalizedVault)) {
  process.exit(0);
}

const result = spawnSync("ori", ["validate", filePath], { stdio: "inherit", shell: true });
if (result.error) process.exit(0);
process.exit(result.status ?? 0);
