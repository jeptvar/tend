// What the tests of installing Tend share (smoke-create.mjs and smoke-registry.mjs): running
// npm, and starting the site that was made. Zero dependencies.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`ok - ${message}`);
}

/** How npm is started. Windows can only run npm.cmd through a shell. */
function npmCommand(args) {
  if (process.platform !== "win32") return { command: "npm", args, shell: false };
  const quoted = args.map((arg) => (/[\s"]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg));
  return { command: `npm ${quoted.join(" ")}`, args: [], shell: true };
}

/** Runs npm and returns what it printed. */
export function npm(args, options = {}) {
  const { command, args: given, shell } = npmCommand(args);
  const result = spawnSync(command, given, { ...options, encoding: "utf8", shell });
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
  return result.stdout;
}

/** The same, while this process goes on: serving what npm asks for, say. */
export function npmMeanwhile(args, options = {}) {
  const { command, args: given, shell } = npmCommand(args);
  return new Promise((resolve, reject) => {
    const child = spawn(command, given, { ...options, shell, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        output += chunk;
      });
    }
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`npm ${args.join(" ")} failed:\n${output}`));
    });
  });
}

/** Packs a workspace package as npm would publish it, and returns the tarball's path. */
export function pack(root, name, destination) {
  const folder = join(root, "packages", name);
  if (!existsSync(join(folder, "dist"))) {
    throw new Error(`packages/${name}/dist doesn't exist. Run pnpm build first.`);
  }
  const [packed] = JSON.parse(
    npm(["pack", "--json", "--pack-destination", destination], { cwd: folder }),
  );
  return join(destination, packed.filename);
}

/** What create-tend writes is there, and npm installed Tend. Returns where. */
export function checkMade(site) {
  for (const file of [".gitignore", ".npmrc", "README.md", "package.json", "themes/README.md"]) {
    check(existsSync(join(site, file)), `create-tend wrote ${file}`);
  }
  const installed = join(site, "node_modules", "tendcms");
  check(
    existsSync(join(installed, "dist", "cli.mjs")),
    "npm installed tendcms, with no install scripts",
  );
  return installed;
}

/** Everything npm installed, by where it is. */
export function installedPackages(site) {
  const { packages } = JSON.parse(readFileSync(join(site, "package-lock.json"), "utf8"));
  return Object.fromEntries(
    Object.entries(packages).filter(([path]) => path.includes("node_modules/")),
  );
}

/** npm start, then the setup screen. */
export async function checkStarts(site, installed) {
  const tend = spawn(process.execPath, [join(installed, "dist", "cli.mjs"), "start"], {
    cwd: site,
    env: { ...process.env, PORT: "0", TEND_ADMIN_DEV_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    let output = "";
    for (const stream of [tend.stdout, tend.stderr]) {
      stream.on("data", (chunk) => {
        output += chunk;
      });
    }
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
  } finally {
    if (tend.exitCode === null) {
      const exited = new Promise((resolve) => tend.once("exit", resolve));
      tend.kill();
      await exited;
    }
  }
}
