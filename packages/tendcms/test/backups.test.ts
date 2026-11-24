import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { unzipSync, zipSync } from "fflate";
import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { backupFileName } from "../src/backups/format.ts";
import { BackupError, checkBackup, restoreBackup } from "../src/backups/restore.ts";
import {
  dailySnapshotDue,
  snapshotsToRemove,
  takeDailySnapshot,
} from "../src/backups/snapshots.ts";
import { writeBackup } from "../src/backups/write.ts";
import { readSecretKey } from "../src/config.ts";
import { migrate } from "../src/db/migrate.ts";
import { migrationsDir } from "../src/paths.ts";
import {
  browser,
  GOOD_PASSWORD,
  type MadeApp,
  makeApp,
  OWNER_EMAIL,
  setUp,
  signedInAs,
} from "./auth-helpers.ts";
import { exitedWithin, runCli, tempDir, waitForRunning } from "./helpers.ts";

const NEWEST = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).length;

/** A site with a picture, set up the way an owner would. */
async function siteWithPicture() {
  const made = await makeApp();
  const owner = await setUp(made);
  const png = await sharp({
    create: { width: 1200, height: 800, channels: 3, background: "#336699" },
  })
    .png()
    .toBuffer();
  const reply = await owner.upload("/api/admin/media", png, "Sunny day.png");
  expect(reply.status).toBe(201);
  return { made, owner, uploaded: await reply.json() };
}

async function backUp(made: MadeApp): Promise<string> {
  const zip = join(tempDir(), "backup.zip");
  await writeBackup(
    {
      db: made.db,
      backupsDir: join(made.root, "backups"),
      uploadsDir: made.uploadsDir,
      secretKey: made.secretKey,
      appVersion: "test",
      site: "Rise Bakery",
    },
    createWriteStream(zip),
  );
  return zip;
}

function dataFolder(root = tempDir()) {
  const where = {
    dataDir: root,
    dbPath: join(root, "tend.db"),
    backupsDir: join(root, "backups"),
    uploadsDir: join(root, "uploads"),
    secretKeyPath: join(root, "secret.key"),
  };
  mkdirSync(where.backupsDir, { recursive: true });
  return where;
}

async function restoreInto(zip: string, root?: string) {
  const where = dataFolder(root);
  const checked = await checkBackup(zip, join(where.backupsDir, ".tmp-restore"), NEWEST);
  return { where, checked, ...(await restoreBackup(checked, where)) };
}

function siteName(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'site'").get() as {
      value: string;
    };
    return JSON.parse(row.value).name;
  } finally {
    db.close();
  }
}

