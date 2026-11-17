import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  folderProblem,
  nodeProblem,
  packageName,
  projectFiles,
  releaseAgeDays,
  writeProject,
} from "../src/scaffold.ts";

const CLI = join(import.meta.dirname, "..", "src", "index.ts");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "create-tend-"));
}

describe("what create-tend checks", () => {
  test("Node 24 or newer, and says where to get it otherwise", () => {
    expect(nodeProblem("v24.0.0")).toBeUndefined();
    expect(nodeProblem("v26.13.1")).toBeUndefined();
    expect(nodeProblem("v22.23.4")).toMatch(/needs Node\.js 24 or newer.*v22\.23\.4/s);
    expect(nodeProblem("v18.20.0")).toContain("https://tendcms.dev/install-node");
  });

  test("only a new or empty folder, so nothing of anyone's is changed", () => {
    const root = tempDir();
    expect(folderProblem(join(root, "new"))).toBeUndefined();
    mkdirSync(join(root, "empty"));
    expect(folderProblem(join(root, "empty"))).toBeUndefined();
    mkdirSync(join(root, "used"));
    writeFileSync(join(root, "used", "notes.txt"), "mine");
    expect(folderProblem(join(root, "used"))).toContain("already has files in it");
    writeFileSync(join(root, "file"), "");
    expect(folderProblem(join(root, "file"))).toContain("There's already a file called file");
  });

  test("a package name npm accepts, from any folder name", () => {
    expect(packageName("my-site")).toBe("my-site");
    expect(packageName("Rise Bakery!")).toBe("rise-bakery");
    expect(packageName(join("sites", ".Café"))).toBe("caf");
    expect(packageName("...")).toBe("my-site");
  });

  test("a release age only when the person set one", () => {
    expect(releaseAgeDays("undefined\n")).toBe(0);
    expect(releaseAgeDays("")).toBe(0);
    expect(releaseAgeDays("0")).toBe(0);
    expect(releaseAgeDays("7\n")).toBe(7);
  });
});

describe("what create-tend writes", () => {
  test("the exact tendcms version, and no release-age gate", () => {
    const files = projectFiles({ name: "rise-bakery", tendcms: "0.1.0" });
    expect(Object.keys(files).sort()).toEqual([
      ".gitignore",
      ".npmrc",
      "README.md",
      "package.json",
      "themes/README.md",
    ]);
    expect(JSON.parse(files["package.json"] as string)).toEqual({
      name: "rise-bakery",
      private: true,
      description: "A website made with Tend CMS",
      scripts: { start: "tendcms start", backup: "tendcms backup" },
      dependencies: { tendcms: "0.1.0" },
      engines: { node: ">=24" },
    });
    expect(files[".npmrc"]).toBe("save-exact=true\n");
    expect(files[".gitignore"]).toBe("data/\nnode_modules/\n.env\n");
    expect(files["README.md"]).toContain("## Where can this run?");
  });

  test("never over a file that's there", () => {
    const dir = tempDir();
    writeProject(dir, { "a.txt": "first" });
    expect(() => writeProject(dir, { "a.txt": "second" })).toThrow(/EEXIST/);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("first");
  });
});

describe("npm create tend", () => {
  /**
   * Runs create-tend the way npm does, with a stand-in for npm that writes down what it was
   * asked and installs nothing. `releaseAge` is what it answers for min-release-age.
   */
  function create(args: string[], releaseAge = "undefined") {
    const root = tempDir();
    const fakeNpm = join(root, "npm-cli.js");
    const log = join(root, "npm.log");
    writeFileSync(
      fakeNpm,
      `const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
if (args[0] === "config") console.log(${JSON.stringify(releaseAge)});`,
    );
    // Names in Windows' environment ignore case, so any copy that's there already goes first:
    // it could win over this one.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(npm_execpath|create_tend_tendcms)$/i.test(key),
      ),
    );
    const run = spawnSync(process.execPath, [CLI, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...env, npm_execpath: fakeNpm },
    });
    const calls = () => readFileSync(log, "utf8").trim().split("\n");
    return { root, run, calls };
  }

  test("writes the site, installs Tend with no install scripts, and says what's next", () => {
    const { root, run, calls } = create(["rise-bakery", "--no-start"]);
    expect(run.status).toBe(0);
    expect(readdirSync(join(root, "rise-bakery")).sort()).toEqual([
      ".gitignore",
      ".npmrc",
      "README.md",
      "package.json",
      "themes",
    ]);
    const pkg = JSON.parse(readFileSync(join(root, "rise-bakery", "package.json"), "utf8"));
    expect(pkg.dependencies.tendcms).toBe("0.0.0");
    expect(calls()).toEqual([
      "config get min-release-age",
      "install --ignore-scripts --no-audit --no-fund",
    ]);
    expect(run.stdout).toContain("cd rise-bakery");
    expect(run.stdout).toContain("npm start");
  });

  test("installs a new Tend even when npm is set to wait for new releases", () => {
    const { run, calls } = create(["my-site", "--no-start"], "7");
    expect(run.status).toBe(0);
    expect(calls()[1]).toBe("install --ignore-scripts --no-audit --no-fund --min-release-age=0");
    expect(run.stdout).toContain("wait 7 days");
  });

  test("leaves a folder with files in it alone", () => {
    const root = tempDir();
    mkdirSync(join(root, "taken"));
    writeFileSync(join(root, "taken", "notes.txt"), "mine");
    const run = spawnSync(process.execPath, [CLI, "taken"], { cwd: root, encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("already has files in it");
    expect(readdirSync(join(root, "taken"))).toEqual(["notes.txt"]);
  });

  test("refuses an option it doesn't know", () => {
    const run = spawnSync(process.execPath, [CLI, "site", "--yes"], { encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`"--yes" isn't something create-tend understands`);
  });
});
