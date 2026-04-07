#!/usr/bin/env node
import { Command } from "commander";
import { getVersion } from "./core/version.js";
import { runInit, runInitInteractive } from "./cli/init.js";
import { runStatus } from "./cli/status.js";
import { runHealth } from "./cli/health.js";
import {
  runQueryBacklinks,
  runQueryDangling,
  runQueryOrphans,
  runQueryCrossProject,
  runQueryImportant,
  runQueryFading,
} from "./cli/query.js";
import { runValidate } from "./cli/validate.js";
import { runAdd } from "./cli/add.js";
import { runPromote } from "./cli/promote.js";
import { runArchive } from "./cli/archive.js";
import { runBridgeClaudeCode, runBridgeClaudeCodeGlobal, runBridgeCodex, runBridgeCursor, runBridgeGeneric, runBridgeHermes, runBridgeStatus } from "./cli/bridge.js";
import { runServeMcp } from "./cli/serve.js";
import { runQueryRanked, runQuerySimilar, runQueryWarmthAudit } from "./cli/search.js";
import { runIndexBuild, runIndexStatus } from "./cli/indexcmd.js";
import { runGraphMetrics, runGraphCommunities } from "./cli/graphcmd.js";
import { runPrune } from "./cli/prune.js";
import { runExplore } from "./cli/explore.js";
import {
  isTTY,
  displayStatus,
  displayHealth,
  displayQueryOrphans,
  displayQueryDangling,
  displayQueryBacklinks,
  displayQueryCrossProject,
  displayQueryImportant,
  displayQueryFading,
  displayQueryRanked,
  displayQuerySimilar,
  displayQueryWarmthAudit,
  displayValidate,
  displayAdd,
  displayPromote,
  displayArchive,
  displayIndexBuild,
  displayIndexStatus,
  displayGraphMetrics,
  displayGraphCommunities,
  displayPrune,
  displayExplore,
} from "./cli/display.js";

const program = new Command();

function assertBridgeScope(value: string | undefined): "project" | "global" | undefined {
  if (!value) return undefined;
  if (value !== "project" && value !== "global") {
    throw new Error(`Unknown bridge scope: ${value}`);
  }
  return value;
}

function assertBridgeActivation(value: string | undefined): "auto" | "manual" | undefined {
  if (!value) return undefined;
  if (value !== "auto" && value !== "manual") {
    throw new Error(`Unknown bridge activation: ${value}`);
  }
  return value;
}

program
  .name("ori")
  .description(
    "Ori Mnemos - markdown-native cognitive harness for persistent agent memory"
  )
  .version(getVersion());

program
  .command("init")
  .argument("[dir]", "target directory", ".")
  .option("--json", "output JSON only (skip interactive)")
  .action(async (dir: string, options: { json?: boolean }) => {
    const result = await runInitInteractive({ targetDir: dir, json: options.json });
    if (options.json || !process.stdout.isTTY) {
      console.log(JSON.stringify({ success: true, data: result, warnings: [] }));
    }
  });

program
  .command("status")
  .action(async () => {
    const result = await runStatus(process.cwd());
    if (isTTY) { displayStatus(result); }
    else { console.log(JSON.stringify(result)); }
  });

program
  .command("health")
  .action(async () => {
    const result = await runHealth(process.cwd());
    if (isTTY) { displayHealth(result); }
    else { console.log(JSON.stringify(result)); }
  });

