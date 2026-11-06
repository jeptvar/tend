#!/usr/bin/env node
import { constants } from "node:os";
import { parseArgs } from "node:util";
import {
  type Config,
  ConfigError,
  checkNodeVersion,
  ensureSecretKey,
  explainDataFolderFailure,
  loadConfig,
  portsToTry,
  prepareDataDir,
} from "./config.ts";
import { acquireLock, type Lock, LockError } from "./db/lock.ts";
import { MigrationError, migrate } from "./db/migrate.ts";
import { type Listening, listen, localUrl } from "./listen.ts";
import { adminDir, appVersion, migrationsDir } from "./paths.ts";
import { createApp } from "./server.ts";

const HELP = `Tend ${appVersion}

Usage: tendcms <command>

Commands:
  start    Start Tend. It keeps running until you close the window or press Ctrl+C.

Options:
  -h, --help       Show this help
  -v, --version    Show the version`;

function parseCommandLine(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    if (!String((error as NodeJS.ErrnoException).code).startsWith("ERR_PARSE_ARGS_")) throw error;
    throw new ConfigError(
      `That isn't a Tend option. To use another port, set PORT (for example PORT=4000 npm start).\n\n${HELP}`,
    );
  }
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseCommandLine(argv);
  if (values.version) return console.log(appVersion);
  const [command] = positionals;
  if (values.help || command === undefined) return console.log(HELP);

  switch (command) {
    case "start":
      return start();
    default:
      throw new ConfigError(`"${command}" isn't a Tend command.\n\n${HELP}`);
  }
}

function takeDataFolder(config: Config): Lock {
  prepareDataDir(config);
  let lock: Lock | undefined;
  try {
    lock = acquireLock(config.dataDir);
    ensureSecretKey(config);
    return lock;
  } catch (error) {
    lock?.release();
    if (error instanceof LockError || error instanceof ConfigError) throw error;
    throw explainDataFolderFailure(config.dataDir, error);
  }
}

async function start(): Promise<void> {
  checkNodeVersion();
  const config = loadConfig();
  const lock = takeDataFolder(config);
  process.on("exit", () => lock.release());

  // Registered before any slow work: closing the window is the normal way to stop
  // Tend, and it can happen while a snapshot is being written.
  let listening: Listening | undefined;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
    const number = constants.signals[signal];
    if (number === undefined) continue;
    process.once(signal, () => {
      listening?.close();
      lock.release();
      process.exit(listening ? 0 : 128 + number);
    });
  }

  try {
    await migrate({
      dbPath: config.dbPath,
      backupsDir: config.backupsDir,
      migrationsDir,
      appVersion,
    });
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError(
      `The database update stopped. Nothing in your site changed. (${(error as Error).message})`,
      { cause: error },
    );
  }

  const app = createApp({ version: appVersion, adminDir, adminDevUrl: config.adminDevUrl });
  const ports = portsToTry(config);
  listening = await listen(app.fetch, ports, config.hosts);
  const { port } = listening;

  if (ports[0] !== 0 && port !== ports[0]) {
    console.log(`Port ${ports[0]} is busy, so Tend is using ${port}.`);
  }
  if (config.platform === "local") {
    const setupUrl = `${localUrl(config.hosts, port)}/admin/setup`;
    console.log(`\nTend ${appVersion} is running: ${setupUrl}`);
    console.log("Keep this window open. Tend stops when you close it. To start again: npm start\n");
  } else {
    console.log(`Tend ${appVersion} is listening on port ${port} (${config.platform}).`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (
    error instanceof ConfigError ||
    error instanceof LockError ||
    error instanceof MigrationError
  ) {
    console.error(`\n${error.message}\n`);
  } else {
    console.error("Tend stopped because of an unexpected error:", error);
  }
  process.exit(1);
});
