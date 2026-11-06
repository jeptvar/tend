import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { detectPlatform } from "../src/config.ts";
import { appVersion } from "../src/paths.ts";
import { cleanEnv, exitedWithin, runCli, tempDir, waitForRunning } from "./helpers.ts";

const posixOnly = process.platform !== "win32";

describe("tendcms start", () => {
  test("boots on an empty data folder and answers /healthz", async () => {
    const dataDir = join(tempDir(), "data");
    const cli = runCli(["start"], { TEND_DATA_DIR: dataDir, PORT: "0" });
    try {
      const setupUrl = await waitForRunning(cli);
      if (detectPlatform(cleanEnv({})) === "local") {
        await vi.waitFor(() => expect(cli.output()).toContain("Keep this window open"));
      }

      const health = await fetch(new URL("/healthz", setupUrl));
      expect(health.status).toBe(200);
      expect(health.headers.get("cache-control")).toBe("no-store");
      expect(await health.json()).toEqual({ ok: true, version: appVersion });

      const setup = await fetch(setupUrl);
      expect(setup.status).toBe(200);
      expect(setup.headers.get("content-type")).toContain("text/html");

      for (const entry of ["tend.db", "uploads", "backups", "secret.key", ".lock.db"]) {
        expect(existsSync(join(dataDir, entry)), entry).toBe(true);
      }
      if (posixOnly) {
        expect(statSync(join(dataDir, "secret.key")).mode & 0o777).toBe(0o600);
      }
    } finally {
      await cli.stop();
    }
    if (posixOnly) {
      expect(existsSync(join(dataDir, ".lock"))).toBe(false);
    }
  });

  test("starts again on the same folder without changing the key or the data", async () => {
    const dataDir = tempDir();
    const first = runCli(["start"], { TEND_DATA_DIR: dataDir, PORT: "0" });
    await waitForRunning(first);
    const key = readFileSync(join(dataDir, "secret.key"), "utf8");
    await first.stop();

    const second = runCli(["start"], { TEND_DATA_DIR: dataDir, PORT: "0" });
    try {
      const setupUrl = await waitForRunning(second);
      expect((await fetch(new URL("/healthz", setupUrl))).status).toBe(200);
      expect(readFileSync(join(dataDir, "secret.key"), "utf8")).toBe(key);
      expect(readdirSync(join(dataDir, "backups"))).toEqual([]);
      expect(second.output()).not.toContain("Updated the database");
    } finally {
      await second.stop();
    }
  });

  test("a second Tend can't use the same data folder", async () => {
    const dataDir = tempDir();
    const first = runCli(["start"], { TEND_DATA_DIR: dataDir, PORT: "0" });
    const second = { current: undefined as ReturnType<typeof runCli> | undefined };
    try {
      await waitForRunning(first);
      second.current = runCli(["start"], { TEND_DATA_DIR: dataDir, PORT: "0" });
      expect(await exitedWithin(second.current)).toBe(1);
      expect(second.current.output()).toContain("already running with this data folder");
    } finally {
      await second.current?.stop();
      await first.stop();
    }
  });

  test.runIf(posixOnly)("closing the window stops Tend cleanly", async () => {
    const dataDir = tempDir();
    const cli = runCli(["start"], { TEND_DATA_DIR: dataDir, PORT: "0" });
    await waitForRunning(cli);
    cli.child.kill("SIGHUP");
    expect(await exitedWithin(cli)).toBe(0);
    expect(existsSync(join(dataDir, ".lock"))).toBe(false);
  });

  test("starts after a crash left the lock's info file behind", async () => {
    const dataDir = tempDir();
    const first = runCli(["start"], { TEND_DATA_DIR: dataDir, PORT: "0" });
    await waitForRunning(first);
    first.child.kill("SIGKILL");
    await first.exited;

    // Pointing at a process that's alive right now must not block the start.
    writeFileSync(join(dataDir, ".lock"), JSON.stringify({ pid: process.pid, startedAt: 1 }));
    const second = runCli(["start"], { TEND_DATA_DIR: dataDir, PORT: "0" });
    try {
      await waitForRunning(second);
    } finally {
      await second.stop();
    }
  });

  test("refuses to start on a serverless host", async () => {
    const cli = runCli(["start"], { TEND_DATA_DIR: tempDir(), PORT: "0", VERCEL: "1" });
    expect(await exitedWithin(cli)).toBe(1);
    expect(cli.output()).toContain("Tend can't run on Vercel");
  });

  test("won't start with a damaged key file", async () => {
    const dataDir = tempDir();
    const first = runCli(["start"], { TEND_DATA_DIR: dataDir, PORT: "0" });
    await waitForRunning(first);
    await first.stop();
    writeFileSync(join(dataDir, "secret.key"), "");

    const second = runCli(["start"], { TEND_DATA_DIR: dataDir, PORT: "0" });
    expect(await exitedWithin(second)).toBe(1);
    expect(second.output()).toContain("is damaged");
    expect(readFileSync(join(dataDir, "secret.key"), "utf8")).toBe("");
  });

  test("explains a data folder path that isn't a folder", async () => {
    const file = join(tempDir(), "a-file");
    writeFileSync(file, "");
    const cli = runCli(["start"], { TEND_DATA_DIR: file, PORT: "0" });
    expect(await exitedWithin(cli)).toBe(1);
    expect(cli.output()).toContain("can't write to its data folder");
    expect(cli.output()).toContain("https://tendcms.dev/errors/data_not_writable");
    expect(cli.output()).not.toContain("    at ");
  });

  test.runIf(posixOnly && process.getuid?.() !== 0)(
    "a read-only lock file stops Tend instead of letting two copies share a folder",
    async () => {
      const dataDir = tempDir();
      const first = runCli(["start"], { TEND_DATA_DIR: dataDir, PORT: "0" });
      await waitForRunning(first);
      await first.stop();
      chmodSync(join(dataDir, ".lock.db"), 0o444);

      const cli = runCli(["start"], { TEND_DATA_DIR: dataDir, PORT: "0" });
      expect(await exitedWithin(cli)).toBe(1);
      expect(cli.output()).toContain("can't write to its data folder");
    },
  );

  test("a damaged lock file is named, not blamed on permissions", async () => {
    const dataDir = tempDir();
    writeFileSync(join(dataDir, ".lock.db"), randomBytes(4096));
    const cli = runCli(["start"], { TEND_DATA_DIR: dataDir, PORT: "0" });
    expect(await exitedWithin(cli)).toBe(1);
    expect(cli.output()).toContain("is damaged");
    expect(cli.output()).toContain(".lock.db");
    expect(cli.output()).not.toContain("write access");
  });

  test.runIf(posixOnly && process.getuid?.() !== 0)(
    "stops cleanly even if the lock's info file can't be removed",
    async () => {
      const dataDir = tempDir();
      const cli = runCli(["start"], { TEND_DATA_DIR: dataDir, PORT: "0" });
      await waitForRunning(cli);
      chmodSync(dataDir, 0o500);
      try {
        cli.child.kill("SIGTERM");
        expect(await exitedWithin(cli)).toBe(0);
        expect(cli.output()).not.toContain("EACCES");
      } finally {
        chmodSync(dataDir, 0o700);
      }
    },
  );

  test.runIf(posixOnly && process.getuid?.() !== 0)(
    "explains a read-only data folder",
    async () => {
      const dataDir = tempDir();
      chmodSync(dataDir, 0o500);
      try {
        const cli = runCli(["start"], { TEND_DATA_DIR: dataDir, PORT: "0" });
        expect(await exitedWithin(cli)).toBe(1);
        expect(cli.output()).toContain("can't write to its data folder");
        expect(cli.output()).not.toContain("    at ");
      } finally {
        chmodSync(dataDir, 0o700);
      }
    },
  );
});

describe("the command line", () => {
  test.each([
    [["start", "--port", "4000"], "That isn't a Tend option"],
    [["launch"], `"launch" isn't a Tend command`],
  ])("%j explains itself instead of printing a stack trace", async (args, message) => {
    const cli = runCli(args, { TEND_DATA_DIR: tempDir() });
    expect(await exitedWithin(cli)).toBe(1);
    expect(cli.output()).toContain(message);
    expect(cli.output()).toContain("Usage: tendcms <command>");
    expect(cli.output()).not.toContain("node:internal");
  });

  test("--version prints the version", async () => {
    const cli = runCli(["--version"], {});
    expect(await exitedWithin(cli)).toBe(0);
    expect(cli.output().trim()).toBe(appVersion);
  });
});