program
  .command("query")
  .argument("<kind>", "orphans | dangling | backlinks | cross-project | ranked | similar | important | fading | warmth-audit")
  .argument("[note]", "note title for backlinks, query text for ranked/similar, or query filter for warmth-audit")
  .option("--limit <n>", "max results", "10")
  .option("--threshold <n>", "vitality threshold for fading", "0.3")
  .action(async (kind: string, note: string | undefined, options: { limit?: string; threshold?: string }) => {
    let result;
    switch (kind) {
      case "orphans":
        result = await runQueryOrphans(process.cwd());
        if (isTTY) { displayQueryOrphans(result); return; }
        break;
      case "dangling":
        result = await runQueryDangling(process.cwd());
        if (isTTY) { displayQueryDangling(result); return; }
        break;
      case "backlinks":
        if (!note) {
          throw new Error("backlinks requires a note title");
        }
        result = await runQueryBacklinks(process.cwd(), note);
        if (isTTY) { displayQueryBacklinks(result); return; }
        break;
      case "cross-project":
        result = await runQueryCrossProject(process.cwd());
        if (isTTY) { displayQueryCrossProject(result); return; }
        break;
      case "ranked":
        if (!note) {
          throw new Error("ranked requires a query text");
        }
        result = await runQueryRanked(process.cwd(), note);
        if (isTTY) { displayQueryRanked(result); return; }
        break;
      case "similar":
        if (!note) {
          throw new Error("similar requires a query text");
        }
        result = await runQuerySimilar(process.cwd(), note);
        if (isTTY) { displayQuerySimilar(result); return; }
        break;
      case "important":
        result = await runQueryImportant(process.cwd(), options.limit ? parseInt(options.limit, 10) : undefined);
        if (isTTY) { displayQueryImportant(result); return; }
        break;
      case "fading":
        result = await runQueryFading(process.cwd(), options.threshold ? parseFloat(options.threshold) : undefined);
        if (isTTY) { displayQueryFading(result); return; }
        break;
      case "warmth-audit":
        result = await runQueryWarmthAudit(
          process.cwd(),
          note,
          options.limit ? parseInt(options.limit, 10) : undefined,
        );
        if (isTTY) { displayQueryWarmthAudit(result); return; }
        break;
      default:
        throw new Error(`Unknown query kind: ${kind}`);
    }
    console.log(JSON.stringify(result));
  });

program
  .command("validate")
  .argument("<note>", "path to note")
  .action(async (note: string) => {
    const result = await runValidate({ notePath: note });
    if (isTTY) { displayValidate(result); }
    else { console.log(JSON.stringify(result)); }
  });

program
  .command("add")
  .argument("<title>", "note title")
  .option("-t, --type <type>", "note type", "insight")
  .action(async (title: string, options: { type: string }) => {
    const result = await runAdd({ startDir: process.cwd(), title, type: options.type });
    if (isTTY) { displayAdd(result); }
    else { console.log(JSON.stringify(result)); }
  });

program
  .command("promote")
  .argument("[note]", "inbox note filename or slug")
  .option("--all", "promote all inbox notes")
  .option("--dry-run", "preview without making changes")
  .option("--no-auto", "skip LLM enhancement even if configured")
  .option("-t, --type <type>", "override type classification")
  .option("-d, --description <desc>", "override description")
  .option("-l, --links <links...>", "additional wiki-links")
  .option("-p, --project <projects...>", "project tags")
  .action(
    async (
      note: string | undefined,
      options: {
        all?: boolean;
        dryRun?: boolean;
        noAuto?: boolean;
        type?: string;
        description?: string;
        links?: string[];
        project?: string[];
      }
    ) => {
      const result = await runPromote({
        startDir: process.cwd(),
        noteName: note,
        all: options.all,
        dryRun: options.dryRun,
        noAuto: options.noAuto,
        type: options.type,
        description: options.description,
        links: options.links,
        project: options.project,
      });
      if (isTTY) { displayPromote(result); }
      else { console.log(JSON.stringify(result)); }
    }
  );

program
  .command("archive")
  .option("--dry-run", "preview without making changes")
  .action(async (options: { dryRun?: boolean }) => {
    const result = await runArchive({
      startDir: process.cwd(),
      dryRun: options.dryRun,
    });
    if (isTTY) { displayArchive(result); }
    else { console.log(JSON.stringify(result)); }
  });

