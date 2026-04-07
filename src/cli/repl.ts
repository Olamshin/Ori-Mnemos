/**
 * Ori interactive REPL — the default experience when you just type `ori`.
 * Like Claude Code: drop straight into the prompt. Everything you type is a query.
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

function banner(version: string, vaultRoot: string, noteCount: number, inboxCount: number): void {
  process.stdout.write("\n");
  process.stdout.write(`  ${gold("ORI MNEMOS")}  ${dim(`v${version}`)}\n`);
  process.stdout.write(`  ${dim(vaultRoot)}  ${dim("·")}  ${cream(String(noteCount))} ${dim("notes")}  ${cream(String(inboxCount))} ${dim("inbox")}\n`);
  process.stdout.write("\n");
}

export async function runRepl(startDir: string): Promise<void> {
  if (!isTTY) {
    process.stdout.write("Ori Mnemos — run with a subcommand or --help\n");
    return;
  }

  enterParchment();

  const version = getVersion();

  // Quick vault snapshot for the one-line banner
  const statusResult = await runStatus(startDir);
  const d = statusResult.data as {
    vaultRoot: string;
    noteCount: number;
    inboxCount: number;
    orphanCount: number;
  };

  banner(version, d.vaultRoot, d.noteCount, d.inboxCount);

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

    // Slash commands for utility — everything else is a query
    switch (input.toLowerCase()) {
      case "/quit":
      case "/exit":
      case "/q":
        rl.close();
        return;

      case "/status":
        displayStatus(await runStatus(startDir));
        break;

      case "/health":
        displayHealth(await runHealth(startDir));
        break;

      case "/help":
        process.stdout.write("\n");
        process.stdout.write(`  ${dim("Type anything to explore your vault.")}\n`);
        process.stdout.write(`  ${dim("/status  /health  /quit")}\n`);
        process.stdout.write("\n");
        break;

      default:
        // Everything is an explore query — that's the point
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

  await new Promise<void>((resolve) => {
    rl.on("close", resolve);
  });
}
