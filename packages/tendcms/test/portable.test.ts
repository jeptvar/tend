import { cpSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import sharp from "sharp";
import { expect, test } from "vitest";
import { runCli, tempDir, waitForRunning } from "./helpers.ts";

// One process, one folder (PLAN.md §4, P1): the data folder is the whole site. A copy of it,
// started anywhere, is the same site, and nothing in it says where it used to be.

const OWNER = { name: "Sam Lee", email: "sam@example.com", password: "maple-river-candle-stone" };
const OLD_HOST = /localhost|127\.0\.0\.1/;

interface Answer {
  status: number;
  type: string;
  body: Buffer;
  cookie: string;
}

/** Asks as a visitor at any address does. fetch() doesn't let the host be chosen. */
function ask(
  base: URL,
  path: string,
  options: {
    host?: string;
    cookie?: string;
    method?: string;
    body?: Buffer | object | undefined;
    /** The version a change is made to. */
    rev?: number | undefined;
  } = {},
): Promise<Answer> {
  const { host, cookie, method = "GET", body, rev } = options;
  const raw = Buffer.isBuffer(body) ? body : body ? Buffer.from(JSON.stringify(body)) : undefined;
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      new URL(path, base),
      {
        method,
        headers: {
          Connection: "close",
          ...(host ? { Host: host } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(raw
            ? {
                "Content-Type": Buffer.isBuffer(body)
                  ? "application/octet-stream"
                  : "application/json",
                "Content-Length": raw.length,
                "X-File-Name": "loaf.png",
              }
            : {}),
          ...(rev === undefined ? {} : { "If-Match": String(rev) }),
        },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () =>
          resolve({
            status: incoming.statusCode ?? 0,
            type: incoming.headers["content-type"] ?? "",
            body: Buffer.concat(chunks),
            cookie: (incoming.headers["set-cookie"] ?? [])
              .map((line) => line.split(";")[0])
              .join("; "),
          }),
        );
        incoming.on("error", reject);
      },
    );
    outgoing.on("error", reject);
    outgoing.end(raw);
  });
}

test("a copy of the data folder is the same site, at any address", async () => {
  const first = join(tempDir(), "data");
  const here = runCli(["start"], { TEND_DATA_DIR: first, PORT: "0" });
  const link = await waitForRunning(here);

  // A site with something of every kind in it.
  const setup = await ask(link, "/api/auth/setup", {
    method: "POST",
    body: {
      code: link.hash.replace("#code=", ""),
      site: { name: "Rise Bakery", tagline: "Fresh bread", locale: "en-PH", timezone: "UTC" },
      owner: OWNER,
      starter: "business",
    },
  });
  expect(setup.status).toBe(201);
  const { cookie } = setup;
  const admin = async (method: string, path: string, body?: Buffer | object, rev?: number) => {
    const answer = await ask(link, `/api/admin${path}`, { method, cookie, body, rev });
    expect(answer.status, `${method} ${path}`).toBeLessThan(300);
    return JSON.parse(answer.body.toString());
  };
  const picture = await sharp({
    create: { width: 900, height: 600, channels: 3, background: "#aa7733" },
  })
    .png()
    .toBuffer();
  const photo = await admin("POST", "/media", picture);
  const post = await admin("POST", "/entries", { type: "post" });
  const doc = {
    type: "doc",
    content: [
      { type: "image", attrs: { mediaId: photo.id, alt: "A loaf" } },
      { type: "paragraph", content: [{ type: "text", text: "Come and say hello." }] },
    ],
  };
  const saved = await admin(
    "PATCH",
    `/entries/${post.id}`,
    { title: "Opening day", doc },
    post.rev,
  );
  await admin("POST", `/entries/${post.id}/publish`, {}, saved.rev);
  await admin("POST", "/redirects", { from: "/old-menu", to: "/contact" });

  const pages = ["/", "/blog", "/blog/opening-day", "/contact", "/sitemap.xml", "/rss.xml"];
  const lists = [
    "/entries?type=post",
    "/entries?type=page",
    `/entries/${post.id}`,
    "/media",
    "/menus",
    "/design",
    "/redirects",
    "/tags",
    "/settings/general",
    "/settings/business",
    "/settings/visibility",
    "/people",
  ];
  const everything = async (base: URL, host: string) => {
    const found: Record<string, string> = {};
    for (const path of pages) {
      const answer = await ask(base, path, { host });
      expect(answer.status, path).toBe(200);
      found[path] = answer.body.toString();
    }
    for (const path of lists) {
      const answer = await ask(base, `/api/admin${path}`, { host, cookie });
      expect(answer.status, path).toBe(200);
      found[path] = answer.body.toString();
    }
    for (const size of [480, 900]) {
      const [, hash] = photo.url.match(/^\/media\/[^/]+\/([^/]+)\//) as RegExpMatchArray;
      const answer = await ask(base, `/media/${photo.id}/${hash}/${size}.webp`, { host });
      expect(answer.status, `${size} px`).toBe(200);
      found[`${size} px`] = answer.body.toString("base64");
    }
    return found;
  };
  const before = await everything(link, "bakery.example");
  await here.stop();

  const second = join(tempDir(), "somewhere-else", "data");
  cpSync(first, second, { recursive: true });
  const there = runCli(["start"], { TEND_DATA_DIR: second, PORT: "0" });
  const moved = await waitForRunning(there);
  // Whoever was signed in still is: the sessions and the key are in the folder too.
  expect(await everything(moved, "bakery.example")).toEqual(before);

  // Asked for at another address, it says that one, and nowhere says where it used to be.
  const elsewhere = await everything(moved, "rise.example");
  for (const [path, body] of Object.entries(elsewhere)) {
    expect(body, path).not.toMatch(OLD_HOST);
    expect(body, path).not.toContain("bakery.example");
  }
  expect(elsewhere["/sitemap.xml"]).toContain("http://rise.example/blog/opening-day");

  // And its Owner signs in with the same email and password.
  const signIn = await ask(moved, "/api/auth/login", {
    host: "rise.example",
    method: "POST",
    body: { email: OWNER.email, password: OWNER.password },
  });
  expect(signIn.status).toBe(200);
});
