/**
 * Ori interactive REPL — the default experience when you just type `ori`.
 * Parchment screen, vault snapshot, live explore prompt.
 */

import readline from "node:readline";
import chalk from "chalk";
import { getVersion } from "../core/version.js";
import { enterParchment, exitParchment } from "./screen.js";
import { runStatus } from "./status.js";
import { runHealth } from "./health.js";
import { runExplore } from "./explore.js";
import {
  displayStatus,
  displayHealth,
  displayExplore,
  isTTY,
} from "./display.js";

const cream = chalk.ansi256(230);
const gold = chalk.ansi256(178);
const dim = chalk.ansi256(137);
const gray = chalk.ansi256(242);

function banner(version: string, vaultRoot: string): void {
  const w = process.stdout.columns ?? 80;
  const line = "─".repeat(Math.min(w, 72));

  process.stdout.write("\n");
  process.stdout.write(`  ${gold("ORI MNEMOS")}  ${dim(`v${version}`)}\n`);
  process.stdout.write(`  ${dim(vaultRoot)}\n`);
  process.stdout.write(`\n  ${dim(line)}\n`);
}

function hint(): void {
  process.stdout.write(
    `\n  ${dim("query  status  health  help  quit")}\n\n`,
  );
}

function showHelp(): void {
  process.stdout.write("\n");
  process.stdout.write(`  ${gold("Commands")}\n\n`);
  process.stdout.write(`    ${cream("<query>")}   ${dim("explore the vault with natural language")}\n`);
  process.stdout.write(`    ${cream("status")}    ${dim("vault overview")}\n`);
  process.stdout.write(`    ${cream("health")}    ${dim("orphans, dangling links, schema violations")}\n`);
  process.stdout.write(`    ${cream("help")}      ${dim("show this")}\n`);
  process.stdout.write(`    ${cream("quit")}      ${dim("exit")}\n`);
  process.stdout.write("\n");
}

export async function runRepl(startDir: string): Promise<void> {
  if (!isTTY) {
    // Non-interactive context (pipe, MCP) — just show help and exit cleanly
    process.stdout.write("Ori Mnemos — run with a subcommand or --help\n");
    return;
  }

  enterParchment();

  const version = getVersion();

  // Load vault status for the splash
  const statusResult = await runStatus(startDir);
  const d = statusResult.data as {
    vaultRoot: string;
    noteCount: number;
    inboxCount: number;
    orphanCount: number;
  };

  banner(version, d.vaultRoot);
  displayStatus(statusResult);
  hint();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `  ${gold("›")} `,
    terminal: true,
  });

  rl.prompt();

  rl.on("line", async (line: string) => {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    switch (input.toLowerCase()) {
      case "quit":
      case "exit":
      case "q":
        rl.close();
        return;

      case "status":
        displayStatus(await runStatus(startDir));
        break;

      case "health":
        displayHealth(await runHealth(startDir));
        break;

      case "help":
        showHelp();
        break;

      default:
        // Treat as a natural language explore query
        try {
          const result = await runExplore(startDir, input, { depth: 2 });
          displayExplore(result);
        } catch (err) {
          process.stdout.write(
            `\n  ${chalk.ansi256(173)("x")} ${cream(String(err))}\n\n`,
          );
        }
        break;
    }

    rl.prompt();
  });

  rl.on("close", () => {
    exitParchment();
    process.stdout.write("\n");
    process.exit(0);
  });

  // Keep process alive while rl is open
  await new Promise<void>((resolve) => {
    rl.on("close", resolve);
  });
}