program
  .command("bridge")
  .argument("<target>", "claude-code | cursor | codex | hermes | generic | status")
  .option("--global", "legacy shorthand for --scope global")
  .option("--scope <scope>", "install scope: project | global")
  .option("--activation <activation>", "activation mode: auto | manual")
  .option("--vault <path>", "explicit vault path")
  .option("--uninstall", "remove Ori bridge config for this target/scope")
  .option("--json", "output JSON for install planning")
  .action(async (
    target: string,
    options: { global?: boolean; scope?: string; activation?: string; vault?: string; uninstall?: boolean; json?: boolean }
  ) => {
    if (target !== "claude-code" && target !== "cursor" && target !== "codex" && target !== "hermes" && target !== "generic" && target !== "status") {
      throw new Error(`Unknown bridge target: ${target}`);
    }

    if (target === "status") {
      const result = await runBridgeStatus(process.cwd());
      if (!options.json) {
        type ScopedInstall = {
          installed: boolean;
          activation: string | null;
          resolvedVault: string | null;
          configPaths: string[];
          details: string[];
        };
        type ScopedClientStatus = {
          project: ScopedInstall;
          global: ScopedInstall;
          active: { scope: string; activation: string | null; resolvedVault: string | null } | null;
        };
        type CodexStatus = ScopedInstall;
        const data = result.data as {
          precedence: string;
          instructions: string[];
          clients: Record<string, ScopedClientStatus | CodexStatus>;
        };

        console.log(`Precedence: ${data.precedence}`);
        for (const [client, status] of Object.entries(data.clients)) {
          console.log("");
          console.log(`Client: ${client}`);
          if (!("active" in status)) {
            const install = status as CodexStatus;
            console.log(`  global: ${install.installed ? "installed" : "not installed"}`);
            console.log(`    activation: ${install.activation ?? "n/a"}`);
            console.log(`    vault: ${install.resolvedVault ?? "(none encoded)"}`);
            console.log(`    checked: ${install.configPaths.join(", ")}`);
            for (const detail of install.details) {
            console.log(`    - ${detail}`);
            }
            continue;
          }
          const scoped = status as ScopedClientStatus;
          console.log(`  Active install: ${scoped.active ? scoped.active.scope : "none"}`);
          if (scoped.active) {
            console.log(`  Active activation: ${scoped.active.activation ?? "unknown"}`);
            console.log(`  Active vault: ${scoped.active.resolvedVault ?? "(runtime discovery)"}`);
          }
          for (const scope of ["project", "global"] as const) {
            const install = scoped[scope];
            console.log(`  ${scope}: ${install.installed ? "installed" : "not installed"}`);
            console.log(`    activation: ${install.activation ?? "n/a"}`);
            console.log(`    vault: ${install.resolvedVault ?? "(none encoded)"}`);
            console.log(`    checked: ${install.configPaths.join(", ")}`);
            for (const detail of install.details) {
              console.log(`    - ${detail}`);
            }
          }
        }
        if (data.instructions.length > 0) {
          console.log("");
          console.log("Notes:");
          for (const instruction of data.instructions) {
            console.log(`- ${instruction}`);
          }
        }
        return;
      }

      console.log(JSON.stringify(result));
      return;
    }

    const request = {
      global: options.global,
      scope: assertBridgeScope(options.scope),
      activation: assertBridgeActivation(options.activation),
      vault: options.vault,
      uninstall: options.uninstall,
    };

    const result = target === "claude-code"
      ? options.global
        ? await runBridgeClaudeCodeGlobal(process.cwd(), request)
        : await runBridgeClaudeCode(process.cwd(), request)
      : target === "cursor"
        ? await runBridgeCursor(process.cwd(), request)
      : target === "codex"
        ? await runBridgeCodex(process.cwd(), request)
      : target === "hermes"
        ? await runBridgeHermes(process.cwd(), request)
      : await runBridgeGeneric(process.cwd(), request);

    if ((target === "generic" || target === "cursor" || target === "codex" || target === "hermes") && !options.json) {
      const data = result.data as {
        client: string;
        operation?: string;
        mutation?: string;
        command: string;
        args: string[];
        env: Record<string, string>;
        scope: string;
        activation: string;
        resolvedVault: string | null;
        instructions: string[];
        mcpPath?: string;
        configPath?: string;
      };

      console.log(`Client: ${data.client === "generic" ? "generic MCP client" : data.client}`);
      if (data.operation) {
        console.log(`Operation: ${data.operation}`);
      }
      if (data.mutation) {
        console.log(`Result: ${data.mutation}`);
      }
      console.log(`Scope: ${data.scope}`);
      console.log(`Activation: ${data.activation}`);
      console.log(`Resolved vault: ${data.resolvedVault ?? "(runtime discovery)"}`);
      if (data.mcpPath) {
        console.log(`MCP config path: ${data.mcpPath}`);
      }
      if (data.configPath) {
        console.log(`Config path: ${data.configPath}`);
      }
      console.log("");
      console.log("Server config:");
      console.log(`  command: ${data.command}`);
      console.log(`  args: ${JSON.stringify(data.args)}`);
      console.log(`  env: ${JSON.stringify(data.env)}`);
      if (data.instructions.length > 0) {
        console.log("");
        console.log("Instructions:");
        for (const instruction of data.instructions) {
          console.log(`- ${instruction}`);
        }
      }
      return;
    }

    console.log(JSON.stringify(result));
  });

