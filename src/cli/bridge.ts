import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildGenericInstallOutput,
  getClaudeGlobalPaths,
  getClaudeProjectPaths,
  getCursorGlobalPaths,
  getCursorProjectPaths,
  resolveBridgePlan,
  type BridgeActivation,
  type BridgePlan,
  type BridgeRequest,
} from "../core/bridge.js";

const BRIDGE_SENTINEL = "<!-- ori-bridge:claude-code -->";
const ORI_MCP_SENTINEL = "ori";
const ORI_HOOK_SCRIPT_NAMES = ["orient.mjs", "validate.mjs", "capture.mjs"] as const;

function claudeSnippet(activation: BridgeActivation): string {
  const orientLine =
    activation === "auto"
      ? "- Ori injects identity via MCP instructions automatically"
      : "- Manual activation is enabled; call `ori_orient` when you want session context loaded";
  const persistLine =
    activation === "auto"
      ? "- Session capture runs automatically at stop"
      : "- Automatic session capture is disabled in manual mode to avoid junk notes";

  return `# Ori Mnemos - Claude Code Bridge

## Session Rhythm
Every session: Orient -> Work -> Persist

### Orient (always first)
- ${orientLine}
- Call \`ori_orient\` for session briefing (daily + goals + reminders + vault status)
- Use \`ori_orient brief=false\` for full context including identity and methodology
- Read \`ori://identity\` or \`ori://goals\` resources for specific context

### Work
- Use \`ori_query_ranked\` to find related notes before creating new ones
- Use \`ori add\` to capture insights to inbox/
- NEVER write to notes/ directly — use \`ori add\` then \`ori_promote\`

### Persist
- Use \`ori_update\` file=daily to mark completed items
- Use \`ori_update\` file=goals to update active threads
- Run \`ori validate\` on notes you create
- ${persistLine}
- Keep notes atomic and link to maps
`;
}

function localSettings(activation: BridgeActivation) {
  const hooks: Record<string, unknown[]> = {
    PostToolUse: [
      {
        matcher: "Write",
        hooks: [
          {
            type: "command",
            command: "node .claude/hooks/validate.mjs",
            timeout: 5,
          },
        ],
      },
    ],
  };

  if (activation === "auto") {
    hooks.SessionStart = [
      {
        hooks: [
          {
            type: "command",
            command: "node .claude/hooks/orient.mjs",
            timeout: 10,
          },
        ],
      },
    ];
    hooks.Stop = [
      {
        hooks: [
          {
            type: "command",
            command: "node .claude/hooks/capture.mjs",
            timeout: 10,
          },
        ],
      },
    ];
  }

  return { hooks };
}

function globalSettings(hooksDir: string, activation: BridgeActivation) {
  const orientCmd = `node "${path.join(hooksDir, "orient.mjs")}"`;
  const validateCmd = `node "${path.join(hooksDir, "validate.mjs")}"`;
  const captureCmd = `node "${path.join(hooksDir, "capture.mjs")}"`;
  const hooks: Record<string, unknown[]> = {
    PostToolUse: [
      {
        matcher: "Write",
        hooks: [{ type: "command", command: validateCmd, timeout: 5 }],
      },
    ],
  };

  if (activation === "auto") {
    hooks.SessionStart = [
      {
        hooks: [{ type: "command", command: orientCmd, timeout: 10 }],
      },
    ];
    hooks.Stop = [
      {
        hooks: [{ type: "command", command: captureCmd, timeout: 10 }],
      },
    ];
  }

  return { hooks };
}

function hookEntryHasOriMarker(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const hooks = (entry as Record<string, unknown>).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((h: unknown) => {
    if (!h || typeof h !== "object") return false;
    const cmd = (h as Record<string, unknown>).command;
    return (
      typeof cmd === "string" &&
      (cmd.replace(/\\/g, "/").includes("hooks/ori/") ||
        ORI_HOOK_SCRIPT_NAMES.some((scriptName) =>
          cmd.replace(/\\/g, "/").includes(`.claude/hooks/${scriptName}`),
        ))
    );
  });
}

