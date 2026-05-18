/**
 * Ori Mnemos — OpenCode Lifecycle Plugin
 *
 * Provides session lifecycle hooks for Ori vault integration:
 * - session.created → auto-orient (session briefing)
 * - session.idle → auto-capture (session insights)
 * - tool.execute.after (write) → auto-validate (note schema validation)
 *
 * Reads ORI_VAULT from the MCP server's environment, so it works with
 * any named MCP entry (ori, coder-memory, research-memory, etc.).
 */

const VAULT_NOTE_PATHS = ["notes/", "inbox/", "self/", "ops/"];

function isVaultNote(filePath) {
  if (!filePath) return false;
  return VAULT_NOTE_PATHS.some((p) => filePath.includes(p));
}

export const OriLifecyclePlugin = async ({ $, client }) => {
  const vault = process.env.ORI_VAULT;
  const vaultFlag = vault ? ["--vault", vault] : [];

  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        try {
          await $`ori orient ${vaultFlag}`;
          await client.app.log({
            body: {
              service: "ori",
              level: "info",
              message: "Session oriented",
              extra: { vault: vault ?? "default" },
            },
          });
        } catch (err) {
          await client.app.log({
            body: {
              service: "ori",
              level: "warn",
              message: `Orient failed: ${err.message}`,
            },
          });
        }
      }

      if (event.type === "session.idle") {
        try {
          const timestamp = new Date().toISOString().slice(0, 10);
          await $`ori add "Session capture ${timestamp}" --type insight ${vaultFlag}`;
          await client.app.log({
            body: {
              service: "ori",
              level: "info",
              message: "Session captured",
              extra: { vault: vault ?? "default" },
            },
          });
        } catch (err) {
          await client.app.log({
            body: {
              service: "ori",
              level: "warn",
              message: `Capture failed: ${err.message}`,
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
        await $`ori validate ${filePath} ${vaultFlag}`;
        await client.app.log({
          body: {
            service: "ori",
            level: "info",
            message: `Validated note: ${filePath}`,
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