program
  .command("serve")
  .option("--mcp", "run MCP server")
  .option("--vault <path>", "explicit vault root path")
  .action(async (options: { mcp?: boolean; vault?: string }) => {
    if (!options.mcp) {
      throw new Error("Only MCP server is supported: use --mcp");
    }
    await runServeMcp(process.cwd(), options.vault);
  });

program
  .command("index")
  .argument("<action>", "build | status")
  .option("--force", "rebuild all embeddings")
  .action(async (action: string, options: { force?: boolean }) => {
    let result;
    switch (action) {
      case "build":
        result = await runIndexBuild(process.cwd(), options.force);
        if (isTTY) { displayIndexBuild(result); return; }
        break;
      case "status":
        result = await runIndexStatus(process.cwd());
        if (isTTY) { displayIndexStatus(result); return; }
        break;
      default:
        throw new Error(`Unknown index action: ${action}`);
    }
    console.log(JSON.stringify(result));
  });

program
  .command("graph")
  .argument("<action>", "metrics | communities")
  .action(async (action: string) => {
    let result;
    switch (action) {
      case "metrics":
        result = await runGraphMetrics(process.cwd());
        if (isTTY) { displayGraphMetrics(result); return; }
        break;
      case "communities":
        result = await runGraphCommunities(process.cwd());
        if (isTTY) { displayGraphCommunities(result); return; }
        break;
      default:
        throw new Error(`Unknown graph action: ${action}`);
    }
    console.log(JSON.stringify(result));
  });

program
  .command("prune")
  .option("--apply", "actually archive candidates (default: dry-run)")
  .option("--verbose", "show full activation topology")
  .action(async (options: { apply?: boolean; verbose?: boolean }) => {
    const result = await runPrune({
      startDir: process.cwd(),
      dryRun: !options.apply,
      verbose: options.verbose,
    });
    if (isTTY) { displayPrune(result); }
    else { console.log(JSON.stringify(result)); }
  });

program
  .command("explore")
  .argument("<query>", "natural language query to explore")
  .option("--limit <n>", "max notes to return (default 15)")
  .option("--depth <n>", "1=shallow, 2=standard, 3=deep (default 2)")
  .option("--no-recursive", "disable recursive sub-question decomposition")
  .option("--include-archived", "include archived notes")
  .action(async (query: string, options: { limit?: string; depth?: string; recursive?: boolean; includeArchived?: boolean }) => {
    const result = await runExplore(
      process.cwd(),
      query,
      {
        limit: options.limit ? parseInt(options.limit, 10) : undefined,
        depth: options.depth ? parseInt(options.depth, 10) : undefined,
        recursive: options.recursive,
        excludeArchived: options.includeArchived ? false : true,
      },
    );
    if (isTTY) { displayExplore(result); }
    else { console.log(JSON.stringify(result)); }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(String(err));
  process.exit(1);
});
