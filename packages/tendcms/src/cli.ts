#!/usr/bin/env node
import { createWriteStream, existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { constants } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { generatePassword, hashPassword } from "./auth/passwords.ts";
import { displaySetupCode } from "./auth/setup-code.ts";
import { backupFileName } from "./backups/format.ts";
import { BackupError, checkBackup, restoreBackup } from "./backups/restore.ts";
import { takeDailySnapshot } from "./backups/snapshots.ts";
import { writeBackup } from "./backups/write.ts";
import {
  type Config,
  ConfigError,
  checkNodeVersion,
  ensureSecretKey,
  explainDataFolderFailure,
  loadConfig,
  portsToTry,
  prepareDataDir,
  readSecretKey,
  tightenPrivateFiles,
} from "./config.ts";
import { cleanUp } from "./content/entries.ts";
import { rerenderPublished } from "./content/rerender.ts";
import { createOrm, openDatabase, type SqliteDatabase } from "./db/client.ts";
import { acquireLock, type Lock, LockError } from "./db/lock.ts";
import { MigrationError, migrate, SNAPSHOT_TMP_PREFIX, schemaIsCurrent } from "./db/migrate.ts";
import { getSetting } from "./db/repo/settings.ts";
import {
  findUserByEmail,
  listUsers,
  ownerExists,
  resetPasswordAndSignOutEverywhere,
} from "./db/repo/users.ts";
import { fsyncFile } from "./durable.ts";
import { type Listening, listen, localUrl } from "./listen.ts";
import { cleanUpMedia } from "./media/library.ts";
import { MediaStore } from "./media/store.ts";
import { adminDir, appVersion, defaultThemeDir, migrationsDir } from "./paths.ts";
import { createApp } from "./server.ts";

const HELP = `Tend ${appVersion}

Usage: tendcms <command>

Commands:
  start                    Start Tend. It keeps running until you close the window or press Ctrl+C.
  backup [file]            Save the site to a zip file: its content, uploads and sign-in secrets.
                           Keep it private. Tend can keep running while it's saved.
  restore <file>           Put the site back as it is in a backup. Close Tend first. The site
                           that was here is saved in the backups folder before it's replaced.
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
  const [command, argument] = positionals;
  if (values.help || command === undefined) return console.log(HELP);

  checkNodeVersion();
  // Everything Tend creates from here on is private to this account: database, backups, key.
  process.umask(0o077);
  switch (command) {
    case "start":
      return start();
    case "backup":
      return backup(argument);
    case "restore":
      return restore(argument);
    case "setup-code":
      return showSetupCode();
    case "reset-password":
      return resetPassword(argument);
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
    tightenPrivateFiles(config);
    return lock;
  } catch (error) {
    lock?.release();
    if (error instanceof LockError || error instanceof ConfigError) throw error;
    throw explainDataFolderFailure(config.dataDir, error);
  }
}

/** For commands that run beside the server: never creates a site, only uses one that exists. */
function openExistingDatabase(config: Config): SqliteDatabase {
  if (!existsSync(config.dbPath)) {
    throw new ConfigError(
      `There's no site in ${config.dataDir} yet. Start Tend first, or run this from your site's folder.`,
    );
  }
  const db = openDatabase(config.dbPath);
  if (!schemaIsCurrent(db, migrationsDir)) {
    db.close();
    throw new ConfigError(
      "Start Tend once so it can update this site's data, then run this again.",
    );
  }
  return db;
}

async function showSetupCode(): Promise<void> {
  const config = loadConfig();
  if (config.setupPassword !== undefined) {
    console.log("This copy of Tend uses the setup password you chose when you created it.");
    return;
  }
  const db = openExistingDatabase(config);
  try {
    if (await ownerExists(createOrm(db))) {
      console.log("This site is already set up, so there's no setup code any more.");
      return;
    }
  } finally {
    db.close();
  }
  console.log(displaySetupCode(readSecretKey(config)));
}

async function resetPassword(email: string | undefined): Promise<void> {
  if (!email) {
    throw new ConfigError("Say which account, for example: tendcms reset-password you@example.com");
  }
  const db = openExistingDatabase(loadConfig());
  try {
    const orm = createOrm(db);
    const user = await findUserByEmail(orm, email.trim().toLowerCase());
    if (!user) {
      // Whoever can run this can already read the database, and with no email check at
      // setup, a typo here would otherwise be a dead end.
      const accounts = (await listUsers(orm))
        .map((account) => `${account.email}${account.isOwner ? " (Owner)" : ""}`)
        .join(", ");
      throw new ConfigError(
        `No account uses ${email}. Accounts on this site: ${accounts}. Run this again with one of them.`,
      );
    }

    const password = generatePassword();
    await resetPasswordAndSignOutEverywhere(orm, user.id, await hashPassword(password), Date.now());
    console.log(`New password for ${user.email}: ${password}`);
    console.log("It won't be shown again, and this account has been signed out everywhere.");
  } finally {
    db.close();
  }
}

/** Saves the site to a zip file, beside a running Tend or not (PLAN.md §13). */
async function backup(file: string | undefined): Promise<void> {
  const config = loadConfig();
  const db = openExistingDatabase(config);
  try {
    const site = (await getSetting(createOrm(db), "site"))?.name ?? "Tend";
    const now = new Date();
    const target = resolve(file ?? backupFileName(site, now));
    // Only a finished file gets the real name, so a backup cut short can't pass for one.
    const partial = `${target}.partial`;
    try {
      const manifest = await writeBackup(
        {
          db,
          backupsDir: config.backupsDir,
          uploadsDir: config.uploadsDir,
          secretKey: readSecretKey(config),
          appVersion,
          site,
        },
        createWriteStream(partial),
        now,
      );
      fsyncFile(partial);
      renameSync(partial, target);
      const uploads = manifest.files.filter((each) => each.path.startsWith("uploads/")).length;
      console.log(
        `Saved ${site}, with ${uploads === 1 ? "1 uploaded file" : `${uploads} uploaded files`}, to ${target}`,
      );
      console.log("It holds the site's sign-in secrets, so keep it private.");
    } catch (error) {
      rmSync(partial, { force: true });
      throw error;
    }
  } finally {
    db.close();
  }
}

/** Puts a site back from a backup zip, once every part of it has been checked. */
async function restore(file: string | undefined): Promise<void> {
  if (!file) {
    throw new ConfigError(
      "Say which backup to restore, for example: tendcms restore rise-bakery-backup-PRIVATE-2027-11-21.zip",
    );
  }
  const zipPath = resolve(file);
  if (!existsSync(zipPath)) throw new ConfigError(`There's no file at ${zipPath}.`);
  const config = loadConfig();
  const lock = takeDataFolder(config);
  const folder = join(config.backupsDir, `${SNAPSHOT_TMP_PREFIX}restore-${Date.now()}`);
  try {
    const newestSchema = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).length;
    const checked = await checkBackup(zipPath, folder, newestSchema);
    const { snapshotPath } = await restoreBackup(checked, config);
    const { site, createdAt } = checked.manifest;
    console.log(`Restored ${site} as it was on ${createdAt.slice(0, 10)}. Start Tend to see it.`);
    if (snapshotPath) console.log(`The site that was here before is saved in ${snapshotPath}.`);
  } finally {
    rmSync(folder, { recursive: true, force: true });
    lock.release();
  }
}

