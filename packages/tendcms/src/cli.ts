#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadComponents } from "./components.ts";
import { ConfigError, checkNodeVersion } from "./config.ts";
import { appVersion } from "./paths.ts";
import { PlainError } from "./plain-error.ts";

// The commands themselves are in commands.ts, which needs the components in components.ts. So
// that those failing to load can be explained, nothing imported above may need them.

const HELP = `Tend ${appVersion}

Usage: tendcms <command>

Commands:
  start [--open]           Start Tend. It keeps running until you close the window or press Ctrl+C.
                           With --open, it also opens the site's admin in your browser.
  backup [file]            Save the site to a zip file: its content, uploads and sign-in secrets.
                           Keep it private. Tend can keep running while it's saved.
  restore <file>           Put the site back as it is in a backup. Close Tend first. The site
                           that was here is saved in the backups folder before it's replaced.
  doctor                   Check what Tend needs to run here, and say how to fix what's wrong.
  setup-code               Show the code that first-time setup asks for.
  reset-password <email>   Give an account a new password and sign it out everywhere.

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
  const [command, argument] = positionals;
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
