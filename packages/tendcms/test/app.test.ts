import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../src/server.ts";
import { tempDir } from "./helpers.ts";

const INDEX = '<!doctype html><div id="root"></div>';
const SECRET = "secret file contents";

describe("serving the admin", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    const root = tempDir();
    const adminDir = join(root, "admin");
    mkdirSync(join(adminDir, "assets"), { recursive: true });
    writeFileSync(join(adminDir, "index.html"), INDEX);
    writeFileSync(join(adminDir, "favicon.svg"), "<svg/>");
    writeFileSync(join(adminDir, "assets", "app-abc.js"), "console.log(1)");
    // Things the guard must keep out: a file next to the admin folder, and a sibling
    // folder whose name merely starts the same way.
    writeFileSync(join(root, "secret.txt"), SECRET);
    mkdirSync(join(root, "admin-evil"));
    writeFileSync(join(root, "admin-evil", "x.txt"), SECRET);
    app = createApp({ version: "1.2.3", adminDir, adminDevUrl: undefined });
  });

  test("client routes get index.html, not cached", async () => {
    const response = await app.request("/admin/setup");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(await response.text()).toBe(INDEX);
  });

  test("hashed assets are served and cached forever", async () => {
    const response = await app.request("/admin/assets/app-abc.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("console.log(1)");
  });

  test("other files are served but revalidated", async () => {
    const response = await app.request("/admin/favicon.svg");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("cache-control")).toBe("no-cache");
  });

  test("a missing asset is a 404, not the app page", async () => {
    expect((await app.request("/admin/assets/missing.js")).status).toBe(404);
  });

  test.each([
    "/admin/..%2Fsecret.txt",
    "/admin/..%5Csecret.txt",
    "/admin/%2e%2e%2fsecret.txt",
    "/admin/..%2Fadmin-evil%2Fx.txt",
    "/admin/assets/..%2F..%2Fsecret.txt",
  ])("%s never returns a file outside the admin folder", async (path) => {
    const response = await app.request(path);
    expect(await response.text()).not.toContain(SECRET);
  });

  test("a malformed path is a 400", async () => {
    expect((await app.request("/admin/%E0%A4%A")).status).toBe(400);
  });

  test("/admin redirects to the app, and / to setup", async () => {
    expect((await app.request("/admin")).headers.get("location")).toBe("/admin/");
    expect((await app.request("/")).headers.get("location")).toBe("/admin/setup");
  });

  test("a folder that hasn't been built explains itself", async () => {
    const bare = createApp({ version: "1", adminDir: tempDir(), adminDevUrl: undefined });
    const response = await bare.request("/admin/setup");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("haven't been built yet");
  });

  test("in development /admin goes to the Vite server, query included", async () => {
    const dev = createApp({
      version: "1",
      adminDir: tempDir(),
      adminDevUrl: "http://localhost:5173",
    });
    const response = await dev.request("/admin/setup?x=1");
    expect(response.headers.get("location")).toBe("http://localhost:5173/admin/setup?x=1");
  });

  test("/healthz is not cached and reports the version", async () => {
    const response = await app.request("/healthz");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, version: "1.2.3" });
  });
});