describe("backing up and restoring a site", () => {
  test("a backup restores the whole site, which then works as before", async () => {
    const { made, uploaded } = await siteWithPicture();
    const zip = await backUp(made);
    const { where, checked, snapshotPath } = await restoreInto(zip);

    // There was no site there to save first.
    expect(snapshotPath).toBeUndefined();
    // The database, the key and the original, but none of the sizes made from it.
    expect(checked.manifest.files.map((file) => file.path)).toEqual([
      "tend.db",
      "secret.key",
      expect.stringMatching(/^uploads\/originals\/[0-9a-f]{2}\/[0-9a-f-]{36}\.[0-9a-f]{12}\.png$/),
    ]);
    expect(readSecretKey(where).equals(made.secretKey)).toBe(true);
    expect(existsSync(join(where.uploadsDir, "variants"))).toBe(false);

    // Started on what was restored, the site signs its Owner in and shows its pages. Its
    // picture's sizes are made again from the original the first time they're asked for.
    const restored = await makeApp({}, { root: where.dataDir, secretKey: readSecretKey(where) });
    const signIn = await browser(restored.app).post("/api/auth/login", {
      email: OWNER_EMAIL,
      password: GOOD_PASSWORD,
    });
    expect(signIn.status).toBe(200);
    expect((await restored.app.request("/")).status).toBe(200);
    const size = await restored.app.request(uploaded.srcset.split(", ")[0].split(" ")[0]);
    expect(size.status).toBe(200);
    expect(size.headers.get("content-type")).toBe("image/webp");
  });

  test("tendcms restore leaves a site that tendcms start can start", async () => {
    const { made } = await siteWithPicture();
    const zip = await backUp(made);
    const dataDir = join(tempDir(), "data");
    const env = { TEND_DATA_DIR: dataDir, PORT: "0" };
    const restored = runCli(["restore", zip], env);
    expect(await exitedWithin(restored)).toBe(0);
    expect(restored.output()).toContain("Restored Rise Bakery as it was on");
    const { secretKeyPath } = dataFolder(dataDir);
    expect(readFileSync(secretKeyPath, "utf8")).toBe(`${made.secretKey.toString("hex")}\n`);
    if (process.platform !== "win32") expect(statSync(secretKeyPath).mode & 0o777).toBe(0o600);

    const start = runCli(["start"], env);
    try {
      const { origin } = await waitForRunning(start);
      const signIn = await fetch(`${origin}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: OWNER_EMAIL, password: GOOD_PASSWORD }),
      });
      expect(signIn.status).toBe(200);
    } finally {
      await start.stop();
    }
  });

  test("restoring over a site saves that site first, so it can be put back", async () => {
    const { made } = await siteWithPicture();
    const zip = await backUp(made);
    const other = await makeApp();
    await setUp(other, {
      site: { name: "Corner Café", tagline: "", locale: "en", timezone: "UTC" },
    });
    other.db.close();

    const { where, snapshotPath } = await restoreInto(zip, other.root);
    expect(siteName(where.dbPath)).toBe("Rise Bakery");
    expect(snapshotPath).toMatch(/before-restore-[0-9TZ.]+\.db\.gz$/);
    const saved = join(tempDir(), "saved.db");
    writeFileSync(saved, gunzipSync(readFileSync(snapshotPath as string)));
    expect(siteName(saved)).toBe("Corner Café");
  });

  test.each<[string, (bytes: Buffer) => Buffer]>([
    ["isn't one any more", () => Buffer.from("not a database ".repeat(500))],
    ["is cut short", (bytes) => bytes.subarray(0, 8192)],
    [
      "lost its first page",
      (bytes) => Buffer.concat([bytes.subarray(0, 100), Buffer.alloc(4096), bytes.subarray(4196)]),
    ],
  ])("a site is put back over a database that %s", async (_how, damage) => {
    const { made } = await siteWithPicture();
    const zip = await backUp(made);
    const other = await makeApp();
    await setUp(other);
    other.db.pragma("wal_checkpoint(TRUNCATE)");
    other.db.close();
    const dbPath = join(other.root, "tend.db");
    writeFileSync(dbPath, damage(readFileSync(dbPath)));

    const { where, snapshotPath } = await restoreInto(zip, other.root);
    expect(siteName(where.dbPath)).toBe("Rise Bakery");
    expect(existsSync(snapshotPath as string)).toBe(true);
  });

  test("a database too damaged to read is kept as it was, with its WAL", async () => {
    const { made } = await siteWithPicture();
    const zip = await backUp(made);
    const where = dataFolder();
    const damaged = Buffer.from("not a database ".repeat(500));
    writeFileSync(where.dbPath, damaged);
    writeFileSync(`${where.dbPath}-wal`, "its WAL");
    const { snapshotPath, wasDamaged } = await restoreInto(zip, where.dataDir);
    expect(wasDamaged).toBe(true);
    expect(snapshotPath).toMatch(/before-restore-[0-9TZ.]+-damaged\.db$/);
    expect(readFileSync(snapshotPath as string).equals(damaged)).toBe(true);
    expect(readFileSync(`${snapshotPath}-wal`, "utf8")).toBe("its WAL");
    expect(siteName(where.dbPath)).toBe("Rise Bakery");
  });

  test("tendcms restore works over a damaged database and a damaged key", async () => {
    const { made } = await siteWithPicture();
    const zip = await backUp(made);
    const where = dataFolder();
    writeFileSync(where.dbPath, "not a database ".repeat(500));
    writeFileSync(where.secretKeyPath, "not a key");
    const env = { TEND_DATA_DIR: where.dataDir, PORT: "0" };

    // Until then, everything else says what to do, and not with a stack trace.
    for (const command of [["start"], ["setup-code"], ["reset-password", OWNER_EMAIL]]) {
      const cli = runCli(command, env);
      expect(await exitedWithin(cli)).toBe(1);
      expect(cli.output()).toMatch(/is damaged.*from a backup/);
      expect(cli.output()).not.toMatch(/^\s+at /m);
    }

    const restored = runCli(["restore", zip], env);
    expect(await exitedWithin(restored)).toBe(0);
    expect(restored.output()).toContain("Restored Rise Bakery as it was on");
    expect(restored.output()).toContain("The database that was here was damaged. It's kept");
    expect(siteName(where.dbPath)).toBe("Rise Bakery");
    expect(readFileSync(where.secretKeyPath, "utf8").trim()).toBe(made.secretKey.toString("hex"));
  });

  test("a restore cut short leaves nothing behind once Tend starts again", async () => {
    const where = dataFolder();
    const leftover = join(where.backupsDir, ".tmp-restore-1800000000000");
    mkdirSync(join(leftover, "uploads", "originals"), { recursive: true });
    writeFileSync(join(leftover, "tend.db"), "half a database");
    await migrate({
      dbPath: where.dbPath,
      backupsDir: where.backupsDir,
      migrationsDir,
      appVersion: "test",
      log: () => {},
    });
    expect(readdirSync(where.backupsDir)).toEqual([]);
  });

  test("the file's name says whose backup it is, and that it's private", () => {
    const day = new Date("2027-11-21T10:00:00Z");
    expect(backupFileName("Rise Bakery", day)).toBe("rise-bakery-backup-PRIVATE-2027-11-21.zip");
    expect(backupFileName("Café Éclair & Co.", day)).toBe(
      "cafe-eclair-co-backup-PRIVATE-2027-11-21.zip",
    );
    expect(backupFileName("東京", day)).toBe("tend-backup-PRIVATE-2027-11-21.zip");
  });
});

describe("a backup is checked before anything is restored", () => {
  type Files = Record<string, Uint8Array>;

  async function changed(change: (files: Files) => void): Promise<string> {
    const { made } = await siteWithPicture();
    const files = unzipSync(readFileSync(await backUp(made)));
    change(files);
    const zip = join(tempDir(), "changed.zip");
    writeFileSync(zip, zipSync(files));
    return zip;
  }

  function editManifest(files: Files, edit: (manifest: Record<string, unknown>) => void) {
    const manifest = JSON.parse(Buffer.from(files["manifest.json"] as Uint8Array).toString());
    edit(manifest);
    files["manifest.json"] = Buffer.from(JSON.stringify(manifest));
  }

  function original(files: Files): string {
    return Object.keys(files).find((name) => name.startsWith("uploads/")) as string;
  }

  /** The reason it was refused. Nothing of the site may be left in the data folder. */
  async function refusal(zip: string): Promise<string> {
    const where = dataFolder();
    const error = await checkBackup(zip, join(where.backupsDir, ".tmp-restore"), NEWEST).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(BackupError);
    expect(existsSync(where.dbPath)).toBe(false);
    expect(existsSync(where.secretKeyPath)).toBe(false);
    return (error as Error).message;
  }

  /** A backup whose key is this, and whose manifest agrees. */
  function withKey(key: Buffer): Promise<string> {
    return changed((files) => {
      files["secret.key"] = key;
      editManifest(files, (manifest) => {
        const listed = manifest.files as { path: string; bytes: number; sha256: string }[];
        const entry = listed.find(({ path }) => path === "secret.key");
        Object.assign(entry as object, {
          bytes: key.length,
          sha256: createHash("sha256").update(key).digest("hex"),
        });
      });
    });
  }

  test("a key Tend couldn't start with", async () => {
    expect(await refusal(await withKey(Buffer.from("not a key")))).toContain("isn't a Tend backup");
    expect(await refusal(await withKey(Buffer.alloc(5000, "a")))).toContain("isn't a Tend backup");
  });

  test("but the first backups, from before any release, held only the key's bytes", async () => {
    const key = Buffer.alloc(32, 7);
    const { where } = await restoreInto(await withKey(key));
    expect(readSecretKey(where).equals(key)).toBe(true);
  });

  test("a file changed since it was saved", async () => {
    const zip = await changed((files) => {
      const bytes = files[original(files)] as Uint8Array;
      bytes[100] = (bytes[100] ?? 0) ^ 1;
    });
    expect(await refusal(zip)).toMatch(/isn't the file that was saved/);
  });

  test("a file a backup never holds, wherever it would go", async () => {
    for (const name of ["uploads/variants/x/960.webp", "../outside.txt", "/etc/passwd"]) {
      const zip = await changed((files) => {
        files[name] = new Uint8Array([1, 2, 3]);
      });
      expect(await refusal(zip)).toMatch(/a file Tend doesn't expect/);
    }
  });

  test("a file the manifest lists but the backup lacks", async () => {
    const zip = await changed((files) => {
      delete files[original(files)];
    });
    expect(await refusal(zip)).toMatch(/is missing uploads\/originals\//);
  });

  test("a backup made by a newer Tend", async () => {
    const zip = await changed((files) =>
      editManifest(files, (manifest) => {
        manifest.schemaVersion = NEWEST + 1;
        manifest.appVersion = "9.0.0";
      }),
    );
    expect(await refusal(zip)).toMatch(/made by a newer Tend \(9\.0\.0\)/);
  });

  test("damaged site data, even with a manifest to match it", async () => {
    const garbage = new Uint8Array(8192).fill(7);
    const zip = await changed((files) => {
      files["tend.db"] = garbage;
      editManifest(files, (manifest) => {
        const entry = (manifest.files as { path: string; bytes: number; sha256: string }[]).find(
          (file) => file.path === "tend.db",
        ) as { bytes: number; sha256: string };
        entry.bytes = garbage.length;
        entry.sha256 = createHash("sha256").update(garbage).digest("hex");
      });
    });
    expect(await refusal(zip)).toMatch(/data in this backup is damaged/);
  });

  test("a file that isn't a backup at all", async () => {
    const zip = join(tempDir(), "notes.zip");
    writeFileSync(zip, "These are my notes, not a backup.");
    expect(await refusal(zip)).toMatch(/isn't a Tend backup/);
  });
});

describe("Settings → Backups", () => {
  test("the Owner downloads the whole site, as a private zip that restores", async () => {
    const { made, owner } = await siteWithPicture();
    const reply = await owner.get("/api/admin/backups/download");
    expect(reply.status).toBe(200);
    expect(reply.headers.get("content-type")).toBe("application/zip");
    expect(reply.headers.get("content-disposition")).toMatch(
      /^attachment; filename="rise-bakery-backup-PRIVATE-\d{4}-\d{2}-\d{2}\.zip"$/,
    );
    const zip = join(tempDir(), "downloaded.zip");
    writeFileSync(zip, await reply.bytes());
    const { checked } = await restoreInto(zip);
    expect(checked.manifest.site).toBe("Rise Bakery");
    expect(checked.manifest.files).toHaveLength(3);
    // Counted once the last of it has gone, for the reminder on Overview.
    await expect
      .poll(async () => (await (await owner.get("/api/admin/backups")).json()).lastDownloadAt)
      .toBe(made.clock.time);
  });

  test("only the Owner can download one, and only from the admin itself", async () => {
    const { made, owner } = await siteWithPicture();
    const { client: admin } = await signedInAs(made, "admin");
    expect((await admin.get("/api/admin/backups/download")).status).toBe(403);
    // An Admin still sees the copies kept here, and the disk.
    expect((await admin.get("/api/admin/backups")).status).toBe(200);
    // A link on another site can't make the server start one.
    const foreign = await owner.get("/api/admin/backups/download", {
      "Sec-Fetch-Site": "cross-site",
    });
    expect(foreign.status).toBe(403);
    expect((await foreign.json()).error.code).toBe("foreign_request");
  });

  test("lists the copies kept here and the space on the disk", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const takenAt = Date.parse("2027-11-21T04:00:00Z");
    await takeDailySnapshot({
      db: made.db,
      dbPath: join(made.root, "tend.db"),
      backupsDir: join(made.root, "backups"),
      timeZone: "UTC",
      now: takenAt,
    });
    const info = await (await owner.get("/api/admin/backups")).json();
    expect(info.snapshots).toEqual([
      { id: "daily-20271121T040000.000Z", kind: "daily", takenAt, bytes: expect.any(Number) },
    ]);
    expect(info.disk.free).toBeGreaterThan(0);
    expect(info.disk.total).toBeGreaterThan(info.disk.free);
    expect(info.lastDownloadAt).toBeNull();
  });
});

describe("daily copies", () => {
  const at = (iso: string) => Date.parse(iso);

  test("one a day, from 03:00 where the site is", () => {
    // Manila is UTC+8 all year.
    const manila = "Asia/Manila";
    expect(dailySnapshotDue([], at("2027-11-20T18:30:00Z"), manila)).toBe(false);
    expect(dailySnapshotDue([], at("2027-11-20T19:30:00Z"), manila)).toBe(true);
    // Made at 03:05 there, so not again that day.
    expect(dailySnapshotDue([at("2027-11-20T19:05:00Z")], at("2027-11-20T23:00:00Z"), manila)).toBe(
      false,
    );
    // One from the evening before is yesterday's.
    expect(dailySnapshotDue([at("2027-11-20T12:00:00Z")], at("2027-11-20T19:30:00Z"), manila)).toBe(
      true,
    );
    // A time zone Tend can't use counts as UTC.
    expect(dailySnapshotDue([], at("2027-11-21T03:30:00Z"), "Not/A_Zone")).toBe(true);
    expect(dailySnapshotDue([], at("2027-11-21T02:30:00Z"), "Not/A_Zone")).toBe(false);
  });

  test("a week of daily copies and four weekly ones, in no more than a fifth of the disk", () => {
    const day = 24 * 60 * 60 * 1000;
    // Day 0 is a Monday.
    const daily = Array.from({ length: 60 }, (_, index) => ({
      id: `daily-${index}`,
      kind: "daily" as const,
      takenAt: at("2027-01-04T03:00:00Z") + index * day,
      bytes: 1000,
    }));
    const keptOn = (diskBytes: number) => {
      const removed = new Set(snapshotsToRemove(daily, diskBytes).map((each) => each.id));
      return daily.filter((each) => !removed.has(each.id)).map((each) => each.id);
    };
    // Days 53 to 59, then the newest of each of the four weeks before (Sundays: 48, 41, 34, 27).
    const expected = [27, 34, 41, 48, 53, 54, 55, 56, 57, 58, 59].map((index) => `daily-${index}`);
    expect(keptOn(1_000_000)).toEqual(expected);
    // A fifth of 50 kB is 10 kB, so the oldest goes.
    expect(keptOn(50_000)).toEqual(expected.slice(1));
    // However small the disk, the newest stays.
    expect(keptOn(1000)).toEqual(["daily-59"]);
  });

  test("today's copy is made once, checked, and opens as the site's data", async () => {
    const made = await makeApp();
    await setUp(made);
    const options = {
      db: made.db,
      dbPath: join(made.root, "tend.db"),
      backupsDir: join(made.root, "backups"),
      timeZone: "UTC",
      now: at("2027-11-21T03:10:00Z"),
    };
    const first = await takeDailySnapshot(options);
    expect(first?.id).toBe("daily-20271121T031000.000Z");
    expect(await takeDailySnapshot({ ...options, now: options.now + 60_000 })).toBeUndefined();
    // Nothing else is left behind: checking the copy opened it, which makes a -wal and -shm.
    expect(readdirSync(options.backupsDir)).toEqual([`${first?.id}.db.gz`]);
    const copy = join(tempDir(), "copy.db");
    writeFileSync(copy, gunzipSync(readFileSync(join(options.backupsDir, `${first?.id}.db.gz`))));
    expect(siteName(copy)).toBe("Rise Bakery");
  });
});
