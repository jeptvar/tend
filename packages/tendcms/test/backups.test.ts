import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
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
import { writeBackup } from "../src/backups/write.ts";
import { migrate } from "../src/db/migrate.ts";
import { migrationsDir } from "../src/paths.ts";
import {
  browser,
  GOOD_PASSWORD,
  type MadeApp,
  makeApp,
  OWNER_EMAIL,
  setUp,
} from "./auth-helpers.ts";
import { tempDir } from "./helpers.ts";

const NEWEST = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).length;

/** A site with a picture, set up the way an owner would, with its key on disk. */
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
  writeFileSync(join(made.root, "secret.key"), made.secretKey);
  return { made, uploaded: await reply.json() };
}

async function backUp(made: MadeApp): Promise<string> {
  const zip = join(tempDir(), "backup.zip");
  await writeBackup(
    {
      db: made.db,
      backupsDir: join(made.root, "backups"),
      uploadsDir: made.uploadsDir,
      secretKeyPath: join(made.root, "secret.key"),
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
    expect(readFileSync(where.secretKeyPath).equals(made.secretKey)).toBe(true);
    expect(existsSync(join(where.uploadsDir, "variants"))).toBe(false);

    // Started on what was restored, the site signs its Owner in and shows its pages. Its
    // picture's sizes are made again from the original the first time they're asked for.
    const restored = await makeApp(
      {},
      { root: where.dataDir, secretKey: readFileSync(where.secretKeyPath) },
    );
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
