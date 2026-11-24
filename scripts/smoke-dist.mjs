// Boots the built package the way an installer would, from an empty folder, and
// checks the things only the built output can get wrong: finding its migrations,
// finding the admin, serving the real files, and running setup. Run after `pnpm build`.
// Zero dependencies and no shell, so it runs the same on every OS.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dist = join(import.meta.dirname, "..", "packages", "tendcms", "dist");
const cli = join(dist, "cli.mjs");
if (!existsSync(cli)) {
  console.error(`${cli} doesn't exist. Run pnpm build first.`);
  process.exit(1);
}

// Nothing at all set up, in an empty folder (PLAN.md §4, P2). Windows won't start a program
// without these.
const bare = Object.fromEntries(
  ["SystemRoot", "windir", "TEMP", "TMP"].flatMap((name) =>
    process.platform === "win32" && process.env[name] ? [[name, process.env[name]]] : [],
  ),
);

/** PLAN.md §11. Shared Windows and macOS runners are too uneven to hold to it. */
const BOOT_MS = process.platform === "linux" ? 1000 : 4000;
const IDLE_BYTES = 120 * 1024 * 1024;

const cwd = mkdtempSync(join(tmpdir(), "tend-smoke-"));
const child = spawn(process.execPath, [cli, "start"], {
  cwd,
  env: bare,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk;
});
child.stderr.on("data", (chunk) => {
  output += chunk;
});

async function waitForPort(tend = child) {
  for (let i = 0; i < 300; i++) {
    const match = output.match(/localhost:(\d+)\/admin|listening on port (\d+)/);
    if (match) return match[1] ?? match[2];
    if (tend.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Tend didn't start");
}

async function stopped(tend) {
  if (!tend || tend.exitCode !== null || tend.signalCode !== null) return;
  const exited = new Promise((resolve) => tend.once("exit", resolve));
  tend.kill("SIGTERM");
  await exited;
}

function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`ok - ${message}`);
}

