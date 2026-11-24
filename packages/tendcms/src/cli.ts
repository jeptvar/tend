#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadComponents } from "./components.ts";
import { ConfigError, checkNodeVersion } from "./config.ts";
import { HELP } from "./help.ts";
import { appVersion } from "./paths.ts";
import { PlainError } from "./plain-error.ts";

// The commands themselves are in commands.ts, which needs the components in components.ts. So
// that those failing to load can be explained, nothing imported above may need them.

function parseCommandLine(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        open: { type: "boolean" },
      },
    });
  } catch (error) {
    if (!String((error as NodeJS.ErrnoException).code).startsWith("ERR_PARSE_ARGS_")) throw error;
    throw new ConfigError(
      `That isn't a Tend option. To use another port, set PORT (for example PORT=4000 npm start).\n\n${HELP}`,
    );
  }
}

async function loadCommands() {
  await loadComponents();
  return import("./commands.ts");
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseCommandLine(argv);
  if (values.version) return console.log(appVersion);
  const [command, ...rest] = positionals;
  const [argument] = rest;
  if (values.help || command === undefined) return console.log(HELP);

  checkNodeVersion();
  // Everything Tend creates from here on is private to this account: database, backups, key.
  process.umask(0o077);
  switch (command) {
    case "start":
      return (await loadCommands()).start({ open: values.open === true });
    case "backup":
      return (await loadCommands()).backup(argument);
    case "restore":
      return (await loadCommands()).restore(argument);
    case "theme":
      return (await loadCommands()).theme(rest);
    // Not through loadCommands: it says what's wrong with components that don't load.
    case "doctor":
      return (await import("./doctor.ts")).doctor();
    case "setup-code":
      return (await loadCommands()).showSetupCode();
    case "reset-password":
      return (await loadCommands()).resetPassword(argument);
    default:
      throw new ConfigError(`"${command}" isn't a Tend command.\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof PlainError) console.error(`\n${error.message}\n`);
  else console.error("Tend stopped because of an unexpected error:", error);
  process.exit(1);
});
