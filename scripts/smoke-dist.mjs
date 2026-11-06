// Boots the built package the way an installer would, from an empty folder, and
// checks the things only the built output can get wrong: finding its migrations,
// finding the admin, and serving the real files. Run after `pnpm build`.
// Zero dependencies and no shell, so it runs the same on every OS.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dirname, "..", "packages", "tendcms", "dist", "cli.mjs");
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

async function waitForPort() {
  for (let i = 0; i < 300; i++) {
    const match = output.match(/localhost:(\d+)\/admin|listening on port (\d+)/);
    if (match) return match[1] ?? match[2];
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Tend didn't start");
}

function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`ok - ${message}`);
}

let failed = false;
try {
  const base = `http://127.0.0.1:${await waitForPort()}`;

  const health = await (await fetch(`${base}/healthz`)).json();
  check(health.ok === true, "/healthz answers");

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
} catch (error) {
  failed = true;
  console.error(`\nSmoke test failed: ${error.message}\n\nTend's output:\n${output}`);
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(failed ? 1 : 0);
