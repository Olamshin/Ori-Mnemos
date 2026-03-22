import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildGenericInstallOutput,
  getCodexGlobalPaths,
  getCursorGlobalPaths,
  getCursorProjectPaths,
  getHermesGlobalPaths,
  resolveBridgePlan,
  selectPreferredBridgePlan,
} from "../src/core/bridge.js";
import {
  mergeMcpConfig,
  mergeHermesConfig,
  mergeSettings,
  removeClaudeInstructions,
  removeHermesInstructions,
  removeOriFromHermesConfig,
  removeOriFromMcpConfig,
  removeOriFromSettings,
  runBridgeClaudeCode,
  runBridgeCodex,
  runBridgeCursor,
  runBridgeHermes,
  runBridgeStatus,
} from "../src/cli/bridge.js";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ori-bridge-"));
  tempDirs.push(dir);
  return dir;
}

async function makeVault(root: string) {
  await mkdir(path.join(root, ".ori"), { recursive: true });
}

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await makeTempDir();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn(home);
  } finally {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("resolveBridgePlan", () => {
  it("uses explicit vault overrides for project installs", async () => {
    const cwd = await makeTempDir();
    const explicitVault = path.join(cwd, "brain");

    const plan = await resolveBridgePlan({
      target: "claude-code",
      startDir: cwd,
      scope: "project",
      activation: "manual",
      vault: explicitVault,
    });

    expect(plan.resolvedVault).toBe(path.resolve(explicitVault));
    expect(plan.resolvedVaultSource).toBe("explicit");
    expect(plan.server.args).toEqual(["serve", "--mcp", "--vault", path.resolve(explicitVault)]);
    expect(plan.server.env).toEqual({ ORI_VAULT: path.resolve(explicitVault) });
  });

  it("resolves the nearest project vault without falling back global", async () => {
    const root = await makeTempDir();
    const nested = path.join(root, "apps", "demo");
    await mkdir(nested, { recursive: true });
    await makeVault(root);

    const plan = await resolveBridgePlan({
      target: "claude-code",
      startDir: nested,
      scope: "project",
    });

    expect(plan.resolvedVault).toBe(root);
    expect(plan.resolvedVaultSource).toBe("project");
    expect(plan.warnings).toHaveLength(0);
  });

  it("either resolves an ancestor vault or warns when project scope has no project vault", async () => {
    await withTempHome(async (home) => {
      const cwd = path.join(home, "workspace");
      await mkdir(cwd, { recursive: true });

      const plan = await resolveBridgePlan({
        target: "generic",
        startDir: cwd,
        scope: "project",
        activation: "manual",
      });

      if (plan.resolvedVault === null) {
        expect(plan.warnings).toHaveLength(1);
        expect(plan.server.args).toEqual(["serve", "--mcp"]);
      } else {
        expect(plan.resolvedVaultSource).toBe("project");
        expect(plan.server.args).toEqual(["serve", "--mcp", "--vault", plan.resolvedVault]);
      }
    });
  });

  it("uses the default machine vault for global scope", async () => {
    const cwd = await makeTempDir();

    const plan = await resolveBridgePlan({
      target: "generic",
      startDir: cwd,
      scope: "global",
    });

    expect(plan.resolvedVault).toBe(path.join(os.homedir(), ".ori-memory"));
    expect(plan.resolvedVaultSource).toBe("global-default");
    expect(plan.server.args).toEqual(["serve", "--mcp", "--vault", path.join(os.homedir(), ".ori-memory")]);
  });

  it("warns when generic install asks for auto activation", async () => {
    const cwd = await makeTempDir();

    const plan = await resolveBridgePlan({
      target: "generic",
      startDir: cwd,
      scope: "global",
      activation: "auto",
    });

    expect(plan.warnings.some((warning) => warning.includes("auto-orient"))).toBe(true);
    const output = buildGenericInstallOutput(plan);
    expect(output.command).toBe("ori");
    expect(output.scope).toBe("global");
    expect(output.activation).toBe("auto");
  });
});

describe("config merge helpers", () => {
  it("merges MCP config without clobbering unrelated servers", async () => {
    const cwd = await makeTempDir();
    const plan = await resolveBridgePlan({
      target: "claude-code",
      startDir: cwd,
      scope: "global",
      vault: path.join(cwd, "brain"),
    });

    const merged = mergeMcpConfig(
      {
        mcpServers: {
          other: { command: "other", args: ["serve"] },
        },
      },
      plan,
    );

    expect(Object.keys(merged.mcpServers ?? {}).sort()).toEqual(["ori", "other"]);
    expect((merged.mcpServers?.ori as { args: string[] }).args).toEqual([
      "serve",
      "--mcp",
      "--vault",
      path.join(cwd, "brain"),
    ]);
  });

  it("removes auto hooks when switching to manual activation", () => {
    const existing = {
      hooks: {
        SessionStart: [
          {
            hooks: [{ type: "command", command: 'node "C:/Users/test/.claude/hooks/ori/orient.mjs"', timeout: 10 }],
          },
        ],
        Stop: [
          {
            hooks: [{ type: "command", command: 'node "C:/Users/test/.claude/hooks/ori/capture.mjs"', timeout: 10 }],
          },
        ],
        PostToolUse: [
          {
            matcher: "Write",
            hooks: [{ type: "command", command: 'node "C:/Users/test/.claude/hooks/ori/validate.mjs"', timeout: 5 }],
          },
        ],
      },
    };

    const incoming = {
      hooks: {
        PostToolUse: existing.hooks.PostToolUse,
      },
    };

    const merged = mergeSettings(existing, incoming);
    expect(merged.hooks?.SessionStart).toBeUndefined();
    expect(merged.hooks?.Stop).toBeUndefined();
    expect(merged.hooks?.PostToolUse).toHaveLength(1);
  });

  it("removes only Ori-owned settings hooks on uninstall", () => {
    const existing = {
      hooks: {
        SessionStart: [
          {
            hooks: [{ type: "command", command: 'node "C:/Users/test/.claude/hooks/ori/orient.mjs"', timeout: 10 }],
          },
        ],
        PostToolUse: [
          {
            matcher: "Write",
            hooks: [{ type: "command", command: 'node "C:/Users/test/.claude/hooks/ori/validate.mjs"', timeout: 5 }],
          },
          {
            matcher: "Edit",
            hooks: [{ type: "command", command: "node custom-hook.mjs", timeout: 5 }],
          },
        ],
      },
    };

    const next = removeOriFromSettings(existing);
    expect(next.hooks?.SessionStart).toBeUndefined();
    expect(next.hooks?.PostToolUse).toHaveLength(1);
  });

  it("removes only the Ori MCP server on uninstall", () => {
    const next = removeOriFromMcpConfig({
      mcpServers: {
        ori: { command: "ori", args: ["serve", "--mcp"] },
        other: { command: "other", args: ["serve"] },
      },
    });

    expect(next.mcpServers).toEqual({
      other: { command: "other", args: ["serve"] },
    });
  });

  it("removes the Claude bridge instructions block", () => {
    const content = [
      "# Existing",
      "",
      "keep me",
      "",
      "<!-- ori-bridge:claude-code -->",
      "# Ori Mnemos - Claude Code Bridge",
      "bridge body",
    ].join("\n");
    expect(removeClaudeInstructions(content)).toBe("# Existing\n\nkeep me");
  });
});

describe("precedence", () => {
  it("prefers project installs over global installs", async () => {
    const cwd = await makeTempDir();
    const globalPlan = await resolveBridgePlan({
      target: "claude-code",
      startDir: cwd,
      scope: "global",
      vault: path.join(cwd, "global-brain"),
    });
    const projectPlan = await resolveBridgePlan({
      target: "claude-code",
      startDir: cwd,
      scope: "project",
      vault: path.join(cwd, "project-brain"),
    });

    const preferred = selectPreferredBridgePlan([globalPlan, projectPlan]);
    expect(preferred?.scope).toBe("project");
    expect(preferred?.resolvedVault).toBe(path.join(cwd, "project-brain"));
  });
});

describe("cursor adapter", () => {
  it("uses the expected project and global config paths", async () => {
    const cwd = await makeTempDir();
    expect(getCursorProjectPaths(cwd).mcpPath).toBe(path.join(cwd, ".cursor", "mcp.json"));
    expect(getCursorGlobalPaths().mcpPath).toBe(path.join(os.homedir(), ".cursor", "mcp.json"));
  });

  it("writes Cursor MCP config and warns for auto activation", async () => {
    const cwd = await makeTempDir();
    const brain = path.join(cwd, "brain");

    const result = await runBridgeCursor(cwd, {
      scope: "project",
      activation: "auto",
      vault: brain,
    });

    expect(result.success).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("Auto activation"))).toBe(true);
    const mcpPath = (result.data as { mcpPath: string }).mcpPath;
    expect(mcpPath).toBe(path.join(cwd, ".cursor", "mcp.json"));

    const written = JSON.parse(await readFile(mcpPath, "utf8")) as {
      mcpServers: { ori: { command: string; args: string[]; env: Record<string, string> } };
    };
    expect(written.mcpServers.ori.command).toBe("ori");
    expect(written.mcpServers.ori.args).toEqual(["serve", "--mcp", "--vault", brain]);
    expect(written.mcpServers.ori.env).toEqual({ ORI_VAULT: brain });
  });

  it("updates then uninstalls Cursor MCP config cleanly", async () => {
    const cwd = await makeTempDir();
    const brainA = path.join(cwd, "brain-a");
    const brainB = path.join(cwd, "brain-b");

    const installed = await runBridgeCursor(cwd, {
      scope: "project",
      activation: "manual",
      vault: brainA,
    });
    expect((installed.data as { mutation: string }).mutation).toBe("installed");

    const updated = await runBridgeCursor(cwd, {
      scope: "project",
      activation: "manual",
      vault: brainB,
    });
    expect((updated.data as { mutation: string }).mutation).toBe("updated");

    const removed = await runBridgeCursor(cwd, {
      scope: "project",
      uninstall: true,
    });
    expect((removed.data as { mutation: string }).mutation).toBe("uninstalled");

    const mcpPath = (removed.data as { mcpPath: string }).mcpPath;
    const written = JSON.parse(await readFile(mcpPath, "utf8")) as { mcpServers?: Record<string, unknown> };
    expect(written.mcpServers?.ori).toBeUndefined();
  });
});

