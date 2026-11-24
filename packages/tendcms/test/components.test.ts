import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { COMPONENTS, componentError, loadComponents } from "../src/components.ts";
import { appVersion } from "../src/paths.ts";
import { exitedWithin, runCli, tempDir } from "./helpers.ts";

// What each package says when it can't load, cut short after the advice it goes on to give.
const SHARP = [
  'Could not load the "sharp" module using the linux-x64 runtime',
  "ERR_DLOPEN_FAILED: libvips-cpp.so: cannot open shared object file",
  "Possible solutions:",
  "- Ensure optional dependencies can be installed:",
  "    npm install --include=optional sharp",
].join("\n");
const OLD_PROCESSOR = [
  'Could not load the "sharp" module using the linux-x64 runtime',
  "Unsupported CPU: Prebuilt binaries for Linux x64 require v2 microarchitecture",
  "Possible solutions:",
  "- Ensure optional dependencies can be installed:",
].join("\n");
const ARGON2 =
  "Cannot find native binding. npm has a bug related to optional dependencies (https://github.com/npm/cli/issues/4828). Please try `npm i` again after removing both package-lock.json and node_modules directory.";
const SQLITE = [
  "Cannot find module '/my-site/node_modules/better-sqlite3/build/Release/better_sqlite3.node'",
  "Require stack:",
  "- /my-site/node_modules/better-sqlite3/lib/binding.js",
].join("\n");

describe("a component that can't load on this computer", () => {
  test("is named, with why and what to do, and without its own package's advice", () => {
    const say = (name: string, message: string) => componentError({ name }, new Error(message));
    expect(say("picture", SHARP).message).toBe(
      `Tend's picture component couldn't load on this computer (Could not load the "sharp" module using the linux-x64 runtime: ERR_DLOPEN_FAILED: libvips-cpp.so: cannot open shared object file). Install Tend again, or use the Docker version: https://tendcms.dev/errors/component`,
    );
    expect(say("password", ARGON2).message).toContain("(Cannot find native binding).");
    expect(say("database", SQLITE).message).toContain(
      "(Cannot find module '/my-site/node_modules/better-sqlite3/build/Release/better_sqlite3.node').",
    );
    expect(say("picture", "Something else").message).toContain("(Something else).");
  });

  test("doesn't say to install again when it's the processor that's too old", () => {
    const { message } = componentError({ name: "picture" }, new Error(OLD_PROCESSOR));
    expect(message).toContain(
      "require v2 microarchitecture). This computer's processor is too old",
    );
    expect(message).not.toContain("Install Tend again");
  });

  function without(pkg: string, message: string): Record<string, string> {
    const hook = pathToFileURL(join(import.meta.dirname, "block-package.mjs")).href;
    return { NODE_OPTIONS: `--import=${hook}`, BLOCK_PACKAGE: pkg, BLOCK_MESSAGE: message };
  }

  test.each([
    ["database", "better-sqlite3", SQLITE],
    ["picture", "sharp", SHARP],
    ["password", "@node-rs/argon2", ARGON2],
  ])("stops Tend with a sentence, not a stack trace: %s", async (name, pkg, message) => {
    const env = { ...without(pkg, message), TEND_DATA_DIR: tempDir(), PORT: "0" };
    const start = runCli(["start"], env);
    expect(await exitedWithin(start)).toBe(1);
    expect(start.output()).toContain(`Tend's ${name} component couldn't load on this computer`);
    expect(start.output()).not.toMatch(/^\s+at /m);

    const version = runCli(["--version"], env);
    expect(await exitedWithin(version)).toBe(0);
    expect(version.output().trim()).toBe(appVersion);
    const help = runCli(["--help"], env);
    expect(await exitedWithin(help)).toBe(0);
    expect(help.output()).toContain("Usage: tendcms <command>");
  });
});

test("every component loads here", async () => {
  expect(COMPONENTS.map(({ name }) => name)).toEqual(["database", "picture", "password"]);
  await loadComponents();
});