const HOUR_MS = 60 * 60 * 1000;
const SNAPSHOT_CHECK_MS = 10 * 60 * 1000;

async function start(): Promise<void> {
  const config = loadConfig();
  const lock = takeDataFolder(config);
  process.on("exit", () => lock.release());

  // Registered before any slow work: closing the window is the normal way to stop
  // Tend, and it can happen while a snapshot is being written.
  let listening: Listening | undefined;
  let db: SqliteDatabase | undefined;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
    const number = constants.signals[signal];
    if (number === undefined) continue;
    process.once(signal, () => {
      listening?.close();
      db?.close();
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

  db = openDatabase(config.dbPath);
  const orm = createOrm(db);
  // Published pages are stored as HTML. If this Tend renders them differently, they're
  // brought up to date before anyone is answered (PLAN.md §8). Not managing it is no reason
  // to stop: each page still has the HTML it was published with.
  try {
    const { rendered, failed } = await rerenderPublished(orm);
    if (rendered > 0) console.log(`Updated ${rendered} published pages for this version of Tend.`);
    if (failed > 0)
      console.error(`Couldn't update ${failed} published pages; they look as they did.`);
  } catch (error) {
    console.error(`Couldn't update published pages: ${(error as Error).message}`);
  }
  const secretKey = readSecretKey(config);
  const app = createApp({
    version: appVersion,
    adminDir,
    adminDevUrl: config.adminDevUrl,
    publicUrl: config.publicUrl,
    orm,
    secretKey,
    setupPassword: config.setupPassword,
    secureCookies: config.secureCookies,
    trustProxy: config.trustProxy,
    themeDir: defaultThemeDir,
    uploadsDir: config.uploadsDir,
    backupsDir: config.backupsDir,
    pageCacheBytes: config.pageCacheBytes,
    watchTheme: true,
    siteUrl: config.siteUrl,
    isPublic: config.isPublic,
  });
  // The Trash and automatic history only keep things for so long. Not being able to tidy
  // up is no reason to stop serving the site.
  const files = new MediaStore(config.uploadsDir);
  const tidyUp = () => {
    try {
      cleanUp(orm, Date.now());
    } catch (error) {
      console.error(`Couldn't tidy up old drafts: ${(error as Error).message}`);
    }
    // Media's Trash after 30 days, except what a published page still shows.
    cleanUpMedia(orm, files, Date.now()).catch((error: Error) =>
      console.error(`Couldn't empty Media's Trash: ${error.message}`),
    );
  };
  tidyUp();
  setInterval(tidyUp, HOUR_MS).unref();

  // A copy of the site's data each day at 03:00 its time (PLAN.md §13). Looked at often, so
  // it's made soon after, and soon after Tend starts if it wasn't running then.
  const openDb = db;
  let snapshotting = false;
  const snapshotIfDue = async () => {
    if (snapshotting) return;
    snapshotting = true;
    try {
      // Until setup, there's no site to keep a copy of.
      const site = await getSetting(orm, "site");
      if (!site) return;
      const made = await takeDailySnapshot({
        db: openDb,
        dbPath: config.dbPath,
        backupsDir: config.backupsDir,
        timeZone: site.timezone,
        now: Date.now(),
      });
      if (made) console.log(`Saved today's copy of the site's data: ${made.id}.db.gz`);
    } catch (error) {
      console.error(`Couldn't save today's copy of the site's data: ${(error as Error).message}`);
    } finally {
      snapshotting = false;
    }
  };
  void snapshotIfDue();
  setInterval(() => void snapshotIfDue(), SNAPSHOT_CHECK_MS).unref();

  const ports = portsToTry(config);
  listening = await listen(app.fetch, ports, config.hosts);
  const { port } = listening;

  if (ports[0] !== 0 && port !== ports[0]) {
    console.log(`Port ${ports[0]} is busy, so Tend is using ${port}.`);
  }
  const needsSetup = !(await ownerExists(orm));
  // The code goes in the fragment, which browsers never send to the server, so it
  // stays out of request logs and Referer headers.
  const setupCode = needsSetup && config.setupPassword === undefined;
  if (config.platform === "local") {
    const base = config.publicUrl ?? localUrl(config.hosts, port);
    let link = `${base}/admin/`;
    if (needsSetup) link = `${base}/admin/setup`;
    if (setupCode) link += `#code=${displaySetupCode(secretKey)}`;
    console.log(`\nTend ${appVersion} is running: ${link}`);
    if (setupCode) {
      console.log(`Setup code, if Tend asks for it: ${displaySetupCode(secretKey)}`);
    }
    console.log("Keep this window open. Tend stops when you close it.");
    // The development runner has its own way to start, so this would only mislead there.
    if (!config.adminDevUrl) console.log(`To start again: cd ${process.cwd()}, then npm start`);
    console.log();
  } else {
    console.log(`Tend ${appVersion} is listening on port ${port} (${config.platform}).`);
    if (setupCode) {
      console.log(
        `Open /admin/setup on your site and type this setup code: ${displaySetupCode(secretKey)}`,
      );
    } else if (needsSetup) {
      console.log("Open /admin/setup on your site and type the setup password you chose.");
    }
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (
    error instanceof ConfigError ||
    error instanceof LockError ||
    error instanceof MigrationError ||
    error instanceof BackupError
  ) {
    console.error(`\n${error.message}\n`);
  } else {
    console.error("Tend stopped because of an unexpected error:", error);
  }
  process.exit(1);
});
