/**
 * Ori Mnemos — OpenCode Lifecycle Plugin
 *
 * Provides session lifecycle hooks for Ori vault integration:
 * - session.created → detects first run, injects onboarding prompt
 * - session.compacted → auto-capture at context window checkpoint
 * - session.deleted → auto-capture at session end (fallback for short sessions)
 * - tool.execute.after (write) → auto-validate (note schema via `ori validate`)
 *
 * Resolves vault path from opencode.json MCP config, so it works with
 * any named MCP entry (ori, coder-memory, research-memory, etc.).
 */

import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const LOG_ROOT = process.env.APPDATA || process.env.HOME || process.cwd();
const LOG_FILE = path.join(LOG_ROOT, "opencode", "ori-plugin.log");

function logToFile(message) {
  try {
    const dir = path.dirname(LOG_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString();
    appendFileSync(LOG_FILE, `[${ts}] ${message}\n`);
  } catch { /* ignore */ }
}

const VAULT_NOTE_DIRS = new Set(["notes", "inbox", "self", "ops"]);

function normalizeForCompare(filePath) {
  return process.platform === "win32" ? filePath.toLowerCase() : filePath;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function resolveVaultNotePath(filePath, vault, directory) {
  if (!filePath || typeof filePath !== "string") return null;

  const vaultRoot = path.resolve(vault);
  const candidates = path.isAbsolute(filePath)
    ? [path.resolve(filePath)]
    : [path.resolve(directory, filePath), path.resolve(vaultRoot, filePath)];

  for (const candidate of candidates) {
    const normalizedVault = normalizeForCompare(vaultRoot);
    const normalizedCandidate = normalizeForCompare(candidate);
    if (!isInside(normalizedVault, normalizedCandidate)) continue;

    const relative = path.relative(vaultRoot, candidate);
    const topLevel = relative.split(/[\\/]/)[0];
    if (VAULT_NOTE_DIRS.has(topLevel)) return candidate;
  }

  return null;
}

function getVaultFromMcpEntry(entry) {
  if (!entry || typeof entry !== "object") return null;

  const env = entry.environment || entry.env;
  if (env && typeof env === "object" && typeof env.ORI_VAULT === "string" && env.ORI_VAULT.length > 0) {
    return env.ORI_VAULT;
  }

  const commandArgs = Array.isArray(entry.command)
    ? entry.command
    : Array.isArray(entry.args)
      ? entry.args
      : [];
  const vaultIndex = commandArgs.indexOf("--vault");
  if (vaultIndex >= 0 && typeof commandArgs[vaultIndex + 1] === "string" && commandArgs[vaultIndex + 1].length > 0) {
    return commandArgs[vaultIndex + 1];
  }

  return null;
}

function getVaultPath(directory) {
  if (process.env.ORI_VAULT) return path.resolve(process.env.ORI_VAULT);

  try {
    const configPath = path.join(directory, "opencode.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const entries = config.mcp && typeof config.mcp === "object"
      ? [config.mcp.ori, ...Object.values(config.mcp).filter((entry) => entry !== config.mcp.ori)]
      : [];

    for (const entry of entries) {
      const vault = getVaultFromMcpEntry(entry);
      if (vault) return path.resolve(directory, vault);
    }
  } catch {
    // opencode.json not found or unparseable
  }

  return null;
}

function runOriCommand(args, cwd, content) {
  const hasContent = content && content.length > 0;
  const finalArgs = hasContent ? [...args, "--content-stdin"] : [...args];
  const input = hasContent ? content : undefined;

  const result = spawnSync("ori", finalArgs, {
    cwd,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    input,
    timeout: 30000,
  });

  if (result.error && process.platform === "win32") {
    return spawnSync("ori.cmd", finalArgs, {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      input,
      timeout: 30000,
    });
  }

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
  logToFile("=== PLUGIN LOADED === directory=" + directory);
  await client.app.log({
    body: {
      service: "ori",
      level: "info",
      message: "=== PLUGIN LOADED ===",
      extra: { directory },
    },
  });

  const vault = getVaultPath(directory);
  // Track onboarded session IDs to prevent duplicate onboarding injection
  const onboardedSessions = new Set();
  // Track captured session IDs to prevent duplicate session captures
  const capturedSessions = new Set();

  if (!vault) {
    await client.app.log({
      body: {
        service: "ori",
        level: "error",
        message: "No vault path found. Check opencode.json MCP config for an Ori MCP server with ORI_VAULT or --vault.",
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
      logToFile("EVENT FIRED: " + event.type + " properties=" + JSON.stringify(event.properties || {}));
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

      if (event.type === "session.compacted" || event.type === "session.deleted") {
        logToFile(event.type + " FIRED — starting capture");
        const sessionId = event.properties?.sessionID || event.properties?.sessionId || event.sessionId || event.id;
        logToFile("sessionId extracted: " + sessionId);

        // Guard: skip if already captured this session
        if (capturedSessions.has(sessionId)) {
          logToFile("Skipping capture — already captured for session " + sessionId);
          return;
        }

        await client.app.log({
          body: {
            service: "ori",
            level: "info",
            message: `${event.type} — capturing session ${sessionId}`,
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
                  // Keep user and assistant content only
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

          // Mark as captured before writing to prevent race conditions
          capturedSessions.add(sessionId);

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

          // Use stdin to pass content — no temp files, no encoding issues
          const result = runOriCommand(["add", title, "--type", "insight"], vault, content);
          logToFile("ori add exit code: " + result.status + " stdout: " + (result.stdout?.toString() || "").slice(0, 200) + " stderr: " + (result.stderr?.toString() || "").slice(0, 200));
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
          logToFile(event.type + " capture error: " + err.message + " stack: " + err.stack);
          await client.app.log({
            body: {
              service: "ori",
              level: "error",
              message: `${event.type} capture error: ${err.message}`,
              extra: { stack: err.stack },
            },
          });
        }
      }
    },

    "tool.execute.after": async ({ tool }) => {
      if (tool.name !== "write") return;

      const filePath = tool.input?.file_path || tool.input?.path;
      const notePath = resolveVaultNotePath(filePath, vault, directory);
      if (!notePath) return;

      await client.app.log({
        body: {
          service: "ori",
          level: "info",
          message: `Auto-validating vault note: ${notePath}`,
        },
      });

      const validationResult = runOriCommand(["validate", notePath], vault);
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
