/**
 * Ori Mnemos — OpenCode Lifecycle Plugin
 *
 * Provides session lifecycle hooks for Ori vault integration:
 * - session.created → detects first run, injects onboarding prompt
 * - session.idle → auto-capture (fetches session messages via SDK, saves via `ori add --content`)
 * - tool.execute.after (write) → auto-validate (note schema via `ori validate`)
 *
 * Resolves vault path from opencode.json MCP config, so it works with
 * any named MCP entry (ori, coder-memory, research-memory, etc.).
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const VAULT_NOTE_PATHS = ["notes/", "inbox/", "self/", "ops/"];

function isVaultNote(filePath) {
  if (!filePath) return false;
  return VAULT_NOTE_PATHS.some((p) => filePath.includes(p));
}

function getVaultPath(directory) {
  if (process.env.ORI_VAULT) return process.env.ORI_VAULT;

  try {
    const configPath = path.join(directory, "opencode.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const mcp = config.mcp?.ori;
    if (!mcp) return null;

    const cmd = mcp.command;
    if (Array.isArray(cmd)) {
      const vaultIndex = cmd.indexOf("--vault");
      if (vaultIndex >= 0 && cmd[vaultIndex + 1]) {
        return cmd[vaultIndex + 1];
      }
    }

    if (mcp.environment?.ORI_VAULT) {
      return mcp.environment.ORI_VAULT;
    }
  } catch {
    // opencode.json not found or unparseable
  }

  return null;
}

function runOriCommand(args, cwd) {
  const result = spawnSync("ori", args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10000,
  });
  return result;
}

function isFirstRun(vault) {
  try {
    const identityPath = path.join(vault, "self", "identity.md");
    const content = readFileSync(identityPath, "utf8");
    // Strip frontmatter, headers, comments, whitespace
    const stripped = content
      .replace(/^---[\s\S]*?---/, "")
      .replace(/^#+\s.*$/gm, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .trim();
    return stripped.length === 0;
  } catch {
    return true; // No identity file = first run
  }
}

const ONBOARDING_PROMPT = `This is your FIRST SESSION. Your identity.md is blank.

Run the onboarding flow now:
1. Ask: "What should I call myself?" (default: Ori)
2. Ask: "What's my purpose?" — offer: general-purpose AI agent, personal knowledge base, research assistant, work/professional, learning journal, or custom
3. Say: "Tell me everything about you — what you're working on, what you care about, your projects, your goals. The more you share, the more useful I become."
4. Ask: "How should I communicate with you?" — direct, formal, casual, opinionated, supportive?

After collecting answers, use the ori_update tool to write:
- file=identity (name, personality, communication style, values)
- file=goals (projects and threads from their brain dump)
- file=methodology (session rhythm based on their purpose)

Make this feel warm and alive — this is their agent waking up for the first time.`;

export const OriLifecyclePlugin = async ({ client, directory }) => {
  await client.app.log({
    body: {
      service: "ori",
      level: "info",
      message: "=== PLUGIN LOADED ===",
      extra: { directory },
    },
  });

  const vault = getVaultPath(directory);
  // Track onboarded session IDs to prevent duplicate injection
  const onboardedSessions = new Set();

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
        // Extract session ID early for guard check
        const sessionId = event.properties?.sessionID || event.properties?.sessionId || event.sessionId || event.id;

        // Guard: skip if already onboarded this session
        if (onboardedSessions.has(sessionId)) {
          await client.app.log({
            body: {
              service: "ori",
              level: "info",
              message: `Skipping onboarding — already injected for session ${sessionId}`,
            },
          });
          return;
        }

        await client.app.log({
          body: {
            service: "ori",
            level: "info",
            message: "session.created event received — checking first run",
            extra: { sessionId, eventKeys: Object.keys(event || {}) },
          },
        });

        const firstRun = isFirstRun(vault);
        await client.app.log({
          body: {
            service: "ori",
            level: "info",
            message: `isFirstRun result: ${firstRun}`,
          },
        });

        if (firstRun) {
          // Mark as onboarded immediately to prevent race conditions
          onboardedSessions.add(sessionId);
          await client.app.log({
            body: {
              service: "ori",
              level: "info",
              message: `First run detected — injecting onboarding prompt for session ${sessionId} (once)`,
            },
          });

          // Try session.prompt with correct API format
          try {
            await client.app.log({
              body: {
                service: "ori",
                level: "info",
                message: `Attempting session.prompt with sessionId: ${sessionId}`,
                extra: { properties: JSON.stringify(event.properties || {}) },
              },
            });
            if (sessionId && sessionId.startsWith("ses")) {
              await client.session.prompt({
                path: { id: sessionId },
                body: {
                  noReply: true,
                  parts: [{ type: "text", text: ONBOARDING_PROMPT }],
                },
              });
              await client.app.log({
                body: {
                  service: "ori",
                  level: "info",
                  message: "session.prompt succeeded",
                },
              });
            } else {
              await client.app.log({
                body: {
                  service: "ori",
                  level: "warn",
                  message: `Invalid sessionId: ${sessionId}`,
                },
              });
            }
          } catch (err) {
            await client.app.log({
              body: {
                service: "ori",
                level: "error",
                message: `session.prompt failed: ${err.message}`,
                extra: { stack: err.stack },
              },
            });
          }
        } else {
          await client.app.log({
            body: {
              service: "ori",
              level: "info",
              message: "Session started — identity already configured",
              extra: { vault },
            },
          });
        }
      }

      if (event.type === "session.idle") {
        const sessionId = event.properties?.sessionID || event.properties?.sessionId || event.sessionId || event.id;
        await client.app.log({
          body: {
            service: "ori",
            level: "info",
            message: `session.idle — capturing session ${sessionId}`,
          },
        });

        try {
          // Fetch all messages from the session
          const messages = await client.session.messages({ path: { id: sessionId } });
          if (!messages || !messages.data || messages.data.length === 0) {
            await client.app.log({
              body: { service: "ori", level: "warn", message: "No messages to capture" },
            });
            return;
          }

          // Build conversation transcript from messages
          const parts = [];
          for (const msg of messages.data) {
            const role = msg.info?.role || msg.role || "unknown";
            if (msg.parts && Array.isArray(msg.parts)) {
              for (const part of msg.parts) {
                if (part.type === "text" && part.text) {
                  // Skip system/injected prompts — keep user and assistant content
                  if (role === "user" || role === "assistant") {
                    parts.push(`## ${role}\n${part.text}`);
                  }
                }
              }
            }
          }

          if (parts.length === 0) {
            await client.app.log({
              body: { service: "ori", level: "warn", message: "No text content to capture" },
            });
            return;
          }

          const content = parts.join("\n\n---\n\n");
          const timestamp = new Date().toISOString().slice(0, 10);
          const title = `Session capture ${timestamp}`;

          await client.app.log({
            body: {
              service: "ori",
              level: "info",
              message: `Capturing ${parts.length} message parts (${content.length} chars)`,
            },
          });

          const result = runOriCommand(["add", title, "--type", "insight", "--content", content], vault);
          if (result.status === 0) {
            const output = result.stdout?.toString().trim();
            await client.app.log({
              body: {
                service: "ori",
                level: "info",
                message: `Session captured: ${output}`,
              },
            });
          } else {
            await client.app.log({
              body: {
                service: "ori",
                level: "error",
                message: `Capture failed: ${result.stderr?.toString() || "unknown error"}`,
              },
            });
          }
        } catch (err) {
          await client.app.log({
            body: {
              service: "ori",
              level: "error",
              message: `session.idle capture error: ${err.message}`,
              extra: { stack: err.stack },
            },
          });
        }
      }
    },

    "tool.execute.after": async ({ tool, result }) => {
      if (tool.name !== "write") return;

      const filePath = tool.input?.file_path || tool.input?.path;
      if (!isVaultNote(filePath)) return;

      await client.app.log({
        body: {
          service: "ori",
          level: "info",
          message: `Auto-validating vault note: ${filePath}`,
        },
      });

      const validationResult = runOriCommand(["validate", filePath], vault);
      if (validationResult.status === 0) {
        await client.app.log({
          body: {
            service: "ori",
            level: "info",
            message: "Validation passed",
          },
        });
      } else {
        await client.app.log({
          body: {
            service: "ori",
            level: "warn",
            message: `Validation issues: ${validationResult.stderr?.toString() || "unknown"}`,
          },
        });
      }
    },
  };
};