describe("codex adapter", () => {
  it("uses the expected global config path", async () => {
    await withTempHome(async (home) => {
      expect(getCodexGlobalPaths().configPath).toBe(path.join(home, ".codex", "config.toml"));
    });
  });

  it("writes Codex MCP config to the global config path", async () => {
    await withTempHome(async (home) => {
      const cwd = await makeTempDir();
      const brain = path.join(cwd, "brain");

      const result = await runBridgeCodex(cwd, {
        scope: "global",
        activation: "manual",
        vault: brain,
      });

      expect(result.success).toBe(true);
      const configPath = (result.data as { configPath: string }).configPath;
      expect(configPath).toBe(path.join(home, ".codex", "config.toml"));

      const written = await readFile(configPath, "utf8");
      expect(written).toContain("[mcp_servers.ori]");
      expect(written).toContain('command = "ori"');
      expect(written).toContain(JSON.stringify(brain));
    });
  });

  it("updates then uninstalls Codex MCP config cleanly", async () => {
    await withTempHome(async () => {
      const cwd = await makeTempDir();
      const brainA = path.join(cwd, "brain-a");
      const brainB = path.join(cwd, "brain-b");

      const installed = await runBridgeCodex(cwd, {
        scope: "global",
        activation: "manual",
        vault: brainA,
      });
      expect((installed.data as { mutation: string }).mutation).toBe("installed");

      const updated = await runBridgeCodex(cwd, {
        scope: "global",
        activation: "manual",
        vault: brainB,
      });
      expect((updated.data as { mutation: string }).mutation).toBe("updated");

      const removed = await runBridgeCodex(cwd, {
        scope: "global",
        uninstall: true,
      });
      expect((removed.data as { mutation: string }).mutation).toBe("uninstalled");

      const configPath = (removed.data as { configPath: string }).configPath;
      const written = await readFile(configPath, "utf8");
      expect(written).not.toContain("[mcp_servers.ori]");
    });
  });
});

