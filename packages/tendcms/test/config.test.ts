import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  type Config,
  ConfigError,
  checkNodeVersion,
  ensureSecretKey,
  explainDataFolderFailure,
  loadConfig,
  parseSecretKey,
  portsToTry,
  prepareDataDir,
  readSecretKey,
  SECRET_KEY_BYTES,
  secretKeyText,
} from "../src/config.ts";
import { tempDir } from "./helpers.ts";

function configIn(dataDir: string): Config {
  return loadConfig({ TEND_DATA_DIR: dataDir });
}

describe("checkNodeVersion", () => {
  test("refuses Node below 24 with a way forward", () => {
    expect(() => checkNodeVersion("20.20.2")).toThrow(ConfigError);
    expect(() => checkNodeVersion("23.11.0")).toThrow(/Node\.js 24 or newer.*23\.11\.0/);
    expect(() => checkNodeVersion("23.11.0")).toThrow("https://tendcms.dev/install-node");
  });

  test.each(["24.0.0", "26.12.1", "30.1.0"])("accepts %s", (version) => {
    expect(() => checkNodeVersion(version)).not.toThrow();
  });
});

describe("portsToTry", () => {
  test("uses exactly PORT when it's set", () => {
    expect(portsToTry({ port: 4000, platform: "local" })).toEqual([4000]);
    expect(portsToTry({ port: 4000, platform: "docker" })).toEqual([4000]);
  });

  test("falls back through 3001–3010 only when running locally", () => {
    const local = portsToTry({ port: undefined, platform: "local" });
    expect(local[0]).toBe(3000);
    expect(local.at(-1)).toBe(3010);
    expect(local).toHaveLength(11);
    expect(portsToTry({ port: undefined, platform: "railway" })).toEqual([3000]);
    expect(portsToTry({ port: undefined, platform: "docker" })).toEqual([3000]);
  });

  test("PORT=0 can ask the system again", () => {
    expect(portsToTry({ port: 0, platform: "local" })).toEqual([0, 0, 0]);
  });
});

