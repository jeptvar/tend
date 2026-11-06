import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach } from "vitest";
import { displaySetupCode } from "../src/auth/setup-code.ts";
import { createOrm, type Orm, openDatabase, type SqliteDatabase } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import { defaultThemeDir, migrationsDir } from "../src/paths.ts";
import { type AppOptions, createApp } from "../src/server.ts";
import { tempDir } from "./helpers.ts";

const open: SqliteDatabase[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

export const START_TIME = 1_800_000_000_000;
export const GOOD_PASSWORD = "maple-river-candle-stone-orbit";

export function setupBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    site: { name: "Rise Bakery", tagline: "Fresh bread", locale: "en-PH", timezone: "Asia/Manila" },
    owner: { name: "Tom Baker", email: "Tom@Example.com", password: GOOD_PASSWORD },
    starter: "business",
    ...overrides,
  };
}

export interface MadeApp {
  app: ReturnType<typeof createApp>;
  db: SqliteDatabase;
  orm: Orm;
  secretKey: Buffer;
  clock: { time: number };
  code: string;
}

/** A real app on a real, migrated database, with a clock the test controls. */
export async function makeApp(overrides: Partial<AppOptions> = {}): Promise<MadeApp> {
  const root = tempDir();
  const backupsDir = join(root, "backups");
  mkdirSync(backupsDir);
  const dbPath = join(root, "tend.db");
  await migrate({ dbPath, backupsDir, migrationsDir, appVersion: "test", log: () => {} });

  const db = openDatabase(dbPath);
  open.push(db);
  const orm = createOrm(db);
  const secretKey = randomBytes(32);
  const clock = { time: START_TIME };
  const app = createApp({
    version: "1.2.3",
    adminDir: tempDir(),
    adminDevUrl: undefined,
    publicUrl: undefined,
    orm,
    secretKey,
    setupPassword: undefined,
    secureCookies: false,
    trustProxy: 0,
    themeDir: defaultThemeDir,
    pageCacheBytes: 0,
    isPublic: false,
    now: () => clock.time,
    ...overrides,
  });
  return { app, db, orm, secretKey, clock, code: displaySetupCode(secretKey) };
}

export interface Reply {
  status: number;
  headers: Headers;
  cookies: string[];
  // biome-ignore lint/suspicious/noExplicitAny: every test checks the shape it reads
  json: () => Promise<any>;
}

/** Acts like one browser: same cookies from request to request, unless told otherwise. */
export function browser(app: ReturnType<typeof createApp>) {
  const jar = new Map<string, string>();

  async function request(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Reply> {
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    const response = await app.request(path, {
      method,
      headers: {
        ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
    });
    const cookies = response.headers.getSetCookie();
    for (const line of cookies) {
      const [pair = ""] = line.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      if (/max-age=0/i.test(line)) jar.delete(name);
      else jar.set(name, pair.slice(separator + 1));
    }
    return {
      status: response.status,
      headers: response.headers,
      cookies,
      json: () => response.json(),
    };
  }

  return {
    jar,
    get: (path: string, headers?: Record<string, string>) =>
      request("GET", path, undefined, headers),
    post: (path: string, body?: unknown, headers?: Record<string, string>) =>
      request("POST", path, body, headers),
    patch: (path: string, body?: unknown, headers?: Record<string, string>) =>
      request("PATCH", path, body, headers),
  };
}

/** Runs setup and returns a browser that's signed in as the Owner. */
export async function setUp(made: MadeApp, overrides: Record<string, unknown> = {}) {
  const owner = browser(made.app);
  const reply = await owner.post("/api/auth/setup", { code: made.code, ...setupBody(overrides) });
  if (reply.status !== 201) throw new Error(`Setup failed: ${JSON.stringify(await reply.json())}`);
  return owner;
}

export const OWNER_EMAIL = "tom@example.com";
