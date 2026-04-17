/**
 * Single source of truth for the package version.
 * Reads from package.json at runtime so it never drifts.
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

let _version: string | null = null;

export function getVersion(): string {
  if (_version) return _version;
  try {
    // Walk up from dist/core/version.js to find package.json
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as { version: string };
    _version = pkg.version;
  } catch {
    _version = "0.0.0";
  }
  return _version;
}
