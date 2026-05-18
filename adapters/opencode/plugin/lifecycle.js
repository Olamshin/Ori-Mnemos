/**
 * Ori Mnemos — OpenCode Lifecycle Plugin
 *
 * Provides session lifecycle hooks for Ori vault integration:
 * - session.created → auto-orient (session briefing)
 * - session.idle → auto-capture (session insights)
 * - tool.execute.after (write) → auto-validate (note schema validation)
 *
 * Resolves vault path from opencode.json MCP config, so it works with
 * any named MCP entry (ori, coder-memory, research-memory, etc.).
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const VAULT_NOTE_PATHS = ["notes/", "inbox/", "self/", "ops/"];

function isVaultNote(filePath) {
  if (!filePath) return false;
  return VAULT_NOTE_PATHS.some((p) => filePath.includes(p));
}

function getVaultPath(directory) {
  // Try environment variable first (set by MCP server launch)
  if (process.env.ORI_VAULT) return process.env.ORI_VAULT;

  // Fall back to reading opencode.json from the project directory
  try {
    const configPath = path.join(directory, "opencode.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const mcp = config.mcp?.ori;
    if (!mcp) return null;

    // Extract vault from command args
    const cmd = mcp.command;
    if (Array.isArray(cmd)) {
      const vaultIndex = cmd.indexOf("--vault");
      if (vaultIndex >= 0 && cmd[vaultIndex + 1]) {
        return cmd[vaultIndex + 1];
      }
    }

    // Or from environment in config
    if (mcp.environment?.ORI_VAULT) {
      return mcp.environment.ORI_VAULT;
    }
  } catch {
    // opencode.json not found or unparseable
  }

  return null;
}

export const OriLifecyclePlugin = async ({ $, client, directory }) => {
  const vault = getVaultPath(directory);
  const vaultFlag = vault ? ["--vault", vault] : [];

  if (!vault) {
    await client.app.log({
      body: {
        service: "ori",
        level: "error",
        message: "No vault path found. Check opencode.json MCP config for 'ori' server with --vault flag.",
        extra: { directory },
      },
    });
    return {
      event: async () => {},
      "tool.execute.after": async () => {},
    };
  }

  await client.app.log({
    body: {
      service: "ori",
      level: "info",
      message: `Lifecycle plugin initialized with vault: ${vault}`,
    },
  });

  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        try {
          await client.app.log({
            body: {
              service: "ori",
              level: "info",
              message: "Running ori orient...",
            },
          });
          const result = await $`ori orient ${vaultFlag}`;
          await client.app.log({
            body: {
              service: "ori",
              level: "info",
              message: "Session oriented successfully",
              extra: { vault },
            },
          });
        } catch (err) {
          await client.app.log({
            body: {
              service: "ori",
              level: "warn",
              message: `Orient failed: ${err.message}`,
              extra: { vault },
            },
          });
        }
      }

      if (event.type === "session.idle") {
        try {
          const timestamp = new Date().toISOString().slice(0, 10);
          await client.app.log({
            body: {
              service: "ori",
              level: "info",
              message: `Running session capture for ${timestamp}...`,
            },
          });
          await $`ori add "Session capture ${timestamp}" --type insight ${vaultFlag}`;
          await client.app.log({
            body: {
              service: "ori",
              level: "info",
              message: "Session captured successfully",
              extra: { vault },
            },
          });
        } catch (err) {
          await client.app.log({
            body: {
              service: "ori",
              level: "warn",
              message: `Capture failed: ${err.message}`,
              extra: { vault },
            },
          });
        }
      }
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "write") return;
      const filePath = output.args.filePath;
      if (!isVaultNote(filePath)) return;

      try {
        await client.app.log({
          body: {
            service: "ori",
            level: "info",
            message: `Validating note: ${filePath}`,
          },
        });
        await $`ori validate ${filePath} ${vaultFlag}`;
        await client.app.log({
          body: {
            service: "ori",
            level: "info",
            message: `Validation complete: ${filePath}`,
          },
        });
      } catch (err) {
        await client.app.log({
          body: {
            service: "ori",
            level: "warn",
            message: `Validation failed for ${filePath}: ${err.message}`,
          },
        });
      }
    },
  };
};