type SettingsShape = {
  hooks?: Record<string, unknown[]>;
  [key: string]: unknown;
};

type McpShape = {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
};

type BridgeMutationKind = "installed" | "updated" | "uninstalled" | "noop";
type BridgeInstallStatus = {
  installed: boolean;
  scope: "project" | "global";
  client: "claude-code" | "cursor";
  configPaths: string[];
  mcpPath?: string;
  settingsPath?: string;
  instructionsPath?: string;
  hooksDir?: string;
  activation: BridgeActivation | "unknown" | null;
  resolvedVault: string | null;
  details: string[];
};

export function mergeSettings(existing: SettingsShape, incoming: SettingsShape): SettingsShape {
  const merged: SettingsShape = {
    ...existing,
    hooks: { ...(existing.hooks ?? {}) },
  };

  const incomingHooks = incoming.hooks ?? {};
  for (const [event, entries] of Object.entries(incomingHooks)) {
    const current = (merged.hooks![event] ?? []) as unknown[];
    const alreadyInstalled = current.some(hookEntryHasOriMarker);
    if (!alreadyInstalled) {
      merged.hooks![event] = [...current, ...entries];
    }
  }

  if (incoming.hooks) {
    for (const event of Object.keys(merged.hooks ?? {})) {
      if (!(event in incoming.hooks) && (merged.hooks?.[event] ?? []).some(hookEntryHasOriMarker)) {
        delete merged.hooks![event];
      }
    }
  }

  return merged;
}

export function mergeMcpConfig(existing: McpShape, plan: BridgePlan): McpShape {
  const next: McpShape = {
    ...existing,
    mcpServers: { ...(existing.mcpServers ?? {}) },
  };

  next.mcpServers![ORI_MCP_SENTINEL] = {
    command: plan.server.command,
    args: plan.server.args,
    ...(Object.keys(plan.server.env).length > 0 ? { env: plan.server.env } : {}),
  };

  return next;
}

export function removeOriFromSettings(existing: SettingsShape): SettingsShape {
  const next: SettingsShape = {
    ...existing,
    hooks: { ...(existing.hooks ?? {}) },
  };

  for (const [event, entries] of Object.entries(next.hooks ?? {})) {
    const filtered = entries.filter((entry) => !hookEntryHasOriMarker(entry));
    if (filtered.length === 0) {
      delete next.hooks![event];
    } else {
      next.hooks![event] = filtered;
    }
  }

  if (next.hooks && Object.keys(next.hooks).length === 0) {
    delete next.hooks;
  }

  return next;
}

export function removeOriFromMcpConfig(existing: McpShape): McpShape {
  const next: McpShape = {
    ...existing,
    mcpServers: { ...(existing.mcpServers ?? {}) },
  };

  if (next.mcpServers) {
    delete next.mcpServers[ORI_MCP_SENTINEL];
    if (Object.keys(next.mcpServers).length === 0) {
      delete next.mcpServers;
    }
  }

  return next;
}

function classifyMcpMutation(existing: McpShape, next: McpShape, uninstall = false): BridgeMutationKind {
  const hadOri = Boolean(existing.mcpServers && ORI_MCP_SENTINEL in existing.mcpServers);
  const hasOri = Boolean(next.mcpServers && ORI_MCP_SENTINEL in next.mcpServers);
  if (uninstall) return hadOri ? "uninstalled" : "noop";
  if (!hadOri && hasOri) return "installed";
  if (hadOri && hasOri) return "updated";
  return "noop";
}

function classifySettingsMutation(existing: SettingsShape, next: SettingsShape, uninstall = false): BridgeMutationKind {
  const hadOri = Object.values(existing.hooks ?? {}).some((entries) => entries.some(hookEntryHasOriMarker));
  const hasOri = Object.values(next.hooks ?? {}).some((entries) => entries.some(hookEntryHasOriMarker));
  if (uninstall) return hadOri ? "uninstalled" : "noop";
  if (!hadOri && hasOri) return "installed";
  if (hadOri && hasOri) return "updated";
  return "noop";
}