describe("bridge status", () => {
  it("reports project Cursor installs as the active config", async () => {
    const cwd = await makeTempDir();
    const brain = path.join(cwd, "brain");

    await runBridgeCursor(cwd, {
      scope: "project",
      activation: "manual",
      vault: brain,
    });

    const result = await runBridgeStatus(cwd);
    const cursor = (result.data as {
      clients: {
        cursor: {
          project: { installed: boolean; resolvedVault: string | null; activation: string | null };
          active: { scope: string; resolvedVault: string | null; activation: string | null } | null;
        };
      };
    }).clients.cursor;

    expect(cursor.project.installed).toBe(true);
    expect(cursor.project.resolvedVault).toBe(brain);
    expect(cursor.active?.scope).toBe("project");
    expect(cursor.active?.resolvedVault).toBe(brain);
    expect(cursor.active?.activation).toBe("unknown");
  });

  it("reports project Claude installs as the active config and detects activation", async () => {
    const cwd = await makeTempDir();
    const brain = path.join(cwd, "brain");

    await runBridgeClaudeCode(cwd, {
      scope: "project",
      activation: "manual",
      vault: brain,
    });

    const result = await runBridgeStatus(cwd);
    const claude = (result.data as {
      clients: {
        "claude-code": {
          project: { installed: boolean; resolvedVault: string | null; activation: string | null };
          active: { scope: string; resolvedVault: string | null; activation: string | null } | null;
        };
      };
    }).clients["claude-code"];

    expect(claude.project.installed).toBe(true);
    expect(claude.project.resolvedVault).toBe(brain);
    expect(claude.project.activation).toBe("manual");
    expect(claude.active?.scope).toBe("project");
    expect(claude.active?.resolvedVault).toBe(brain);
    expect(claude.active?.activation).toBe("manual");
  });

  it("reports Codex as a single global client", async () => {
    await withTempHome(async (home) => {
      const cwd = await makeTempDir();
      const brain = path.join(cwd, "brain");

      await runBridgeCodex(cwd, {
        scope: "project",
        activation: "manual",
        vault: brain,
      });

      const result = await runBridgeStatus(cwd);
      const codex = (result.data as {
        clients: {
          codex: {
            installed: boolean;
            resolvedVault: string | null;
            activation: string | null;
            configPaths: string[];
          };
        };
      }).clients.codex;

      expect(codex.installed).toBe(true);
      expect(codex.resolvedVault).toBe(brain);
      expect(codex.activation).toBe("unknown");
      expect(codex.configPaths).toEqual([path.join(home, ".codex", "config.toml")]);
    });
  });
});

