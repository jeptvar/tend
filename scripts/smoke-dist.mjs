// Boots the built package the way an installer would, from an empty folder, and
// checks the things only the built output can get wrong: finding its migrations,
// finding the admin, serving the real files, and running setup. Run after `pnpm build`.
// Zero dependencies and no shell, so it runs the same on every OS.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dist = join(import.meta.dirname, "..", "packages", "tendcms", "dist");
const cli = join(dist, "cli.mjs");
if (!existsSync(cli)) {
  console.error(`${cli} doesn't exist. Run pnpm build first.`);
  process.exit(1);
}

const cwd = mkdtempSync(join(tmpdir(), "tend-smoke-"));
const child = spawn(process.execPath, [cli, "start"], {
  cwd,
  env: { ...process.env, PORT: "0", TEND_ADMIN_DEV_URL: "", TEND_DATA_DIR: join(cwd, "data") },
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

function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`ok - ${message}`);
}

let failed = false;
let again;
try {
  const base = `http://127.0.0.1:${await waitForPort()}`;

  const health = await (await fetch(`${base}/healthz`)).json();
  check(health.ok === true, "/healthz answers");

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
  // Structured data for search engines is a script element too, but nothing ever runs it.
  const withoutData = homeHtml.replace(/<script type="application\/ld\+json">[^<]*<\/script>/g, "");
  check(!withoutData.includes("<script"), "public pages have no JavaScript");
  check(homeHtml.includes('<link rel="canonical"'), "public pages say where they live");
  const css = homeHtml.match(/\/assets\/[^"]+\.css/)?.[0];
  check((await fetch(`${base}${css}`)).status === 200, "the theme's stylesheet is served");
  check(
    (await fetch(`${base}/blog/welcome`)).status === 200,
    "the starter's first post is published",
  );

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

  // And that the site it put there starts, and knows its owner. Restoring and starting each
  // read the folder in their own way, so nothing short of starting it proves they agree.
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
  const restoredBase = `http://127.0.0.1:${await waitForPort(again)}`;
  const backIn = await fetch(`${restoredBase}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "smoke@example.com", password }),
  });
  check(backIn.status === 200, "the restored site starts, and its owner can sign in");
} catch (error) {
  failed = true;
  console.error(`\nSmoke test failed: ${error.message}\n\nTend's output:\n${output}`);
} finally {
  for (const tend of [child, again]) {
    if (!tend || tend.exitCode !== null || tend.signalCode !== null) continue;
    const exited = new Promise((resolve) => tend.once("exit", resolve));
    tend.kill("SIGTERM");
    await exited;
  }
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(failed ? 1 : 0);