let failed = false;
let again;
try {
  const base = `http://127.0.0.1:${await waitForPort()}`;

  const health = await (await fetch(`${base}/healthz`)).json();
  check(health.ok === true, "it starts in an empty folder with nothing set, and /healthz answers");

  // Importing cli.mjs could run Tend a second time.
  const importers = readdirSync(dist).filter(
    (name) => name.endsWith(".mjs") && readFileSync(join(dist, name), "utf8").includes("/cli.mjs"),
  );
  check(importers.length === 0, "nothing imports cli.mjs");

  // Every package tsdown may bundle has its licence in the notices, as must be published.
  const notices = readFileSync(join(dist, "THIRD_PARTY_NOTICES.md"), "utf8");
  const config = readFileSync(join(dist, "..", "tsdown.config.ts"), "utf8");
  const bundled = [
    ...(config.match(/onlyBundle:\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g),
  ];
  check(bundled.length > 0, "tsdown's list of bundled packages was found");
  for (const [, name] of bundled) {
    check(notices.includes(`## ${name} `), `THIRD_PARTY_NOTICES.md has ${name}'s licence`);
  }
  check(
    notices.includes("END OF TERMS AND CONDITIONS"),
    "the licence of a package that doesn't include one is there in full",
  );
  check(
    existsSync(join(dist, "admin", "THIRD_PARTY_NOTICES.md")),
    "the admin's THIRD_PARTY_NOTICES.md is there too",
  );

  check(existsSync(join(cwd, "data", "tend.db")), "the database was created from the migrations");

  const page = await fetch(`${base}/admin/setup`);
  const html = await page.text();
  check(page.status === 200 && html.includes('id="root"'), "/admin/setup serves the built admin");

  const asset = html.match(/\/admin\/assets\/[^"]+\.js/)?.[0];
  check(asset !== undefined, "the admin page links a script");
  const script = await fetch(`${base}${asset}`);
  check(script.status === 200, `${asset} is served`);
  check(
    script.headers.get("cache-control")?.includes("immutable"),
    "hashed assets are cached forever",
  );

  // Sets up a real site, which proves the bundled server can load its native
  // password and database modules, and finds its later migrations.
  const code = output.match(/#code=(\S+)/)?.[1];
  check(code !== undefined, "the printed link carries a setup code");
  const password = "maple-river-candle-stone-orbit";
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      site: { name: "Smoke Test" },
      owner: { name: "Smoke", email: "smoke@example.com", password },
      starter: "blog",
    }),
  });
  check(setup.status === 201, "setup creates the site and the owner");

  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "smoke@example.com", password }),
  });
  check(login.status === 200, "the owner can sign in");
  const cookie = login.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
  const me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } });
  const { site } = await me.json();
  check(me.status === 200 && site.name === "Smoke Test", "the session and the site's name work");

  // The theme ships inside the package, so this proves it was bundled and can render.
  const home = await fetch(`${base}/`);
  const homeHtml = await home.text();
  check(home.status === 200 && homeHtml.includes("Smoke Test"), "the public site renders");
  // Structured data and prefetching rules are script elements too, but nothing ever runs them.
  const withoutData = homeHtml.replace(
    /<script type="(?:application\/ld\+json|speculationrules)">[^<]*<\/script>/g,
    "",
  );
  check(!withoutData.includes("<script"), "public pages have no JavaScript");
  check(homeHtml.includes('<link rel="canonical"'), "public pages say where they live");
  const css = homeHtml.match(/\/assets\/[^"]+\.css/)?.[0];
  check((await fetch(`${base}${css}`)).status === 200, "the theme's stylesheet is served");
  check(
    (await fetch(`${base}/blog/welcome`)).status === 200,
    "the starter's first post is published",
  );

  // tendcms doctor, from files of its own in the bundle, beside the running site. How full
  // this computer's disk is could fail it, so only what it says about the site counts.
  const doctor = spawnSync(process.execPath, [cli, "doctor"], {
    cwd,
    env: { ...process.env, TEND_ADMIN_DEV_URL: "", TEND_DATA_DIR: join(cwd, "data") },
    encoding: "utf8",
  });
  for (const says of ["The site's database is in good order.", "Tend is running here"]) {
    check(doctor.stdout.includes(`OK    ${says}`), `tendcms doctor says: ${says}`);
  }

  // Copies and backups are made in a thread of their own, from a file in the bundle that's
  // found by its name.
  const copy = await fetch(`${base}/api/admin/backups`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: "{}",
  });
  check(copy.status === 201, "a copy of the site is saved from the admin");
  const { snapshots } = await copy.json();
  const copied = await fetch(`${base}/api/admin/backups/${snapshots[0].id}/download`, {
    headers: { Cookie: cookie },
  });
  const copyFile = join(cwd, "smoke-copy.db.gz");
  writeFileSync(copyFile, Buffer.from(await copied.arrayBuffer()));
  check(copied.status === 200, "the copy downloads");
  const download = await fetch(`${base}/api/admin/backups/download`, {
    headers: { Cookie: cookie },
  });
  const zipped = Buffer.from(await download.arrayBuffer());
  check(zipped.subarray(0, 2).toString() === "PK", "the whole site downloads as a zip");

  // A backup is made beside the running site and restores into a new data folder, which
  // proves the bundled zip code and both commands work as published (PLAN.md §13).
  const run = (command, argument, dataDir) => {
    const result = spawnSync(process.execPath, [cli, command, argument], {
      cwd,
      env: { ...process.env, TEND_ADMIN_DEV_URL: "", TEND_DATA_DIR: dataDir },
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`tendcms ${command} failed:\n${result.stdout}${result.stderr}`);
    }
  };
  const zip = join(cwd, "smoke-backup-PRIVATE.zip");
  run("backup", zip, join(cwd, "data"));
  check(existsSync(zip), "tendcms backup saves the running site to a zip");
  const restored = join(cwd, "restored");
  run("restore", zip, restored);
  check(existsSync(join(restored, "tend.db")), "tendcms restore puts it in a new data folder");
  const fromCopy = join(cwd, "restored-copy");
  run("restore", copyFile, fromCopy);
  check(existsSync(join(fromCopy, "tend.db")), "tendcms restore takes a copy as well");

  // And that the site it put there starts, and knows its owner. Restoring and starting each
  // read the folder in their own way, so nothing short of starting it proves they agree.
  const startAgain = () => {
    again = spawn(process.execPath, [cli, "start"], {
      cwd,
      env: { ...process.env, PORT: "0", TEND_ADMIN_DEV_URL: "", TEND_DATA_DIR: restored },
      stdio: ["ignore", "pipe", "pipe"],
    });
    output = "";
    for (const stream of [again.stdout, again.stderr]) {
      stream.on("data", (chunk) => {
        output += chunk;
      });
    }
  };
  const started = performance.now();
  startAgain();
  const restoredBase = `http://127.0.0.1:${await waitForPort(again)}`;
  const boot = Math.round(performance.now() - started);
  check(boot <= BOOT_MS, `it starts within ${BOOT_MS} ms, once its database is made (${boot} ms)`);
  const backIn = await fetch(`${restoredBase}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "smoke@example.com", password }),
  });
  check(backIn.status === 200, "the restored site starts, and its owner can sign in");

  // Left alone, as it is most of the day, and with nothing asked of it but this.
  const asOwner = backIn.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
  // The day's copy is made soon after a start, in a thread of its own, and some of what that
  // takes is kept for the next one. So it's made before this is measured. Before 3 in the
  // morning there's none to make.
  for (let waited = 0; waited < 100 && !output.includes("Saved today's copy"); waited++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await stopped(again);
  startAgain();
  const idleBase = `http://127.0.0.1:${await waitForPort(again)}`;
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const running = await fetch(`${idleBase}/api/admin/health`, { headers: { Cookie: asOwner } });
  const { memoryBytes } = await running.json();
  const megabytes = Math.round(memoryBytes / 1024 / 1024);
  // A Node.js that's still being made takes what it takes.
  const isRelease = !process.versions.node.includes("-");
  check(
    memoryBytes <= IDLE_BYTES || !isRelease,
    `left alone, it takes at most 120 MB (${megabytes} MB)`,
  );
} catch (error) {
  failed = true;
  console.error(`\nSmoke test failed: ${error.message}\n\nTend's output:\n${output}`);
} finally {
  for (const tend of [child, again]) await stopped(tend);
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(failed ? 1 : 0);
