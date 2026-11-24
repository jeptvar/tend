import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { detectPlatform } from "../src/config.ts";
import { openDatabase } from "../src/db/client.ts";
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

describe("being told to stop", () => {
  // On Windows there's no telling a process to stop that it could answer.
  test.runIf(posixOnly)("leaves the data folder ready to be copied", async () => {
    const dataDir = tempDir();
    const cli = runCli(["start"], { TEND_DATA_DIR: dataDir, PORT: "0" });
    const { origin } = await waitForRunning(cli);
    expect((await fetch(`${origin}/healthz`)).status).toBe(200);
    expect(existsSync(join(dataDir, "tend.db-wal"))).toBe(true);
    const before = performance.now();
    cli.child.kill("SIGTERM");
    expect(await exitedWithin(cli)).toBe(0);
    // Not for a connection that's only kept open.
    expect(performance.now() - before).toBeLessThan(4000);
    // Everything's in the database itself.
    expect(existsSync(join(dataDir, "tend.db-wal"))).toBe(false);
    expect(existsSync(join(dataDir, ".lock"))).toBe(false);
  });
});

describe("the setup link", () => {
  test("carries the code in the fragment, which browsers never send to the server", async () => {
    const cli = runCli(["start"], { TEND_DATA_DIR: tempDir(), PORT: "0" });
    try {
      const url = await waitForRunning(cli);
      expect(url.pathname).toBe("/admin/setup");
      expect(url.hash).toMatch(/^#code=[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    } finally {
      await cli.stop();
    }
  });

  test("stays the same after a restart, so an open tab keeps working", async () => {
    const dataDir = tempDir();
    const first = runCli(["start"], { TEND_DATA_DIR: dataDir, PORT: "0" });
    const firstCode = (await waitForRunning(first)).hash;
    await first.stop();
    const second = runCli(["start"], { TEND_DATA_DIR: dataDir, PORT: "0" });
    try {
      expect((await waitForRunning(second)).hash).toBe(firstCode);
    } finally {
      await second.stop();
    }
  });

  test("never prints a setup password someone chose", async () => {
    const cli = runCli(["start"], {
      TEND_DATA_DIR: tempDir(),
      PORT: "0",
      TEND_SETUP_CODE: "my-chosen-password",
    });
    try {
      const url = await waitForRunning(cli);
      expect(url.hash).toBe("");
      expect(cli.output()).not.toContain("my-chosen-password");
    } finally {
      await cli.stop();
    }
  });
});

describe("setting up through the real server", () => {
  const password = "maple-river-candle-stone-orbit";

  async function setUpSite(dataDir: string) {
    const cli = runCli(["start"], { TEND_DATA_DIR: dataDir, PORT: "0" });
    const url = await waitForRunning(cli);
    const reply = await fetch(new URL("/api/auth/setup", url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: url.hash.replace("#code=", ""),
        site: { name: "Rise Bakery" },
        owner: { name: "Tom", email: "tom@example.com", password },
        starter: "blog",
      }),
    });
    expect(reply.status).toBe(201);
    return { cli, url, reply };
  }

  test("pages published by an older renderer are brought up to date when Tend starts", async () => {
    const dataDir = tempDir();
    const { cli } = await setUpSite(dataDir);
    await cli.stop();
    // As an older Tend would have left them.
    const db = openDatabase(join(dataDir, "tend.db"));
    db.prepare("UPDATE revisions SET html = ? WHERE html IS NOT NULL").run("<p>Old renderer</p>");
    db.prepare("DELETE FROM schema_meta WHERE key = 'render_version'").run();
    db.close();

    const second = runCli(["start"], { TEND_DATA_DIR: dataDir, PORT: "0" });
    try {
      const url = await waitForRunning(second);
      expect(second.output()).toMatch(/Updated \d+ published pages for this version of Tend/);
      const home = await (await fetch(new URL("/", url))).text();
      expect(home).not.toContain("Old renderer");
    } finally {
      await second.stop();
    }
  });

  test("setup works, and the next start offers the admin instead of setup", async () => {
    const dataDir = tempDir();
    const { cli } = await setUpSite(dataDir);
    await cli.stop();

    const second = runCli(["start"], { TEND_DATA_DIR: dataDir, PORT: "0" });
    try {
      const url = await waitForRunning(second);
      expect(url.pathname).toBe("/admin/");
      expect(url.hash).toBe("");
    } finally {
      await second.stop();
    }
  });

  test("setup-code shows the same code, then says when setup is finished", async () => {
    const dataDir = tempDir();
    const running = runCli(["start"], { TEND_DATA_DIR: dataDir, PORT: "0" });
    const url = await waitForRunning(running);

    // Runs beside the server: it mustn't need the lock.
    const code = runCli(["setup-code"], { TEND_DATA_DIR: dataDir });
    expect(await exitedWithin(code)).toBe(0);
    expect(code.output().trim()).toBe(url.hash.replace("#code=", ""));
    await running.stop();

    const { cli } = await setUpSite(dataDir);
    const after = runCli(["setup-code"], { TEND_DATA_DIR: dataDir });
    expect(await exitedWithin(after)).toBe(0);
    expect(after.output()).toContain("already set up");
    await cli.stop();
  });

  test("setup-code and reset-password explain themselves in an empty folder", async () => {
    const dataDir = tempDir();
    for (const args of [["setup-code"], ["reset-password", "a@example.com"]]) {
      const cli = runCli(args, { TEND_DATA_DIR: dataDir });
      expect(await exitedWithin(cli)).toBe(1);
      expect(cli.output()).toContain("Start Tend first");
      expect(cli.output()).not.toContain("    at ");
    }
    // Asking mustn't create a site as a side effect.
    expect(readdirSync(dataDir)).toEqual([]);
  });

  test("reset-password gives a working password and ends every session", async () => {
    const dataDir = tempDir();
    const { cli, url, reply } = await setUpSite(dataDir);
    try {
      const cookie = reply.headers
        .getSetCookie()
        .map((line) => line.split(";")[0])
        .join("; ");
      const me = () => fetch(new URL("/api/auth/me", url), { headers: { Cookie: cookie } });
      expect((await me()).status).toBe(200);

      const reset = runCli(["reset-password", "TOM@example.com"], { TEND_DATA_DIR: dataDir });
      expect(await exitedWithin(reset)).toBe(0);
      const newPassword = reset.output().match(/New password for tom@example\.com: (\S+)/)?.[1];
      expect(newPassword).toBeTruthy();

      expect((await me()).status).toBe(401);
      const login = (candidate: string | undefined) =>
        fetch(new URL("/api/auth/login", url), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "tom@example.com", password: candidate }),
        });
      expect((await login(password)).status).toBe(401);
      expect((await login(newPassword)).status).toBe(200);
    } finally {
      await cli.stop();
    }
  });

  test("reset-password explains an unknown or missing email", async () => {
    const dataDir = tempDir();
    const { cli } = await setUpSite(dataDir);
    try {
      const unknown = runCli(["reset-password", "nobody@example.com"], { TEND_DATA_DIR: dataDir });
      expect(await exitedWithin(unknown)).toBe(1);
      expect(unknown.output()).toContain("No account uses nobody@example.com");
      expect(unknown.output()).toContain("tom@example.com (Owner)");
      const missing = runCli(["reset-password"], { TEND_DATA_DIR: dataDir });
      expect(await exitedWithin(missing)).toBe(1);
      expect(missing.output()).toContain("Say which account");
    } finally {
      await cli.stop();
    }
  });
});

