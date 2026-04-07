/**
 * Ori default action — delegates to aries-cli if installed,
 * otherwise falls back to a minimal explore REPL.
 */

import { execFileSync } from "node:child_process";
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

/**
 * Try to launch aries-cli (the full Ink UI).
 * Returns true if it launched, false if not installed.
 */
function tryLaunchAries(args: string[]): boolean {
  try {
    // Check if @ori-memory/aries is resolvable
    const resolved = import.meta.resolve?.("@ori-memory/aries");
    if (!resolved) return false;
  } catch {
    // Not installed — fall through to REPL
    return false;
  }

  // Exec aries-cli, replacing this process
  try {
    execFileSync(process.execPath, [
      "--import", "tsx",
      ...args,
    ], { stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
}

export async function runRepl(startDir: string): Promise<void> {
  if (!isTTY) {
    process.stdout.write("Ori Mnemos — run with a subcommand or --help\n");
    return;
  }

  // Try to hand off to the full aries-cli UI
  // For now, look for it at the known dev path
  const ariesEntry = "C:/Users/aayoa/Desktop/aries-cli/src/index.ts";
  try {
    const { existsSync } = await import("node:fs");
    if (existsSync(ariesEntry)) {
      const { execSync } = await import("node:child_process");
      // Replace this process with aries-cli
      execSync(`npx tsx "${ariesEntry}"`, {
        stdio: "inherit",
        cwd: startDir,
        env: process.env,
      });
      process.exit(0);
    }
  } catch (err) {
    // aries-cli crashed or not available — fall through to minimal REPL
  }

  // Fallback: minimal explore REPL
  enterParchment();

  const version = getVersion();
  const statusResult = await runStatus(startDir);
  const d = statusResult.data as {
    vaultRoot: string;
    noteCount: number;
    inboxCount: number;
    orphanCount: number;
  };

  process.stdout.write("\n");
  process.stdout.write(`  ${gold("ORI MNEMOS")}  ${dim(`v${version}`)}\n`);
  process.stdout.write(`  ${dim(d.vaultRoot)}  ${dim("·")}  ${cream(String(d.noteCount))} ${dim("notes")}  ${cream(String(d.inboxCount))} ${dim("inbox")}\n`);
  process.stdout.write("\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `  ${gold("›")} `,
    terminal: true,
  });

  rl.prompt();

  rl.on("line", async (line: string) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    switch (input.toLowerCase()) {
      case "/quit": case "/exit": case "/q":
        rl.close(); return;
      case "/status":
        displayStatus(await runStatus(startDir)); break;
      case "/health":
        displayHealth(await runHealth(startDir)); break;
      case "/help":
        process.stdout.write(`\n  ${dim("Type anything to explore your vault.")}\n  ${dim("/status  /health  /quit")}\n\n`);
        break;
      default:
        try {
          const result = await runExplore(startDir, input, { depth: 2 });
          displayExplore(result);
        } catch (err) {
          process.stdout.write(`\n  ${chalk.ansi256(173)("x")} ${cream(String(err))}\n\n`);
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

  await new Promise<void>((resolve) => { rl.on("close", resolve); });
}