async function mergeIntoSettingsFile(settingsPath: string, incoming: SettingsShape, uninstall = false): Promise<BridgeMutationKind> {
  let existing: SettingsShape = {};
  try {
    const raw = await fs.readFile(settingsPath, "utf8");
    existing = JSON.parse(raw) as SettingsShape;
  } catch {
    // file missing or unparseable - start fresh
  }

  const merged = uninstall ? removeOriFromSettings(existing) : mergeSettings(existing, incoming);
  await fs.writeFile(settingsPath, JSON.stringify(merged, null, 2));
  return classifySettingsMutation(existing, merged, uninstall);
}

async function mergeIntoMcpFile(mcpPath: string, plan: BridgePlan, uninstall = false): Promise<BridgeMutationKind> {
  let existing: McpShape = {};
  try {
    const raw = await fs.readFile(mcpPath, "utf8");
    existing = JSON.parse(raw) as McpShape;
  } catch {
    // file missing or unparseable - start fresh
  }

  const merged = uninstall ? removeOriFromMcpConfig(existing) : mergeMcpConfig(existing, plan);
  await fs.writeFile(mcpPath, JSON.stringify(merged, null, 2));
  return classifyMcpMutation(existing, merged, uninstall);
}

function getClaudeAdaptersDir(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return path.resolve(__dirname, "..", "..", "adapters", "claude-code");
}

async function copyHooks(adaptersDir: string, hooksDir: string): Promise<void> {
  await fs.mkdir(hooksDir, { recursive: true });
  for (const hook of ["orient.mjs", "validate.mjs", "capture.mjs"]) {
    await fs.copyFile(
      path.join(adaptersDir, "hooks", hook),
      path.join(hooksDir, hook)
    );
  }
}

async function appendClaudeInstructions(claudePath: string, activation: BridgeActivation): Promise<BridgeMutationKind> {
  let existing = "";
  try {
    existing = await fs.readFile(claudePath, "utf8");
  } catch {
    // file doesn't exist yet
  }
  if (existing.includes(BRIDGE_SENTINEL)) {
    return "noop";
  }
  await fs.appendFile(claudePath, `\n\n${BRIDGE_SENTINEL}\n${claudeSnippet(activation)}`);
  return existing.length > 0 ? "updated" : "installed";
}

export function removeClaudeInstructions(content: string): string {
  const marker = `\n\n${BRIDGE_SENTINEL}\n`;
  const idx = content.indexOf(marker);
  if (idx >= 0) return content.slice(0, idx);
  return content;
}

async function uninstallClaudeInstructions(claudePath: string): Promise<BridgeMutationKind> {
  try {
    const existing = await fs.readFile(claudePath, "utf8");
    const next = removeClaudeInstructions(existing);
    await fs.writeFile(claudePath, next, "utf8");
    return next === existing ? "noop" : "uninstalled";
  } catch {
    return "noop";
  }
}