describe("what Tend prints when it starts", () => {
  test("a new site names the code, says how to restart, and reports no update", async () => {
    const cli = runCli(["start"], { TEND_DATA_DIR: tempDir(), PORT: "0" });
    try {
      const url = await waitForRunning(cli);
      const code = url.hash.replace("#code=", "");
      await vi.waitFor(() => expect(cli.output()).toContain("To start again: cd "));
      expect(cli.output()).toContain(`Setup code, if Tend asks for it: ${code}`);
      expect(cli.output()).not.toContain("Updated the database");
    } finally {
      await cli.stop();
    }
  });

  test("the site's public address is the link, when it's known", async () => {
    const cli = runCli(["start"], {
      TEND_DATA_DIR: tempDir(),
      PORT: "0",
      TEND_PUBLIC_URL: "https://cms.example.test",
    });
    try {
      // Waits as long as waitForRunning does, which can't be used here because it only
      // reads http:// links. vi.waitFor's own second is too short for a cold start on Windows.
      await vi.waitFor(() => expect(cli.output()).toMatch(/is (running|listening)/), {
        timeout: 15_000,
      });
      if (detectPlatform(cleanEnv({})) === "local") {
        expect(cli.output()).toContain("https://cms.example.test/admin/setup#code=");
        expect(cli.output()).not.toContain("localhost");
      }
    } finally {
      await cli.stop();
    }
  });

  test("the development runner's restart advice isn't shown", async () => {
    const cli = runCli(["start"], {
      TEND_DATA_DIR: tempDir(),
      PORT: "0",
      TEND_ADMIN_DEV_URL: "http://localhost:5173",
    });
    try {
      await waitForRunning(cli);
      await vi.waitFor(() => expect(cli.output()).toContain("Keep this window open"));
      expect(cli.output()).not.toContain("To start again");
    } finally {
      await cli.stop();
    }
  });
});

describe("private files", () => {
  test.runIf(posixOnly)(
    "are readable only by this account, even if they were loosened",
    async () => {
      const parent = tempDir();
      const dataDir = join(parent, "data");
      const first = runCli(["start"], { TEND_DATA_DIR: dataDir, PORT: "0" });
      await waitForRunning(first);
      const mode = (name: string) => statSync(join(dataDir, name)).mode & 0o777;
      for (const file of ["tend.db", "tend.db-wal", "secret.key"]) {
        expect(mode(file), file).toBe(0o600);
      }
      for (const folder of ["", "backups", "uploads"]) {
        expect(mode(folder), folder).toBe(0o700);
      }
      await first.stop();

      chmodSync(join(dataDir, "secret.key"), 0o644);
      chmodSync(join(dataDir, "tend.db"), 0o644);
      const second = runCli(["start"], { TEND_DATA_DIR: dataDir, PORT: "0" });
      try {
        await waitForRunning(second);
        expect(mode("secret.key")).toBe(0o600);
        expect(mode("tend.db")).toBe(0o600);
      } finally {
        await second.stop();
      }
    },
  );
});

describe("configuration mistakes", () => {
  test.each([
    [{ TEND_SETUP_CODE: "short" }, "too short"],
    [{ TEND_PUBLIC_URL: "not a url" }, "isn't a web address"],
    [{ TEND_PUBLIC_URL: "ftp://example.com" }, "needs to start with https://"],
    [{ TEND_TRUST_PROXY: "lots" }, "how many proxies"],
  ])("%j explains itself", async (env, message) => {
    const cli = runCli(["start"], { TEND_DATA_DIR: tempDir(), PORT: "0", ...env });
    expect(await exitedWithin(cli)).toBe(1);
    expect(cli.output()).toContain(message);
    expect(cli.output()).not.toContain("    at ");
  });
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
