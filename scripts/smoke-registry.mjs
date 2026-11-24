// The last check before a release is published (PLAN.md §14): `npm create tend@latest`, from a
// registry where tendcms and create-tend came out an hour ago. That's when some people's npm
// won't install them yet, because they've told it to wait some days (min-release-age). create-tend
// is meant to explain that and install this one all the same, with everything under it pinned to
// versions that are older.
//
//   node scripts/smoke-registry.mjs --packages <folder>
//
// The folder holds the two tarballs as they'll be published. It needs the npm registry, for what
// tendcms depends on. Zero dependencies, so it runs the same on every OS.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { check, checkMade, checkStarts, installedPackages, npmMeanwhile } from "./installing.mjs";
import { readTarball, startRegistry } from "./registry.mjs";

const HOUR_MS = 60 * 60 * 1000;
const WAIT_DAYS = 7;

const { packages } = parseArgs({ options: { packages: { type: "string" } } }).values;
if (!packages) {
  console.error("Say where the tarballs are: --packages <folder>");
  process.exit(1);
}
const tarballs = readdirSync(packages)
  .filter((name) => name.endsWith(".tgz"))
  .map((name) => resolve(packages, name));
const tarballOf = (name) => tarballs.find((path) => new RegExp(`[\\\\/]${name}-\\d`).test(path));

const work = mkdtempSync(join(tmpdir(), "tend-registry-"));
let registry;
try {
  const tendcms = tarballOf("tendcms");
  const createTend = tarballOf("create-tend");
  check(tendcms && createTend, "tendcms and create-tend are there to be published");
  const files = readTarball(readFileSync(tendcms));
  const { version } = JSON.parse(files.get("package/package.json").toString("utf8"));
  const shrinkwrap = files.get("package/npm-shrinkwrap.json");
  check(shrinkwrap !== undefined, "tendcms has its shrinkwrap");
  const pinned = JSON.parse(shrinkwrap.toString("utf8")).packages;

  registry = await startRegistry({ tarballs, publishedAt: Date.now() - HOUR_MS });

  for (const waits of [false, true]) {
    console.log(`\n${waits ? `With npm told to wait ${WAIT_DAYS} days` : "With npm as it comes"}:`);
    // A computer of its own: nothing in its cache, and its own settings.
    const home = join(work, waits ? "waits" : "plain");
    mkdirSync(home);
    const settings = join(home, "npmrc");
    writeFileSync(
      settings,
      `registry=${registry.url}/\n${waits ? `min-release-age=${WAIT_DAYS}\n` : ""}`,
    );
    const env = {
      ...process.env,
      npm_config_userconfig: settings,
      npm_config_cache: join(home, "cache"),
    };
    // What npm running this set for itself would win over the settings above.
    delete env.npm_config_registry;

    if (waits) {
      // Or there would be nothing to see here.
      const refused = await npmMeanwhile(
        ["install", "--ignore-scripts", `tendcms@${version}`, "--prefix", join(home, "refused")],
        { cwd: home, env },
      ).then(
        () => false,
        (error) => /ETARGET|ENOVERSIONS|No (?:matching )?version/i.test(error.message),
      );
      check(refused, "npm won't install one this new by itself");
    }
    // npm that's told to wait won't fetch an installer this new either. Whoever has one all the
    // same, by telling npm not to wait for it, is who the explanation is for.
    const installer = waits
      ? ["exec", "--yes", `--package=${createTend}`, "--", "create-tend", "my-site", "--no-start"]
      : ["create", "--yes", "tend@latest", "my-site", "--", "--no-start"];
    const printed = await npmMeanwhile(installer, { cwd: home, env });
    check(
      printed.includes(`You've set npm to wait ${WAIT_DAYS} days`) === waits,
      waits ? "it explains why this one doesn't wait" : "it has nothing to explain",
    );
    const site = join(home, "my-site");
    const installed = checkMade(site);

    // What was tested is what's installed, whatever has come out since.
    const own = Object.entries(installedPackages(site)).filter(
      ([path, { optional }]) => path !== "node_modules/tendcms" && !optional,
    );
    const different = own.filter(([path, { version }]) => {
      const name = path.slice(path.lastIndexOf("node_modules/"));
      return pinned[name]?.version !== version;
    });
    check(
      own.length > 0 && different.length === 0,
      `everything under it is the version it's pinned to (${own.length} packages)`,
    );
    await checkStarts(site, installed);
  }
} catch (error) {
  console.error(`not ok - ${error.message}`);
  process.exitCode = 1;
} finally {
  await registry?.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
