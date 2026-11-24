import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import {
  type Config,
  detectPlatform,
  ensureSecretKey,
  loadConfig,
  prepareDataDir,
} from "../src/config.ts";
import { openDatabase } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import {
  addressFindings,
  diskFinding,
  examine,
  type Finding,
  nodeFinding,
  summary,
  withoutHome,
} from "../src/doctor.ts";
import { migrationsDir } from "../src/paths.ts";
import { exitedWithin, runCli, tempDir, waitForRunning } from "./helpers.ts";

const NOW = Date.parse("2026-11-24T12:00:00Z");
const isRoot = process.getuid?.() === 0;
const posixOnly = process.platform !== "win32";

/** A data folder as Tend leaves it, before anyone has set the site up. */
async function newSite(): Promise<Config> {
  const config = loadConfig({ TEND_DATA_DIR: join(tempDir(), "data") });
  prepareDataDir(config);
  ensureSecretKey(config);
  const { dbPath, backupsDir } = config;
  await migrate({ dbPath, backupsDir, migrationsDir, appVersion: "test", log: () => {} });
  return config;
}

function setMeta(config: Config, values: Record<string, string>): void {
  const db = openDatabase(config.dbPath);
  for (const [key, value] of Object.entries(values)) {
    db.prepare(
      "INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
  }
  db.close();
}

async function examined(config: { dataDir: string }, env: Record<string, string> = {}) {
  return examine({
    env: { TEND_DATA_DIR: config.dataDir, ...env },
    nodeVersion: "26.13.1",
    now: NOW,
  });
}

function texts(findings: Finding[], kind: Finding["kind"]): string[] {
  return findings.filter((each) => each.kind === kind).map(({ text }) => text);
}

describe("tendcms doctor, on a site", () => {
  // Not in a container, where a test's folder is one that's lost with it.
  test.runIf(detectPlatform({}) === "local")("that's fine has nothing to fix", async () => {
    const config = await newSite();
    // How full this computer's disk is says nothing about the site.
    const findings = (await examined(config)).filter(({ text }) => !text.startsWith("The disk"));
    expect(findings).toEqual([
      { kind: "OK", text: "Node.js 26.13.1 gets security fixes until 30 April 2029." },
      { kind: "OK", text: "The database, picture and password components work." },
      { kind: "OK", text: `Tend can write to its data folder, ${config.dataDir}.` },
      { kind: "OK", text: "The site's database is in good order." },
      { kind: "OK", text: "The site's key file is in place." },
      { kind: "OK", text: "Tend isn't running here just now." },
    ]);
  });

  test("changes nothing in it, and leaves nothing behind", async () => {
    const config = await newSite();
    const everything = () => {
      const names = readdirSync(config.dataDir, { recursive: true }).map(String).sort();
      // Reading a database leaves these two, and SQLite tidies them up the next time.
      const kept = names.filter((name) => !/tend\.db-(wal|shm)$/.test(name));
      const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
      return [kept, hash(config.dbPath), hash(config.secretKeyPath)];
    };
    const before = everything();
    await examined(config);
    expect(everything()).toEqual(before);
  });

  test("that isn't there yet says so, and doesn't start one", async () => {
    const missing = { dataDir: join(tempDir(), "not", "here") };
    expect(texts(await examined(missing), "LOOK")).toEqual([
      expect.stringMatching(
        /^There's no site in .*here yet\. Tend makes one there when it starts\./,
      ),
    ]);
    expect(existsSync(missing.dataDir)).toBe(false);

    const empty = { dataDir: tempDir() };
    expect(texts(await examined(empty), "LOOK")).toContainEqual(
      expect.stringContaining(`There's no site in ${empty.dataDir} yet.`),
    );
    expect(readdirSync(empty.dataDir)).toEqual([]);
  });

  test("whose data folder is a file can't be written to", async () => {
    const dataDir = join(tempDir(), "data");
    writeFileSync(dataDir, "");
    expect(texts(await examined({ dataDir }), "FIX")).toContainEqual(
      expect.stringContaining(`Tend can't write to its data folder, ${dataDir}`),
    );
  });

  test.runIf(posixOnly && !isRoot)(
    "whose data folder belongs to someone else says how to fix that where it runs",
    async () => {
      const config = await newSite();
      chmodSync(config.dataDir, 0o500);
      try {
        const [problem] = texts(await examined(config, { TEND_PLATFORM: "docker" }), "FIX");
        expect(problem).toContain(
          `Tend can't write to its data folder, ${config.dataDir} (EACCES).`,
        );
        expect(problem).toContain("sudo chown -R 1000:1000");
      } finally {
        chmodSync(config.dataDir, 0o700);
      }
    },
  );

  test.runIf(!isRoot)("with one file that can't be written names it", async () => {
    const config = await newSite();
    chmodSync(config.dbPath, 0o400);
    try {
      const [problem] = texts(await examined(config), "FIX");
      expect(problem).toContain(`Tend can't write to ${config.dbPath}, in its data folder (E`);
    } finally {
      chmodSync(config.dbPath, 0o600);
    }
  });

  test("with a damaged database says to restore a backup", async () => {
    const config = await newSite();
    rmSync(`${config.dbPath}-wal`, { force: true });
    rmSync(`${config.dbPath}-shm`, { force: true });
    writeFileSync(config.dbPath, "this isn't a database ".repeat(200));
    expect(texts(await examined(config), "FIX")).toContainEqual(
      "The site's database is damaged (file is not a database). Close Tend if it's running, and put the site back from a backup: tendcms restore <file>",
    );
  });

  test("with a damaged page in its database says which, without SQLite's heading", async () => {
    const config = await newSite();
    const db = openDatabase(config.dbPath);
    db.exec("CREATE TABLE filler (text TEXT)");
    const insert = db.prepare("INSERT INTO filler VALUES (?)");
    db.transaction(() => {
      for (let row = 0; row < 2000; row++) insert.run(`row ${row} `.repeat(20));
    })();
    const root = db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'filler'").get() as {
      rootpage: number;
    };
    const pageSize = db.pragma("page_size", { simple: true }) as number;
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    const bytes = readFileSync(config.dbPath);
    bytes.fill(0xff, (root.rootpage - 1) * pageSize, root.rootpage * pageSize);
    writeFileSync(config.dbPath, bytes);

    const problem = texts(await examined(config), "FIX").find((text) => text.includes("damaged"));
    expect(problem).toMatch(/^The site's database is damaged \(/);
    expect(problem).not.toContain("***");
  });

  test("from a newer Tend says which to install", async () => {
    const config = await newSite();
    setMeta(config, { schema_version: "9999", min_app_version: "7.8.9" });
    expect(texts(await examined(config), "FIX")).toContainEqual(
      expect.stringContaining("This site's data was saved by Tend 7.8.9, which is newer"),
    );
  });

  test("from an older Tend says it will be updated", async () => {
    const config = await newSite();
    setMeta(config, { schema_version: "1" });
    expect(texts(await examined(config), "OK")).toContain(
      "The site's database is in good order. Tend will update it when it next starts.",
    );
  });

  test("with its key missing or damaged says what that means", async () => {
    const config = await newSite();
    writeFileSync(config.secretKeyPath, "not a key");
    expect(texts(await examined(config), "FIX")).toContainEqual(
      expect.stringContaining(`The key file ${config.secretKeyPath} is damaged`),
    );
    rmSync(config.secretKeyPath);
    expect(texts(await examined(config), "FIX")).toContainEqual(
      expect.stringMatching(
        /is missing\. Put it back from a backup\..*recovery codes stop working/,
      ),
    );
  });

  test("with a setting that's wrong says so, and looks at the rest", async () => {
    const findings = await examined(await newSite(), { PORT: "eighty", TEND_SETUP_CODE: "short" });
    expect(texts(findings, "FIX")).toEqual([
      expect.stringContaining(`PORT is set to "eighty", which isn't a port number.`),
    ]);
    expect(texts(findings, "OK")).toContain("The site's database is in good order.");
  });

  test("on a host it can't run on says only that", async () => {
    const findings = await examined(await newSite(), { VERCEL: "1" });
    expect(texts(findings, "FIX")).toEqual([expect.stringContaining("Tend can't run on Vercel.")]);
    expect(JSON.stringify(findings)).not.toContain("data folder");
  });

  test("that's running says so, and whether it's keeping up with its daily copies", async () => {
    const dataDir = join(tempDir(), "data");
    const cli = runCli(["start"], { TEND_DATA_DIR: dataDir, PORT: "0" });
    try {
      await waitForRunning(cli);
      expect(texts(await examined({ dataDir }), "OK")).toContain(
        `Tend is running here (process ${cli.child.pid}).`,
      );
      // Looking doesn't disturb it.
      expect(texts(await examined({ dataDir }), "OK")).toContain(
        `Tend is running here (process ${cli.child.pid}).`,
      );

      const copy = (stamp: string) =>
        writeFileSync(join(dataDir, "backups", `daily-${stamp}.db.gz`), "");
      copy("20261120T030000.000Z");
      expect(texts(await examined({ dataDir }), "LOOK")).toContainEqual(
        expect.stringContaining("but the newest is from 20 November 2026."),
      );
      copy("20261124T030000.000Z");
      expect(texts(await examined({ dataDir }), "OK")).toContain(
        "The newest copy of the site's data is from 24 November 2026.",
      );
    } finally {
      await cli.stop();
    }
    // However it stopped.
    expect(texts(await examined({ dataDir }), "OK")).toContain("Tend isn't running here just now.");
  });
});

describe("tendcms doctor", () => {
  test("still looks at the rest when a component can't load", async () => {
    const config = await newSite();
    const without = (pkg: string) => {
      const hook = pathToFileURL(join(import.meta.dirname, "block-package.mjs")).href;
      return runCli(["doctor"], {
        TEND_DATA_DIR: config.dataDir,
        NODE_OPTIONS: `--import=${hook}`,
        BLOCK_PACKAGE: pkg,
        BLOCK_MESSAGE: `Cannot find package '${pkg}'`,
      });
    };
    const pictures = without("sharp");
    expect(await exitedWithin(pictures)).toBe(1);
    expect(pictures.output()).toContain("FIX   Tend's picture component couldn't load");
    expect(pictures.output()).toContain("OK    The site's database is in good order.");

    const database = without("better-sqlite3");
    expect(await exitedWithin(database)).toBe(1);
    expect(database.output()).toContain("FIX   Tend's database component couldn't load");
    expect(database.output()).toContain("OK    Tend can write to its data folder,");
    expect(database.output()).not.toContain("The site's database");
  });

  test.runIf(detectPlatform({}) === "local")(
    "finishes well when there's nothing to fix, and keeps the home folder's name to itself",
    async () => {
      // Somebody's name is in the path of everything in their home folder.
      const home = tempDir();
      mkdirSync(join(home, "my-site"));
      const cli = runCli(["doctor"], {
        HOME: home,
        USERPROFILE: home,
        TEND_DATA_DIR: join(home, "my-site", "data"),
      });
      expect(await exitedWithin(cli)).toBe(0);
      expect(cli.output()).toMatch(/^Tend \d+\.\d+\.\d+ on Node\.js \d+\.\d+\.\d+, /);
      expect(cli.output()).toContain(`There's no site in ~${sep}${join("my-site", "data")} yet.`);
      expect(cli.output()).not.toContain(home);
      expect(cli.output()).toMatch(/\nNothing to fix, and \d thing/);
    },
  );
});

describe("what doctor says", () => {
  test("about Node.js, a release ahead of when it stops being supported", () => {
    const on = (version: string, day: string, platform: "local" | "docker" = "local") =>
      nodeFinding(version, Date.parse(day), platform);
    expect(on("24.5.0", "2027-06-01").kind).toBe("OK");
    expect(on("24.5.0", "2028-02-01")).toEqual({
      kind: "LOOK",
      text: "Node.js 24.5.0 stops getting security fixes on 30 April 2028, and the Tend after that won't run on it. Install the newest LTS version: https://tendcms.dev/install-node",
    });
    // The last day still counts.
    expect(on("24.5.0", "2028-04-30").text).toContain("stops getting");
    expect(on("24.5.0", "2028-05-01").text).toContain("stopped getting");
    expect(on("25.1.0", "2026-11-24").text).toContain("stopped getting security fixes on 1 June");
    expect(on("26.13.1", "2029-03-01", "docker").text).toContain("Update Tend");
    expect(on("31.0.0", "2031-01-01")).toEqual({
      kind: "OK",
      text: "Node.js 31.0.0 is newer than the ones this Tend knows.",
    });
  });

  test("about the disk, at the levels Settings → Backups warns at", () => {
    const at = (used: number) => diskFinding({ total: 5e9, free: 5e9 * (1 - used) });
    expect(at(0.5)).toEqual({ kind: "OK", text: "The disk has 2.5 GB free of 5.0 GB." });
    expect(at(0.85).kind).toBe("LOOK");
    expect(at(0.85).text).toContain(
      "The disk is running low on space, with 750 MB free of 5.0 GB.",
    );
    expect(at(0.95).kind).toBe("FIX");
    expect(at(0.95).text).toContain("changes can't be saved");
    expect(diskFinding({ total: 1.999e12, free: 1.324e12 }).text).toBe(
      "The disk has 1.3 TB free of 2.0 TB.",
    );
  });

  test("about an address that gives everyone one limit on signing in, or no https", () => {
    const about = (publicUrl: string | undefined, trustProxy = 0) =>
      addressFindings({ publicUrl, trustProxy });
    expect(about(undefined)).toEqual([]);
    expect(about("http://localhost:3000")).toEqual([]);
    expect(about("https://rise.example", 1)).toEqual([]);
    expect(about("https://rise.example")[0]?.text).toContain("set TEND_TRUST_PROXY=1");
    expect(about("http://rise.example", 1)[0]?.text).toContain("starts with http:");
    // It's pasted into bug reports, so it doesn't say where the site is.
    expect(
      JSON.stringify([about("https://rise.example"), about("http://rise.example")]),
    ).not.toContain("rise.example");
  });

  test("about the home folder", () => {
    const home = join(sep, "home", "sam");
    expect(withoutHome(`in ${join(home, "site", "data")}.`, home)).toBe(
      `in ~${sep}${join("site", "data")}.`,
    );
    const sammy = join(sep, "home", "sammy", "data");
    expect(withoutHome(sammy, home)).toBe(sammy);
    expect(withoutHome(join(sep, "data", "tend.db"), sep)).toBe(join(sep, "data", "tend.db"));
    expect(withoutHome("anything", "")).toBe("anything");
  });

  test("in all", () => {
    const of = (...kinds: Finding["kind"][]) => summary(kinds.map((kind) => ({ kind, text: "" })));
    expect(of("OK", "OK")).toBe("Nothing to fix.");
    expect(of("OK", "LOOK")).toBe("Nothing to fix, and 1 thing to look at.");
    expect(of("FIX")).toBe("1 thing to fix.");
    expect(of("FIX", "FIX", "LOOK", "LOOK")).toBe("2 things to fix, and 2 things to look at.");
  });
});
