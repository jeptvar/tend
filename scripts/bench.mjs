// How quickly Tend answers (PLAN.md §11): pages it has kept and pages it makes, pages while a
// backup is being made, and how many it can send in a second. Timings vary from run to run and
// from machine to machine, so this runs nightly and by hand, not on every pull request.
// Run after `pnpm build`. Zero dependencies.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Agent, request } from "node:http";
import { createServer } from "node:net";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dirname, "..", "packages", "tendcms", "dist", "cli.mjs");
if (!existsSync(cli)) {
  console.error(`${cli} doesn't exist. Run pnpm build first.`);
  process.exit(1);
}

const HIT_P95_MS = 2;
const MISS_P95_MS = 30;
const DURING_BACKUP_P99_MS = 10;
const PER_SECOND = 1000;

/** Uploads for the backup to read: photos hardly compress, and neither does this. */
const UPLOAD_COUNT = 60;
const UPLOAD_BYTES = 5 * 1024 * 1024;

const PASSWORD = "maple-river-candle-stone-orbit";
const agent = new Agent({ keepAlive: true, maxSockets: 100 });

/** Asks, and says how long the whole answer took to arrive. */
function ask(base, path, { method = "GET", body, cookie, via = agent } = {}) {
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const began = performance.now();
    const outgoing = request(
      new URL(path, base),
      {
        method,
        agent: via,
        headers: {
          "Accept-Encoding": "br",
          ...(cookie ? { Cookie: cookie } : {}),
          ...(raw ? { "Content-Type": "application/json", "Content-Length": raw.length } : {}),
        },
      },
      (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("error", reject);
        incoming.on("end", () =>
          resolve({
            status: incoming.statusCode,
            headers: incoming.headers,
            body: Buffer.concat(chunks),
            took: performance.now() - began,
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(raw);
  });
}

function percentile(values, part) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * part) - 1)];
}

/** What Tend says it took itself, and whether the page was kept. */
function serverTiming(headers) {
  const [, state, took] = (headers["server-timing"] ?? "").match(
    /cache;desc="(\w+)", total;dur=([\d.]+)/,
  );
  return { state, took: Number(took) };
}

let failed = false;
function report(name, value, limit, unit, atLeast = false) {
  const good = atLeast ? value >= limit : value <= limit;
  if (!good) failed = true;
  const bound = atLeast ? "at least" : "at most";
  const shown = unit === "ms" ? value.toFixed(2) : Math.round(value);
  console.log(`${good ? "ok" : "not ok"} - ${name}: ${shown} ${unit} (${bound} ${limit})`);
}

