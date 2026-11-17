// The install smoke test (PLAN.md §14): `npm create tend`, the way a person runs it, from the
// packages as they'd be published. create-tend makes a site, npm installs the packed tendcms
// with its shrinkwrap and no install scripts, and the site boots to its setup screen.
// Run after pnpm build, and after scripts/shrinkwrap.mjs as the release does. It needs the
// npm registry. Zero dependencies, so it runs the same on every OS.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "tend-create-"));
const started = Date.now();

function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`ok - ${message}`);
}

/** Runs npm and returns what it printed. Windows can only run npm.cmd through a shell. */
function npm(args, options = {}) {
  const windows = process.platform === "win32";
  const quoted = args.map((arg) => (/[\s"]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg));
  const result = windows
    ? spawnSync(`npm ${quoted.join(" ")}`, { ...options, encoding: "utf8", shell: true })
    : spawnSync("npm", args, { ...options, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
  return result.stdout;
}

/** Packs a workspace package as npm would publish it, and returns the tarball's path. */
function pack(name) {
  const [packed] = JSON.parse(
    npm(["pack", "--json", "--pack-destination", work], { cwd: join(root, "packages", name) }),
  );
  return join(work, packed.filename);
}

let tend;
try {
  for (const name of ["tendcms", "create-tend"]) {
    if (!existsSync(join(root, "packages", name, "dist"))) {
      throw new Error(`packages/${name}/dist doesn't exist. Run pnpm build first.`);
    }
  }
  const tendcms = pack("tendcms");
  const createTend = pack("create-tend");
  check(true, "tendcms and create-tend pack");

  // As `npm create tend@latest my-site` does, from the packed create-tend. It's told to
  // install the packed tendcms in place of the published one.
  npm(["exec", "--yes", `--package=${createTend}`, "--", "create-tend", "my-site", "--no-start"], {
    cwd: work,
    env: { ...process.env, CREATE_TEND_TENDCMS: `file:${tendcms.replaceAll("\\", "/")}` },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const site = join(work, "my-site");
  for (const file of [".gitignore", ".npmrc", "README.md", "package.json", "themes/README.md"]) {
    check(existsSync(join(site, file)), `create-tend wrote ${file}`);
  }
  const installed = join(site, "node_modules", "tendcms");
  check(
    existsSync(join(installed, "dist", "cli.mjs")),
    "npm installed tendcms, with no install scripts",
  );
  if (existsSync(join(root, "packages", "tendcms", "npm-shrinkwrap.json"))) {
    check(existsSync(join(installed, "npm-shrinkwrap.json")), "the shrinkwrap came with it");
  }
  const lock = JSON.parse(readFileSync(join(site, "package-lock.json"), "utf8"));
  const count = Object.keys(lock.packages).filter((path) => path.includes("node_modules/")).length;
  console.log(`  ${count} packages installed in ${Math.round((Date.now() - started) / 1000)} s`);

  // npm start, then the setup screen.
  tend = spawn(process.execPath, [join(installed, "dist", "cli.mjs"), "start"], {
    cwd: site,
    env: { ...process.env, PORT: "0", TEND_ADMIN_DEV_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  tend.stdout.on("data", (chunk) => {
    output += chunk;
  });
  tend.stderr.on("data", (chunk) => {
    output += chunk;
  });
  let link;
  for (let waited = 0; waited < 600 && !link; waited++) {
    link = output.match(/is running: (http:\/\/\S+)/)?.[1];
    if (tend.exitCode !== null) break;
    if (!link) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  check(link !== undefined, `the site starts${link ? "" : `. It printed:\n${output}`}`);
  const setup = await fetch(new URL("/admin/setup", link));
  check(setup.status === 200, "/admin/setup answers");
  check(existsSync(join(site, "data", "tend.db")), "the site's data is in my-site/data");
} catch (error) {
  console.error(`not ok - ${error.message}`);
  process.exitCode = 1;
} finally {
  if (tend && tend.exitCode === null) {
    const exited = new Promise((resolve) => tend.once("exit", resolve));
    tend.kill();
    await exited;
  }
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
