import os from "node:os";
import path from "node:path";
import { getGlobalVaultPath, isVaultRoot } from "./vault.js";

export type BridgeTarget = "claude-code" | "cursor" | "codex" | "hermes" | "generic";
export type BridgeScope = "project" | "global";
export type BridgeActivation = "auto" | "manual";
export type VaultResolutionSource = "explicit" | "project" | "global-default" | "none";

export interface BridgeRequest {
  target: BridgeTarget;
  startDir: string;
  scope?: BridgeScope;
  activation?: BridgeActivation;
  vault?: string;
  global?: boolean;
  uninstall?: boolean;
}

export interface BridgeServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface BridgePlan {
  target: BridgeTarget;
  scope: BridgeScope;
  activation: BridgeActivation;
  resolvedVault: string | null;
  resolvedVaultSource: VaultResolutionSource;
  server: BridgeServerConfig;
  instructions: string[];
  warnings: string[];
}

export function selectPreferredBridgePlan(plans: Array<BridgePlan | null | undefined>): BridgePlan | null {
  const concrete = plans.filter((plan): plan is BridgePlan => Boolean(plan));
  if (concrete.length === 0) return null;
  return concrete.find((plan) => plan.scope === "project") ?? concrete[0];
}

export function resolveBridgeScope(request: Pick<BridgeRequest, "scope" | "global">): BridgeScope {
  if (request.scope) return request.scope;
  return request.global ? "global" : "project";
}

export async function resolveBridgePlan(request: BridgeRequest): Promise<BridgePlan> {
  const scope = resolveBridgeScope(request);
  const activation = request.activation ?? (request.target === "claude-code" || request.target === "hermes" ? "auto" : "manual");

  let resolvedVault: string | null = null;
  let resolvedVaultSource: VaultResolutionSource = "none";
  const warnings: string[] = [];
  const instructions: string[] = [];

  if (request.vault) {
    resolvedVault = path.resolve(request.vault);
    resolvedVaultSource = "explicit";
  } else if (scope === "global") {
    resolvedVault = getGlobalVaultPath();
    resolvedVaultSource = "global-default";
  } else {
    resolvedVault = await findNearestProjectVault(request.startDir);
    resolvedVaultSource = resolvedVault ? "project" : "none";
  }

  const server = buildServerConfig(resolvedVault);

  if (!request.uninstall && scope === "project" && !resolvedVault) {
    warnings.push(
      "No project vault was found from the current directory. The generated config will rely on runtime discovery unless you pass --vault.",
    );
    instructions.push(
      "Create a project vault with `ori init` or pass `--vault <path>` so project scope resolves predictably.",
    );
  }

  if (!request.uninstall && scope === "global" && resolvedVaultSource === "global-default") {
    instructions.push(
      `Global scope targets the default machine vault at ${resolvedVault}. Pass --vault to pin a different shared brain.`,
    );
  }

  if (!request.uninstall && request.target === "codex" && scope === "project") {
    warnings.push(
      "Codex stores MCP servers in ~/.codex/config.toml only. Project scope uses runtime vault discovery from a global MCP entry rather than a separate project config file.",
    );
    instructions.push(
      "Codex project installs write to ~/.codex/config.toml without pinning --vault unless you pass --vault explicitly.",
    );
  }

  if (!request.uninstall && request.target === "hermes" && scope === "project") {
    instructions.push(
      "Hermes stores MCP servers in ~/.hermes/config.yaml globally. Project scope adds HERMES.md instructions to the project root.",
    );
  }

  if (!request.uninstall && (request.target === "generic" || request.target === "codex") && activation === "auto") {
    warnings.push(
      `${request.target === "codex" ? "Codex" : "Generic installs"} cannot auto-orient by themselves. Treat activation=auto as a request for client-side startup wiring.`,
    );
    instructions.push(
      "If your client supports startup hooks or startup prompts, call `ori_orient` automatically at session start. Otherwise use manual activation.",
    );
  }

  if (!request.uninstall && activation === "manual") {
    instructions.push("Manual activation disables auto-orient. Call `ori_orient` explicitly when you want session context loaded.");
  }

  instructions.push("Project installs override global installs when both exist for the same client.");

  return {
    target: request.target,
    scope,
    activation,
    resolvedVault,
    resolvedVaultSource,
    server,
    instructions,
    warnings,
  };
}

export function buildServerConfig(vaultPath: string | null): BridgeServerConfig {
  const args = ["serve", "--mcp"];
  const env: Record<string, string> = {};

  if (vaultPath) {
    args.push("--vault", vaultPath);
    env.ORI_VAULT = vaultPath;
  }

  return {
    command: "ori",
    args,
    env,
  };
}

export function buildGenericInstallOutput(plan: BridgePlan) {
  return {
    client: plan.target,
    mode: plan.target === "generic" ? "generic" : "adapter",
    command: plan.server.command,
    args: plan.server.args,
    env: plan.server.env,
    scope: plan.scope,
    activation: plan.activation,
    resolvedVault: plan.resolvedVault,
    instructions: plan.instructions,
    warnings: plan.warnings,
  };
}

async function findNearestProjectVault(startDir: string): Promise<string | null> {
  let current = path.resolve(startDir);
  while (true) {
    if (await isVaultRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function getClaudeProjectPaths(startDir: string) {
  const root = path.resolve(startDir);
  const claudeDir = path.join(root, ".claude");
  return {
    root,
    claudeDir,
    hooksDir: path.join(claudeDir, "hooks"),
    settingsPath: path.join(claudeDir, "settings.json"),
    mcpPath: path.join(root, ".mcp.json"),
    instructionsPath: path.join(root, "CLAUDE.md"),
  };
}

export function getClaudeGlobalPaths() {
  const homeDir = os.homedir();
  const claudeDir = path.join(homeDir, ".claude");
  return {
    homeDir,
    claudeDir,
    hooksDir: path.join(claudeDir, "hooks", "ori"),
    settingsPath: path.join(claudeDir, "settings.json"),
    mcpPath: path.join(homeDir, ".claude.json"),
    instructionsPath: path.join(claudeDir, "CLAUDE.md"),
  };
}

export function getCursorProjectPaths(startDir: string) {
  const root = path.resolve(startDir);
  const cursorDir = path.join(root, ".cursor");
  return {
    root,
    cursorDir,
    mcpPath: path.join(cursorDir, "mcp.json"),
  };
}

export function getCursorGlobalPaths() {
  const homeDir = os.homedir();
  const cursorDir = path.join(homeDir, ".cursor");
  return {
    homeDir,
    cursorDir,
    mcpPath: path.join(cursorDir, "mcp.json"),
  };
}

export function getCodexGlobalPaths() {
  const homeDir = os.homedir();
  const codexDir = path.join(homeDir, ".codex");
  return {
    homeDir,
    codexDir,
    configPath: path.join(codexDir, "config.toml"),
  };
}

export function getHermesGlobalPaths() {
  const homeDir = os.homedir();
  const hermesDir = path.join(homeDir, ".hermes");
  return {
    homeDir,
    hermesDir,
    configPath: path.join(hermesDir, "config.yaml"),
    pluginDir: path.join(hermesDir, "plugins", "ori"),
  };
}

export function getHermesProjectPaths(startDir: string) {
  const root = path.resolve(startDir);
  return {
    root,
    instructionsPath: path.join(root, "HERMES.md"),
  };
}
