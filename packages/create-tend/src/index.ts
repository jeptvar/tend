#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  folderProblem,
  nodeProblem,
  packageName,
  projectFiles,
  releaseAgeDays,
  writeProject,
} from "./scaffold.ts";

// npm create tend@latest my-site (PLAN.md J1a): checks Node, asks at most one question (the
// folder), writes the site's files, installs Tend, starts it and opens the browser.

const USAGE = `Make a new Tend CMS site:

  npm create tend@latest my-site

Then, to start it again later: cd my-site, then npm start

Options:
  --no-start   Make the site and install Tend, but don't start it yet
  -h, --help   Show this help`;

const DEFAULT_FOLDER = "my-site";

/** This package's version, which is also the exact tendcms version it installs. */
function ownVersion(): string {
  const path = fileURLToPath(new URL("../package.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")).version;
}

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

/**
 * Runs npm. Through the npm that ran this, when there is one: no shell is needed then, on
 * any system.
 */
function npm(args: string[], cwd: string, capture = false) {
  const npmCli = process.env.npm_execpath;
  const options = { cwd, encoding: "utf8" as const, stdio: capture ? "pipe" : "inherit" } as const;
  if (npmCli && /npm-cli\.[cm]?js$/.test(npmCli)) {
    return spawnSync(process.execPath, [npmCli, ...args], options);
  }
  // Windows can only run npm.cmd through a shell. Nothing here comes from what was typed.
  return process.platform === "win32"
    ? spawnSync(`npm ${args.join(" ")}`, { ...options, shell: true })
    : spawnSync("npm", args, options);
}

async function askForFolder(): Promise<string> {
  if (!process.stdin.isTTY) return DEFAULT_FOLDER;
  const ask = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await ask.question(
      `What should your site's folder be called? (${DEFAULT_FOLDER}) `,
    );
    return answer.trim() || DEFAULT_FOLDER;
  } finally {
    ask.close();
  }
}

async function main(argv: string[]): Promise<void> {
  const flags = argv.filter((arg) => arg.startsWith("-"));
  if (flags.includes("-h") || flags.includes("--help")) return console.log(USAGE);
  const unknown = flags.find((flag) => flag !== "--no-start");
  if (unknown) fail(`"${unknown}" isn't something create-tend understands.\n\n${USAGE}`);

  const tooOld = nodeProblem(process.version);
  if (tooOld) fail(tooOld);

  const folder = argv.find((arg) => !arg.startsWith("-")) ?? (await askForFolder());
  const dir = resolve(folder);
  const shown = relative(process.cwd(), dir) || ".";
  const problem = folderProblem(dir);
  if (problem) fail(problem);

  // Tend's own tests install a tendcms they've just built.
  const tendcms = process.env.CREATE_TEND_TENDCMS || ownVersion();
  writeProject(dir, projectFiles({ name: packageName(dir), tendcms }));
  console.log(`\nMaking your site in ${shown}. Installing Tend…\n`);

  // Tend's packages run nothing as they install, so no other package can either.
  const install = ["install", "--ignore-scripts", "--no-audit", "--no-fund"];
  const waitDays = releaseAgeDays(
    String(npm(["config", "get", "min-release-age"], dir, true).stdout ?? ""),
  );
  if (waitDays > 0) {
    console.log(
      `You've set npm to wait ${waitDays} days before installing anything new. This version of Tend came out at the same time as this installer, so this one install doesn't wait. Everything under Tend is pinned to versions that are older.\n`,
    );
    install.push("--min-release-age=0");
  }
  const installed = npm(install, dir);
  if (installed.status !== 0) {
    fail(
      `npm couldn't install Tend. Check your internet connection, then run:\n\n  cd ${shown}\n  npm install\n  npm start`,
    );
  }

  if (argv.includes("--no-start")) {
    console.log(`\nYour site is ready. To start it:\n\n  cd ${shown}\n  npm start\n`);
    return;
  }
  console.log("\nStarting Tend…");
  const cli = resolve(dir, "node_modules", "tendcms", "dist", "cli.mjs");
  const tend = spawn(process.execPath, [cli, "start", "--open"], { cwd: dir, stdio: "inherit" });
  // Ctrl+C reaches Tend too, which closes cleanly. This only waits for it.
  process.on("SIGINT", () => {});
  tend.on("exit", (code) => process.exit(code ?? 0));
}

main(process.argv.slice(2)).catch((error: unknown) => {
  fail(`Something went wrong: ${error instanceof Error ? error.message : String(error)}`);
});
