import { createWriteStream, existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { constants } from "node:os";
import { join, resolve } from "node:path";
import { generatePassword, hashPassword } from "./auth/passwords.ts";
import { displaySetupCode } from "./auth/setup-code.ts";
import { backupFileName } from "./backups/format.ts";
import { checkBackup, checkCopy, isCopy, restoreBackup } from "./backups/restore.ts";
import { takeDailySnapshot } from "./backups/snapshots.ts";
import { writeBackup } from "./backups/write.ts";
import { componentError, PICTURES } from "./components.ts";
import {
  type Config,
  ConfigError,
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
import { damagedDatabase, isDamage } from "./db/damage.ts";
import { acquireLock, type Lock, LockError } from "./db/lock.ts";
import { MigrationError, migrate, SNAPSHOT_TMP_PREFIX, schemaIsCurrent } from "./db/migrate.ts";
import { removeEndedSessions } from "./db/repo/sessions.ts";
import { getSetting } from "./db/repo/settings.ts";
import { removeOldTokens } from "./db/repo/tokens.ts";
import {
  findUserByEmail,
  listUsers,
  ownerExists,
  resetPasswordAndSignOutEverywhere,
} from "./db/repo/users.ts";
import { diskSpace, isNearlyFull } from "./disk.ts";
import { fsyncFile } from "./durable.ts";
import { type Listening, listen, localUrl } from "./listen.ts";
import { cleanUpMedia, removeRetiredOriginals } from "./media/library.ts";
import { pictureError } from "./media/process.ts";
import { clearSizesIfLow, MediaStore } from "./media/store.ts";
import { openInBrowser } from "./open-browser.ts";
import { adminDir, appVersion, defaultThemeDir, migrationsDir } from "./paths.ts";
import { createApp } from "./server.ts";
import { copyTheme } from "./theme-copy.ts";
import { dataRiskWarning, findDataRisk } from "./volume.ts";

// What each tendcms command does. cli.ts loads this once its components are known to load.

/** Takes the data folder over. Restoring a backup brings its own key, whatever's there now. */
function takeDataFolder(config: Config, options: { restoring?: boolean } = {}): Lock {
  prepareDataDir(config);
  let lock: Lock | undefined;
  try {
    lock = acquireLock(config.dataDir);
    if (!options.restoring) ensureSecretKey(config);
    tightenPrivateFiles(config);
    return lock;
  } catch (error) {
    lock?.release();
    if (error instanceof LockError || error instanceof ConfigError) throw error;
    throw explainDataFolderFailure(config.dataDir, error, config.platform);
  }
}

/** For commands that run beside the server: never creates a site, only uses one that exists. */
function openExistingDatabase(config: Config): SqliteDatabase {
  if (!existsSync(config.dbPath)) {
    throw new ConfigError(
      `There's no site in ${config.dataDir} yet. Start Tend first, or run this from your site's folder.`,
    );
  }
  let db: SqliteDatabase | undefined;
  let isCurrent: boolean;
  try {
    db = openDatabase(config.dbPath);
    isCurrent = schemaIsCurrent(db, migrationsDir);
  } catch (error) {
    db?.close();
    throw isDamage(error) ? damagedDatabase((error as Error).message) : error;
  }
  if (!isCurrent) {
    db.close();
    throw new ConfigError(
      "Start Tend once so it can update this site's data, then run this again.",
    );
  }
  return db;
}

export async function showSetupCode(): Promise<void> {
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

export async function resetPassword(email: string | undefined): Promise<void> {
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
export async function backup(file: string | undefined): Promise<void> {
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

/**
 * Puts a site back from a backup zip, or from one of the copies Tend keeps, once every part of
 * it has been checked.
 */
export async function restore(file: string | undefined): Promise<void> {
  if (!file) {
    throw new ConfigError(
      "Say which backup to restore, for example: tendcms restore rise-bakery-backup-PRIVATE-2027-11-21.zip",
    );
  }
  const zipPath = resolve(file);
  if (!existsSync(zipPath)) throw new ConfigError(`There's no file at ${zipPath}.`);
  const config = loadConfig();
  const lock = takeDataFolder(config, { restoring: true });
  const folder = join(config.backupsDir, `${SNAPSHOT_TMP_PREFIX}restore-${Date.now()}`);
  try {
    const newestSchema = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).length;
    let restored: { snapshotPath: string | undefined; wasDamaged: boolean };
    if (isCopy(zipPath)) {
      const checked = await checkCopy(zipPath, folder, newestSchema, config);
      restored = await restoreBackup(checked, config);
      console.log("Restored the site's data from this copy. Start Tend to see it.");
      console.log(
        "A copy holds everything but photos and files, which stay as they are in the uploads folder.",
      );
      if (checked.newKey) {
        console.log(
          "There was no key file here, so Tend made a new one. Recovery codes made before this don't work any more.",
        );
      }
    } else {
      const checked = await checkBackup(zipPath, folder, newestSchema);
      restored = await restoreBackup(checked, config);
      const { site, createdAt } = checked.manifest;
      console.log(`Restored ${site} as it was on ${createdAt.slice(0, 10)}. Start Tend to see it.`);
    }
    const { snapshotPath, wasDamaged } = restored;
    if (wasDamaged) {
      console.log(
        `The database that was here was damaged. It's kept as it was, in ${snapshotPath}.`,
      );
    } else if (snapshotPath) {
      console.log(`The site that was here before is saved in ${snapshotPath}.`);
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
    lock.release();
  }
}

/** Themes of people's own: for now, starting one from a copy of another. */
export async function theme([action, from, to]: string[]): Promise<void> {
  if (action !== "copy") {
    throw new ConfigError("Say what to do, for example: tendcms theme copy meadow my-theme");
  }
  const { themeFolders } = loadConfig();
  const copied = copyTheme({ from, to, bundledDir: defaultThemeDir, folders: themeFolders });
  console.log(`Copied ${copied.from} to ${copied.dir}`);
  console.log("Choose it in your site's admin, under Design, then change its files.");
}

const HOUR_MS = 60 * 60 * 1000;
const OPTIMIZE_EVERY_MS = 6 * HOUR_MS;
/** How long a request being answered has to finish once Tend is told to stop. */
const DRAIN_MS = 5000;

/** Puts everything from the log into the database itself, so the data folder can be copied. */
function closeDatabase(db: SqliteDatabase): void {
  try {
    db.pragma("optimize");
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
  } catch {
    // A copy of it may be being made. Nothing is lost: it's all in the log, for next time.
  }
}

// How often Tend looks at whether a daily copy is due, and whether the disk is nearly full.
const CHECK_EVERY_MS = 10 * 60 * 1000;

export async function start(options: { open: boolean } = { open: false }): Promise<void> {
  const config = loadConfig();
  const lock = takeDataFolder(config);
  process.on("exit", () => lock.release());

  // Registered before any slow work: closing the window is the normal way to stop
  // Tend, and it can happen while a snapshot is being written.
  let listening: Listening | undefined;
  let db: SqliteDatabase | undefined;
  let stopping = false;
  // Hosting platforms stop the old Tend as they start the new one (PLAN.md §13). Whatever is
  // being answered, a save say, gets a few seconds to finish.
  const stop = async (number: number) => {
    const code = listening ? 0 : 128 + number;
    // Asked again, by someone who doesn't want to wait.
    if (stopping) process.exit(code);
    stopping = true;
    await listening?.stop(DRAIN_MS);
    if (db) closeDatabase(db);
    lock.release();
    process.exit(code);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
    const number = constants.signals[signal];
    if (number !== undefined) process.on(signal, () => void stop(number));
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
    if (isDamage(error)) throw damagedDatabase((error as Error).message);
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
  const dataRisk = findDataRisk(config);
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
    themeFolders: config.themeFolders,
    showThemeMistakes: config.platform === "local" && !config.isPublic,
    platform: config.platform,
    uploadsDir: config.uploadsDir,
    backupsDir: config.backupsDir,
    dataFolder: config,
    pageCacheBytes: config.pageCacheBytes,
    watchTheme: true,
    platformUrl: config.platformUrl,
    dataRisk,
  });
  // The Trash and automatic history only keep things for so long. Not being able to tidy
  // up is no reason to stop serving the site.
  const files = new MediaStore(config.uploadsDir, config.backupsDir);
  const tidyUp = () => {
    try {
      cleanUp(orm, Date.now());
    } catch (error) {
      console.error(`Couldn't tidy up old drafts: ${(error as Error).message}`);
    }
    try {
      removeEndedSessions(orm, Date.now());
      removeOldTokens(orm, Date.now());
    } catch (error) {
      console.error(`Couldn't tidy up old sessions and links: ${(error as Error).message}`);
    }
    // Media's Trash after 30 days, except what a published page still shows.
    cleanUpMedia(orm, files, Date.now()).catch((error: Error) =>
      console.error(`Couldn't empty Media's Trash: ${error.message}`),
    );
  };
  tidyUp();
  setInterval(tidyUp, HOUR_MS).unref();

  // Lets SQLite look over tables whose contents have changed a lot, so it goes on choosing the
  // quick way to look things up. It does nothing when there's nothing to do (PLAN.md §11).
  const openDb = db;
  setInterval(() => {
    try {
      openDb.pragma("optimize");
    } catch (error) {
      console.error(`Couldn't look the database over: ${(error as Error).message}`);
    }
  }, OPTIMIZE_EVERY_MS).unref();

  // A copy of the site's data each day at 03:00 its time (PLAN.md §13). Looked at often, so
  // it's made soon after, and soon after Tend starts if it wasn't running then.
  let snapshotting = false;
  const snapshotIfDue = async () => {
    if (snapshotting) return;
    snapshotting = true;
    try {
      // Until setup, there's no site to keep a copy of.
      const site = await getSetting(orm, "site");
      if (!site) return;
      const made = await takeDailySnapshot({
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
  // When the disk is nearly full, picture sizes go first: they're made again as visitors ask
  // for them, and the room they free keeps the site's own changes saving (PLAN.md §13).
  // If that isn't enough, so do the originals of photos and files deleted lately, which
  // older copies of the site's data would otherwise show.
  const makeRoom = () => {
    try {
      const freed = clearSizesIfLow(files, diskSpace(config.dataDir));
      if (freed > 0) {
        const megabytes = Math.ceil(freed / (1024 * 1024));
        console.warn(
          `The disk is nearly full, so Tend cleared ${megabytes} MB of picture sizes. They're made again as visitors ask for them. Make more room soon: Settings → Backups shows how.`,
        );
      }
      if (isNearlyFull(diskSpace(config.dataDir))) {
        const removed = removeRetiredOriginals(orm, files, Date.now(), {
          evenIfCopiesShowThem: true,
        });
        if (removed > 0) {
          console.warn(
            `The disk is still nearly full, so Tend removed ${removed} deleted photos and files for good. Copies of the site saved before they were deleted will show them missing.`,
          );
        }
      }
    } catch (error) {
      console.error(`Couldn't make room on the disk: ${(error as Error).message}`);
    }
  };
  makeRoom();
  void snapshotIfDue();
  setInterval(() => {
    makeRoom();
    void snapshotIfDue();
  }, CHECK_EVERY_MS).unref();

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
    if (options.open) openInBrowser(link);
  } else {
    console.log(`Tend ${appVersion} is listening on port ${port} (${config.platform}).`);
    if (setupCode) {
      console.log(
        `Open /admin/setup on your site and type this setup code: ${displaySetupCode(secretKey)}`,
      );
    } else if (needsSetup) {
      console.log("Open /admin/setup on your site and type the setup password you chose.");
    }
    // Last, so it isn't buried under the rest.
    if (dataRisk) console.warn(dataRiskWarning(dataRisk, { needsSetup }));
  }
  if (pictureError) console.warn(`${componentError(PICTURES, pictureError).message}\n`);
}