/** Tend prints the site's own address, so the port is chosen here. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const port = await freePort();
const folder = mkdtempSync(join(tmpdir(), "tend-bench-"));
const dataDir = join(folder, "data");
let output = "";
// On one core, as on the smallest server, where Linux can hold it to one.
const pinned = process.platform === "linux" && availableParallelism() > 1;
const tend = spawn(
  pinned ? "taskset" : process.execPath,
  [...(pinned ? ["--cpu-list", "0", process.execPath] : []), cli, "start"],
  {
    cwd: folder,
    env: {
      ...process.env,
      PORT: String(port),
      TEND_ADMIN_DEV_URL: "",
      TEND_DATA_DIR: dataDir,
      // Pages are kept once the site has an address that isn't this computer's.
      TEND_PUBLIC_URL: "http://bench.example",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
for (const stream of [tend.stdout, tend.stderr]) {
  stream.on("data", (chunk) => {
    output += chunk;
  });
}

try {
  for (let waited = 0; waited < 400 && !/#code=/.test(output); waited++) {
    if (tend.exitCode !== null) throw new Error("Tend didn't start");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const [, code] = output.match(/#code=(\S+)/);
  const base = `http://127.0.0.1:${port}`;
  const setup = await ask(base, "/api/auth/setup", {
    method: "POST",
    body: {
      code,
      site: { name: "Rise Bakery", tagline: "Fresh bread", locale: "en", timezone: "UTC" },
      owner: { name: "Sam Lee", email: "sam@example.com", password: PASSWORD },
      starter: "business",
    },
  });
  if (setup.status !== 201) throw new Error(`Setup answered ${setup.status}`);
  const cookie = setup.headers["set-cookie"].map((line) => line.split(";")[0]).join("; ");

  // A page it has kept.
  for (let i = 0; i < 300; i++) await ask(base, "/");
  const hits = [];
  for (let i = 0; i < 2000; i++) {
    const { state, took } = serverTiming((await ask(base, "/")).headers);
    if (state !== "hit") throw new Error(`A kept page was a ${state}`);
    hits.push(took);
  }
  report("a kept page, 95 in 100", percentile(hits, 0.95), HIT_P95_MS, "ms");

  // A page it has to make, because something on the site changed.
  const misses = [];
  for (let i = 0; i < 120; i++) {
    const saved = await ask(base, "/api/admin/settings/seo", {
      method: "PUT",
      cookie,
      body: { description: `Fresh bread, take ${i}`, imageId: null },
    });
    if (saved.status !== 200) throw new Error(`Saving a setting answered ${saved.status}`);
    // Not the homepage, which Tend makes again by itself after a change.
    const { state, took } = serverTiming((await ask(base, "/contact")).headers);
    if (state !== "miss") throw new Error(`A page after a change was a ${state}`);
    if (i >= 20) misses.push(took);
  }
  report("a page made afresh, 95 in 100", percentile(misses, 0.95), MISS_P95_MS, "ms");

  // Kept pages while a backup is made and downloaded, as someone waiting for one sees it: how
  // long the answer takes to arrive, with everything it had to wait behind. The download is
  // another process's, so that reading it doesn't hold up the clock here.
  for (let i = 0; i < UPLOAD_COUNT; i++) {
    const last = String(i).padStart(2, "0");
    const dir = join(dataDir, "uploads", "originals", last);
    mkdirSync(dir, { recursive: true });
    const name = `019a0000-0000-7000-8000-0000000000${last}.abcdef012345.jpg`;
    writeFileSync(join(dir, name), randomBytes(UPLOAD_BYTES));
  }
  const started = performance.now();
  const download = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const reply = await fetch(process.argv[1], { headers: { Cookie: process.argv[2] } });
       let bytes = 0;
       for await (const chunk of reply.body) bytes += chunk.length;
       console.log(reply.status, bytes);`,
      `${base}/api/admin/backups/download`,
      cookie,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  let downloaded = "";
  download.stdout.on("data", (chunk) => {
    downloaded += chunk;
  });
  const ended = new Promise((resolve) => download.once("exit", resolve));
  await ask(base, "/");
  const during = [];
  while (download.exitCode === null) {
    during.push((await ask(base, "/")).took);
    await new Promise((resolve) => setImmediate(resolve));
  }
  await ended;
  const [status, bytes] = downloaded.trim().split(" ").map(Number);
  if (status !== 200 || bytes < UPLOAD_COUNT * UPLOAD_BYTES) {
    throw new Error(`The backup answered ${status} with ${bytes} bytes`);
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(
    `  ${during.length} pages asked for while ${Math.round(bytes / 1e6)} MB were saved in ${seconds} s`,
  );
  if (during.length < 200) throw new Error("The backup was over too soon to say anything");
  report(
    "a kept page while a backup is made, 99 in 100",
    percentile(during, 0.99),
    DURING_BACKUP_P99_MS,
    "ms",
  );

  // As many as it can send, to 20 browsers asking again and again.
  const until = performance.now() + 5000;
  let sent = 0;
  const visitor = async () => {
    while (performance.now() < until) {
      await ask(base, "/");
      sent++;
    }
  };
  const began = performance.now();
  await Promise.all(Array.from({ length: 20 }, visitor));
  const perSecond = sent / ((performance.now() - began) / 1000);
  report(
    `kept pages sent in a second${pinned ? ", on one core" : ""}`,
    perSecond,
    PER_SECOND,
    "a second",
    true,
  );
} catch (error) {
  failed = true;
  console.error(`\nThe benchmark failed: ${error.message}\n\nTend's output:\n${output}`);
} finally {
  agent.destroy();
  if (tend.exitCode === null && tend.signalCode === null) {
    const exited = new Promise((resolve) => tend.once("exit", resolve));
    tend.kill("SIGTERM");
    await exited;
  }
  rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(failed ? 1 : 0);
