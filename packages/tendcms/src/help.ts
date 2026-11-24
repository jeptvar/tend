import { appVersion } from "./paths.ts";

/** What `tendcms --help` says. */
export const HELP = `Tend ${appVersion}

Usage: tendcms <command>

Commands:
  start [--open]           Start Tend. It keeps running until you close the window or press Ctrl+C.
                           With --open, it also opens the site's admin in your browser.
  backup [file]            Save the site to a zip file: its content, uploads and sign-in secrets.
                           Keep it private. Tend can keep running while it's saved.
  restore <file>           Put the site back as it is in a backup, or in a copy Tend kept. Close
                           Tend first. The site that was here is saved before it's replaced.
  theme copy <from> <to>   Start a theme of your own from a copy of another. Tend comes with meadow.
  doctor                   Check what Tend needs to run here, and say how to fix what's wrong.
  setup-code               Show the code that first-time setup asks for.
  reset-password <email>   Give an account a new password and sign it out everywhere.

Options:
  -h, --help       Show this help
  -v, --version    Show the version`;