describe("loadConfig", () => {
  test.each(["abc", "-1", "70000", "3.5"])("rejects PORT=%s", (value) => {
    expect(() => loadConfig({ PORT: value })).toThrow(/isn't a port number/);
  });

  test("TEND_HOST replaces the default addresses", () => {
    expect(loadConfig({ TEND_HOST: "10.0.0.5" }).hosts).toEqual(["10.0.0.5"]);
  });

  test("the image says it's in a container, because not every runtime leaves a sign", () => {
    const config = loadConfig({ TEND_PLATFORM: "docker" });
    expect(config.platform).toBe("docker");
    expect(config.hosts).toEqual(["0.0.0.0"]);
    expect(config.pageCacheBytes).toBeGreaterThan(0);
    expect(loadConfig({ TEND_PLATFORM: "docker", RENDER: "1" }).platform).toBe("render");
  });

  test("the site only counts as public with a real address", () => {
    expect(loadConfig({ TEND_PUBLIC_URL: "https://example.com" }).isPublic).toBe(true);
    expect(loadConfig({ TEND_PUBLIC_URL: "http://localhost:3000" }).isPublic).toBe(false);
    expect(loadConfig({ RAILWAY_ENVIRONMENT: "x" }).isPublic).toBe(true);
    expect(loadConfig({ TEND_PLATFORM: "docker" }).isPublic).toBe(false);
  });

  test("hosting platforms listen on all addresses", () => {
    expect(loadConfig({ RENDER: "true" }).hosts).toEqual(["0.0.0.0"]);
  });

  test("cookie mode follows the site's address, then the platform", () => {
    expect(loadConfig({}).secureCookies).toBe(false);
    expect(loadConfig({ RAILWAY_ENVIRONMENT: "x" }).secureCookies).toBe(true);
    expect(loadConfig({ TEND_PUBLIC_URL: "https://example.com" }).secureCookies).toBe(true);
    expect(loadConfig({ TEND_PUBLIC_URL: "http://example.com", RENDER: "1" }).secureCookies).toBe(
      false,
    );
  });

  test("only platforms that have a proxy trust one by default", () => {
    expect(loadConfig({}).trustProxy).toBe(0);
    expect(loadConfig({ FLY_APP_NAME: "x" }).trustProxy).toBe(1);
    expect(loadConfig({ TEND_TRUST_PROXY: "2" }).trustProxy).toBe(2);
    expect(loadConfig({ FLY_APP_NAME: "x", TEND_TRUST_PROXY: "0" }).trustProxy).toBe(0);
  });
});

describe("the site's own address", () => {
  test("comes from TEND_PUBLIC_URL first, then from what the hosting platform says", () => {
    expect(loadConfig({ TEND_PUBLIC_URL: "https://rise.example" }).siteUrl).toBe(
      "https://rise.example",
    );
    expect(
      loadConfig({
        RAILWAY_ENVIRONMENT: "production",
        RAILWAY_PUBLIC_DOMAIN: "rise.up.railway.app",
      }).siteUrl,
    ).toBe("https://rise.up.railway.app");
    expect(
      loadConfig({ RENDER: "true", RENDER_EXTERNAL_URL: "https://rise.onrender.com" }).siteUrl,
    ).toBe("https://rise.onrender.com");
    expect(loadConfig({ FLY_APP_NAME: "rise" }).siteUrl).toBe("https://rise.fly.dev");
    expect(
      loadConfig({
        TEND_PUBLIC_URL: "https://rise.example",
        RAILWAY_PUBLIC_DOMAIN: "rise.up.railway.app",
      }).siteUrl,
    ).toBe("https://rise.example");
  });

  test("is unknown for a plain run, so pages name the address they're asked for", () => {
    expect(loadConfig({}).siteUrl).toBeUndefined();
    expect(loadConfig({ RAILWAY_PUBLIC_DOMAIN: "not a host/" }).siteUrl).toBeUndefined();
  });
});

describe("explainDataFolderFailure", () => {
  const failure = (code: string) => Object.assign(new Error(`${code} details`), { code });

  test.each([
    "EACCES",
    "EROFS",
    "ENOSPC",
    "SQLITE_CANTOPEN",
    "SQLITE_READONLY",
    "SQLITE_IOERR_WRITE",
  ])("%s is a problem with the folder", (code) => {
    const explained = explainDataFolderFailure("/data", failure(code));
    expect(explained).toBeInstanceOf(ConfigError);
    expect((explained as Error).message).toContain("can't write to its data folder");
  });

  test("says what to do about it where Tend runs", () => {
    const fix = (platform?: "docker" | "railway") =>
      (explainDataFolderFailure("/data", failure("EACCES"), platform) as Error).message;
    expect(fix()).toContain("Give your user write access to it");
    expect(fix("docker")).toContain("sudo chown -R 1000:1000");
    expect(fix("railway")).toContain("RAILWAY_RUN_UID=0");
    expect(fix("railway")).toContain("https://tendcms.dev/errors/data_not_writable");
  });

  test("anything else is passed on unchanged, not blamed on the folder", () => {
    const original = failure("ERR_SOMETHING_ELSE");
    expect(explainDataFolderFailure("/data", original)).toBe(original);
  });
});

describe("explainDataFolderFailure, for the lock file", () => {
  test("names a damaged lock file instead of blaming permissions", () => {
    const error = Object.assign(new Error("not a database"), { code: "SQLITE_NOTADB" });
    const explained = explainDataFolderFailure("/data", error) as Error;
    expect(explained.message).toContain(".lock.db");
    expect(explained.message).not.toContain("write access");
  });
});

describe("the key's file", () => {
  test("holds the key as text, and nothing else counts as one", () => {
    const key = Buffer.alloc(SECRET_KEY_BYTES, 0xab);
    expect(secretKeyText(key)).toBe(`${"ab".repeat(32)}\n`);
    expect(parseSecretKey(Buffer.from(secretKeyText(key)))?.equals(key)).toBe(true);
    expect(parseSecretKey(Buffer.from("ab".repeat(32)))?.equals(key)).toBe(true);
    expect(parseSecretKey(key)).toBeUndefined();
    expect(parseSecretKey(Buffer.from("ab".repeat(31)))).toBeUndefined();
    expect(parseSecretKey(Buffer.from(`${"ab".repeat(32)}\n\n`))).toBeUndefined();
    expect(parseSecretKey(Buffer.alloc(0))).toBeUndefined();
  });

  test("isn't read as a key when it's damaged", () => {
    const config = configIn(tempDir());
    writeFileSync(config.secretKeyPath, "ab".repeat(31));
    expect(() => readSecretKey(config)).toThrow(/is damaged.*Restore it from a backup/);
  });
});

describe("ensureSecretKey", () => {
  test("creates a private 256-bit key once and never changes it", () => {
    const config = configIn(tempDir());
    prepareDataDir(config);
    ensureSecretKey(config);
    const key = readFileSync(config.secretKeyPath, "utf8");
    expect(key).toMatch(/^[0-9a-f]{64}\n$/);
    if (process.platform !== "win32") {
      expect(statSync(config.secretKeyPath).mode & 0o777).toBe(0o600);
    }
    expect(existsSync(join(config.dataDir, "secret.key.tmp"))).toBe(false);

    ensureSecretKey(config);
    expect(readFileSync(config.secretKeyPath, "utf8")).toBe(key);
  });
});