describe("claude adapter", () => {
  it("reports install, update, and uninstall mutations across the lifecycle", async () => {
    const cwd = await makeTempDir();
    const brainA = path.join(cwd, "brain-a");
    const brainB = path.join(cwd, "brain-b");

    const installed = await runBridgeClaudeCode(cwd, {
      scope: "project",
      activation: "auto",
      vault: brainA,
    });
    expect((installed.data as { mutation: string }).mutation).toBe("installed");

    const updated = await runBridgeClaudeCode(cwd, {
      scope: "project",
      activation: "manual",
      vault: brainB,
    });
    expect((updated.data as { mutation: string }).mutation).toBe("updated");

    const removed = await runBridgeClaudeCode(cwd, {
      scope: "project",
      uninstall: true,
    });
    expect((removed.data as { mutation: string }).mutation).toBe("uninstalled");
  });
});

describe("hermes adapter", () => {
  it("uses the expected global config and plugin paths", async () => {
    await withTempHome(async (home) => {
      const paths = getHermesGlobalPaths();
      expect(paths.configPath).toBe(path.join(home, ".hermes", "config.yaml"));
      expect(paths.pluginDir).toBe(path.join(home, ".hermes", "plugins", "ori"));
    });
  });

  it("defaults to auto activation for hermes bridge plans", async () => {
    const cwd = await makeTempDir();
    const plan = await resolveBridgePlan({
      target: "hermes",
      startDir: cwd,
      scope: "global",
      vault: path.join(cwd, "brain"),
    });
    expect(plan.activation).toBe("auto");
  });

  it("merges Ori into Hermes YAML config without clobbering other servers", async () => {
    const cwd = await makeTempDir();
    const plan = await resolveBridgePlan({
      target: "hermes",
      startDir: cwd,
      scope: "global",
      vault: path.join(cwd, "brain"),
    });

    const merged = mergeHermesConfig(
      {
        mcp_servers: {
          time: { command: "uvx", args: ["mcp-server-time"] },
        },
      },
      plan,
    );

    expect(Object.keys(merged.mcp_servers ?? {}).sort()).toEqual(["ori", "time"]);
    expect((merged.mcp_servers?.ori as { args: string[] }).args).toEqual([
      "serve",
      "--mcp",
      "--vault",
      path.join(cwd, "brain"),
    ]);
  });

  it("removes only the Ori entry from Hermes config", () => {
    const next = removeOriFromHermesConfig({
      mcp_servers: {
        ori: { command: "ori", args: ["serve", "--mcp"] },
        time: { command: "uvx", args: ["mcp-server-time"] },
      },
    });
    expect(next.mcp_servers).toEqual({
      time: { command: "uvx", args: ["mcp-server-time"] },
    });
  });

  it("removes the Hermes bridge instructions block", () => {
    const content = [
      "# Existing project context",
      "",
      "keep me",
      "",
      "<!-- ori-bridge:hermes -->",
      "# Ori Mnemos - Hermes Agent Bridge",
      "bridge body",
    ].join("\n");
    expect(removeHermesInstructions(content)).toBe("# Existing project context\n\nkeep me");
  });

  it("writes Hermes MCP config and installs plugin on auto activation", async () => {
    await withTempHome(async (home) => {
      const cwd = await makeTempDir();
      const brain = path.join(cwd, "brain");

      const result = await runBridgeHermes(cwd, {
        scope: "global",
        activation: "auto",
        vault: brain,
      });

      expect(result.success).toBe(true);
      const data = result.data as { mutation: string; configPath: string; pluginDir: string };
      expect(data.mutation).toBe("installed");
      expect(data.configPath).toBe(path.join(home, ".hermes", "config.yaml"));
      expect(data.pluginDir).toBe(path.join(home, ".hermes", "plugins", "ori"));

      // Verify YAML config
      const yaml = await import("yaml");
      const raw = await readFile(data.configPath, "utf8");
      const config = yaml.parse(raw) as { mcp_servers?: { ori?: { command: string; args: string[]; env?: Record<string, string> } } };
      expect(config.mcp_servers?.ori?.command).toBe("ori");
      expect(config.mcp_servers?.ori?.args).toEqual(["serve", "--mcp", "--vault", brain]);
      expect(config.mcp_servers?.ori?.env).toEqual({ ORI_VAULT: brain });

      // Verify plugin was installed
      const pluginYaml = await readFile(path.join(data.pluginDir, "plugin.yaml"), "utf8");
      expect(pluginYaml).toContain("name: ori");
      const initPy = await readFile(path.join(data.pluginDir, "__init__.py"), "utf8");
      expect(initPy).toContain("def register(ctx)");
    });
  });

  it("writes project-scope instructions to HERMES.md", async () => {
    await withTempHome(async () => {
      const cwd = await makeTempDir();
      const brain = path.join(cwd, "brain");

      const result = await runBridgeHermes(cwd, {
        scope: "project",
        activation: "manual",
        vault: brain,
      });

      expect(result.success).toBe(true);
      const data = result.data as { instructionsPath: string };
      expect(data.instructionsPath).toBe(path.join(cwd, "HERMES.md"));

      const content = await readFile(data.instructionsPath, "utf8");
      expect(content).toContain("<!-- ori-bridge:hermes -->");
      expect(content).toContain("Ori Mnemos - Hermes Agent Bridge");
      expect(content).toContain("Manual activation");
    });
  });

  it("updates then uninstalls Hermes bridge cleanly", async () => {
    await withTempHome(async () => {
      const cwd = await makeTempDir();
      const brainA = path.join(cwd, "brain-a");
      const brainB = path.join(cwd, "brain-b");

      const installed = await runBridgeHermes(cwd, {
        scope: "global",
        activation: "auto",
        vault: brainA,
      });
      expect((installed.data as { mutation: string }).mutation).toBe("installed");

      const updated = await runBridgeHermes(cwd, {
        scope: "global",
        activation: "auto",
        vault: brainB,
      });
      expect((updated.data as { mutation: string }).mutation).toBe("updated");

      const removed = await runBridgeHermes(cwd, {
        scope: "global",
        uninstall: true,
      });
      expect((removed.data as { mutation: string }).mutation).toBe("uninstalled");

      // Verify config cleaned up
      const yaml = await import("yaml");
      const configPath = (removed.data as { configPath: string }).configPath;
      const raw = await readFile(configPath, "utf8");
      const config = yaml.parse(raw) as { mcp_servers?: Record<string, unknown> };
      expect(config.mcp_servers?.ori).toBeUndefined();
    });
  });

  it("reports Hermes install in bridge status", async () => {
    await withTempHome(async (home) => {
      const cwd = await makeTempDir();
      const brain = path.join(cwd, "brain");

      await runBridgeHermes(cwd, {
        scope: "global",
        activation: "auto",
        vault: brain,
      });

      const result = await runBridgeStatus(cwd);
      const hermes = (result.data as {
        clients: {
          hermes: {
            installed: boolean;
            resolvedVault: string | null;
            activation: string | null;
            configPaths: string[];
            pluginDir: string;
          };
        };
      }).clients.hermes;

      expect(hermes.installed).toBe(true);
      expect(hermes.resolvedVault).toBe(brain);
      expect(hermes.activation).toBe("auto");
      expect(hermes.configPaths).toEqual([path.join(home, ".hermes", "config.yaml")]);
      expect(hermes.pluginDir).toBe(path.join(home, ".hermes", "plugins", "ori"));
    });
  });
});