function summarizeMutations(kinds: BridgeMutationKind[]): BridgeMutationKind {
  if (kinds.includes("updated")) return "updated";
  if (kinds.includes("installed")) return "installed";
  if (kinds.includes("uninstalled")) return "uninstalled";
  return "noop";
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function extractVaultFromMcpConfig(config: McpShape | null): string | null {
  const entry = config?.mcpServers?.[ORI_MCP_SENTINEL];
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const env = record.env;
  if (env && typeof env === "object") {
    const value = (env as Record<string, unknown>).ORI_VAULT;
    if (typeof value === "string" && value.length > 0) return value;
  }
  const args = record.args;
  if (Array.isArray(args)) {
    const vaultIndex = args.findIndex((value) => value === "--vault");
    if (vaultIndex >= 0 && typeof args[vaultIndex + 1] === "string") {
      return args[vaultIndex + 1] as string;
    }
  }
  return null;
}

function detectClaudeActivation(settings: SettingsShape | null): BridgeActivation | "unknown" | null {
  const hooks = settings?.hooks ?? {};
  const hasOrient = (hooks.SessionStart ?? []).some(hookEntryHasOriMarker);
  const hasValidate = (hooks.PostToolUse ?? []).some(hookEntryHasOriMarker);
  if (hasOrient) return "auto";
  if (hasValidate) return "manual";
  return null;
}

async function inspectClaudeInstall(startDir: string, scope: "project" | "global"): Promise<BridgeInstallStatus> {
  const paths = scope === "global" ? getClaudeGlobalPaths() : getClaudeProjectPaths(startDir);
  const [settings, mcp, instructions] = await Promise.all([
    readJsonFile<SettingsShape>(paths.settingsPath),
    readJsonFile<McpShape>(paths.mcpPath),
    fs.readFile(paths.instructionsPath, "utf8").catch(() => null),
  ]);

  const hasSettings = Object.values(settings?.hooks ?? {}).some((entries) => entries.some(hookEntryHasOriMarker));
  const hasMcp = Boolean(mcp?.mcpServers?.[ORI_MCP_SENTINEL]);
  const hasInstructions = typeof instructions === "string" && instructions.includes(BRIDGE_SENTINEL);
  const installed = hasSettings || hasMcp || hasInstructions;
  const details: string[] = [];

  if (hasMcp) details.push(`MCP config present at ${paths.mcpPath}.`);
  if (hasSettings) details.push(`Ori hook entries present at ${paths.settingsPath}.`);
  if (hasInstructions) details.push(`Ori bridge instructions present at ${paths.instructionsPath}.`);
  if (!installed) details.push("No Ori-managed Claude bridge config detected.");

  return {
    installed,
    client: "claude-code",
    scope,
    configPaths: [paths.settingsPath, paths.mcpPath, paths.instructionsPath],
    mcpPath: paths.mcpPath,
    settingsPath: paths.settingsPath,
    instructionsPath: paths.instructionsPath,
    hooksDir: paths.hooksDir,
    activation: detectClaudeActivation(settings),
    resolvedVault: extractVaultFromMcpConfig(mcp),
    details,
  };
}

async function inspectCursorInstall(startDir: string, scope: "project" | "global"): Promise<BridgeInstallStatus> {
  const paths = scope === "global" ? getCursorGlobalPaths() : getCursorProjectPaths(startDir);
  const mcp = await readJsonFile<McpShape>(paths.mcpPath);
  const hasMcp = Boolean(mcp?.mcpServers?.[ORI_MCP_SENTINEL]);
  const details = hasMcp
    ? [`MCP config present at ${paths.mcpPath}.`]
    : ["No Ori-managed Cursor MCP config detected."];

  return {
    installed: hasMcp,
    client: "cursor",
    scope,
    configPaths: [paths.mcpPath],
    mcpPath: paths.mcpPath,
    activation: hasMcp ? "unknown" : null,
    resolvedVault: extractVaultFromMcpConfig(mcp),
    details,
  };
}

export async function runBridgeStatus(startDir: string) {
  const [claudeProject, claudeGlobal, cursorProject, cursorGlobal] = await Promise.all([
    inspectClaudeInstall(startDir, "project"),
    inspectClaudeInstall(startDir, "global"),
    inspectCursorInstall(startDir, "project"),
    inspectCursorInstall(startDir, "global"),
  ]);

  return {
    success: true,
    data: {
      clients: {
        "claude-code": {
          project: claudeProject,
          global: claudeGlobal,
          active: claudeProject.installed ? claudeProject : claudeGlobal.installed ? claudeGlobal : null,
        },
        cursor: {
          project: cursorProject,
          global: cursorGlobal,
          active: cursorProject.installed ? cursorProject : cursorGlobal.installed ? cursorGlobal : null,
        },
      },
      precedence: "project-over-global",
      instructions: [
        "Project installs override global installs when both exist for the same client.",
        "Cursor activation is reported as unknown because the adapter currently stores MCP wiring only, not startup behavior.",
      ],
    },
    warnings: [],
  };
}

export async function runBridgeClaudeCode(startDir: string, request: Omit<BridgeRequest, "target" | "startDir"> = {}) {
  const plan = await resolveBridgePlan({ ...request, target: "claude-code", startDir });
  const paths = plan.scope === "global" ? getClaudeGlobalPaths() : getClaudeProjectPaths(startDir);
  const adaptersDir = getClaudeAdaptersDir();

  let settingsMutation: BridgeMutationKind = "noop";
  let mcpMutation: BridgeMutationKind = "noop";
  let instructionsMutation: BridgeMutationKind = "noop";

  if (request.uninstall) {
    settingsMutation = await mergeIntoSettingsFile(paths.settingsPath, {}, true);
    mcpMutation = await mergeIntoMcpFile(paths.mcpPath, plan, true);
    instructionsMutation = await uninstallClaudeInstructions(paths.instructionsPath);
  } else {
    await copyHooks(adaptersDir, paths.hooksDir);
    settingsMutation = await mergeIntoSettingsFile(
      paths.settingsPath,
      plan.scope === "global" ? globalSettings(paths.hooksDir, plan.activation) : localSettings(plan.activation),
    );
    mcpMutation = await mergeIntoMcpFile(paths.mcpPath, plan);
    instructionsMutation = await appendClaudeInstructions(paths.instructionsPath, plan.activation);
  }

  const mutation = summarizeMutations([settingsMutation, mcpMutation, instructionsMutation]);

  return {
    success: true,
    data: {
      ...plan,
      operation: request.uninstall ? "uninstall" : "install",
      mutation,
      hooksDir: paths.hooksDir,
      settingsPath: paths.settingsPath,
      mcpPath: paths.mcpPath,
      instructionsPath: paths.instructionsPath,
    },
    warnings: plan.warnings,
  };
}

export async function runBridgeClaudeCodeGlobal(startDir: string, request: Omit<BridgeRequest, "target" | "startDir"> = {}) {
  return runBridgeClaudeCode(startDir, { ...request, scope: "global" });
}

export async function runBridgeGeneric(startDir: string, request: Omit<BridgeRequest, "target" | "startDir"> = {}) {
  const plan = await resolveBridgePlan({ ...request, target: "generic", startDir });
  const data = buildGenericInstallOutput(plan);
  if (request.uninstall) {
    data.instructions = [
      "Generic uninstall is manual: remove the `ori` MCP server entry from your client config.",
      ...data.instructions,
    ];
  }
  return {
    success: true,
    data: {
      ...data,
      operation: request.uninstall ? "uninstall" : "install",
      mutation: request.uninstall ? "manual" : "noop",
    },
    warnings: plan.warnings,
  };
}

export async function runBridgeCursor(startDir: string, request: Omit<BridgeRequest, "target" | "startDir"> = {}) {
  const plan = await resolveBridgePlan({ ...request, target: "cursor", startDir });
  const paths = plan.scope === "global" ? getCursorGlobalPaths() : getCursorProjectPaths(startDir);

  await fs.mkdir(path.dirname(paths.mcpPath), { recursive: true });
  const mcpMutation = await mergeIntoMcpFile(paths.mcpPath, plan, request.uninstall === true);

  const warnings = [...plan.warnings];
  if (!request.uninstall && plan.activation === "auto") {
    warnings.push(
      "Cursor adapter currently installs MCP config only. Auto activation still requires client-side startup instructions or prompts.",
    );
  }

  const instructions = [...plan.instructions];
  instructions.push(
    request.uninstall
      ? `Removed Ori MCP config from ${paths.mcpPath}.`
      : `Cursor MCP config written to ${paths.mcpPath}.`,
  );
  if (!request.uninstall && plan.activation === "auto") {
    instructions.push("If Cursor exposes a startup prompt or rules surface in your workflow, call `ori_orient` at session start there.");
  }

  return {
    success: true,
    data: {
      ...buildGenericInstallOutput({
        ...plan,
        instructions,
        warnings,
      }),
      operation: request.uninstall ? "uninstall" : "install",
      mutation: mcpMutation,
      mcpPath: paths.mcpPath,
    },
    warnings,
  };
}
