import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type APIRequestContext,
  type APIResponse,
  test as base,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";

export { expect };

const CLI = join(import.meta.dirname, "..", "packages", "tendcms", "dist", "cli.mjs");

export const OWNER = {
  name: "Sam Lee",
  email: "sam@example.com",
  password: "maple-river-candle-stone-orbit",
};

export interface Site {
  base: string;
  /** The setup link Tend printed, with the code in it. */
  link: string;
  code: string;
  /** Stops Tend with no warning at all, like a crash or a power cut. */
  crash(): Promise<void>;
  /** Starts it again on the same address and data, after a crash. */
  restart(): Promise<void>;
}

export interface Entry {
  id: string;
  rev: number;
  url: string | null;
  title: string;
  dirty: boolean;
}

type Running = Omit<Site, "crash" | "restart">;

function startServer(dataDir: string, port = "0"): Promise<{ child: ChildProcess; site: Running }> {
  if (!existsSync(CLI)) throw new Error(`${CLI} doesn't exist. Run pnpm build first.`);
  const child = spawn(process.execPath, [CLI, "start"], {
    cwd: dataDir,
    env: {
      ...process.env,
      PORT: port,
      TEND_DATA_DIR: join(dataDir, "data"),
      TEND_ADMIN_DEV_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk;
      const match = output.match(/is running: (http:\/\/\S+)/);
      if (!match?.[1]) return;
      const link = new URL(match[1]);
      resolve({
        child,
        site: { base: link.origin, link: match[1], code: link.hash.replace("#code=", "") },
      });
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", () => reject(new Error(`Tend stopped. Output:\n${output}`)));
  });
}

function stopped(child: ChildProcess, signal: NodeJS.Signals): Promise<unknown> {
  child.removeAllListeners("exit");
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill(signal);
  return exited;
}

type SendOptions = { headers?: Record<string, string> };

/**
 * Makes each request a test sends close its connection once it's answered. Playwright keeps an
 * idle connection with no time limit, while a Node server like Tend's says it keeps one for
 * 5 s and closes it after 6 (keepAliveTimeout plus keepAliveTimeoutBuffer). A request sent on
 * it just as it closes is reset: "read ECONNRESET".
 */
function closeAfterEachAnswer(request: APIRequestContext): void {
  for (const name of ["get", "head", "post", "put", "patch", "delete", "fetch"] as const) {
    const send = request[name].bind(request) as (
      url: unknown,
      options?: SendOptions,
    ) => Promise<APIResponse>;
    Object.assign(request, {
      [name]: (url: unknown, options?: SendOptions) =>
        send(url, { ...options, headers: { connection: "close", ...options?.headers } }),
    });
  }
}

/** Runs Tend on a data folder of its own, for as long as a test needs it. */
async function runSite(use: (site: Site) => Promise<void>): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "tend-e2e-"));
  const first = await startServer(dataDir);
  let { child } = first;
  await use({
    ...first.site,
    crash: async () => {
      await stopped(child, "SIGKILL");
    },
    restart: async () => {
      const again = await startServer(dataDir, new URL(first.site.base).port);
      child = again.child;
    },
  });
  await stopped(child, "SIGTERM");
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

export const test = base.extend<{ site: Site; signedIn: Site; newSite: Site }>({
  // Every page in a test shares its context's request, so this covers them all.
  page: async ({ page }, use) => {
    closeAfterEachAnswer(page.request);
    await use(page);
  },

  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads this argument's shape
  site: async ({}, use) => runSite(use),

  /** Another Tend, new and waiting to be set up: somewhere to move `site` to. */
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads this argument's shape
  newSite: async ({}, use) => runSite(use),

  /** A site already set up with the Business starting point, with the page signed in. */
  signedIn: async ({ site, page }, use) => {
    const reply = await page.request.post(`${site.base}/api/auth/setup`, {
      data: {
        code: site.code,
        site: { name: "Rise Bakery", tagline: "Fresh bread", locale: "en", timezone: "UTC" },
        owner: OWNER,
        starter: "business",
      },
    });
    expect(reply.status()).toBe(201);
    await use(site);
  },
});

function doc(text: string) {
  const content = text ? [{ type: "paragraph", content: [{ type: "text", text }] }] : [];
  return { type: "doc", content };
}

/** Creates something through the API, so a test can start where it's interesting. */
export async function createEntry(
  page: Page,
  site: Site,
  options: { type?: "post" | "page"; title: string; body?: string; publish?: boolean },
): Promise<Entry> {
  const entries = `${site.base}/api/admin/entries`;
  const created = await (
    await page.request.post(entries, { data: { type: options.type ?? "post" } })
  ).json();
  const saved = await (
    await page.request.patch(`${entries}/${created.id}`, {
      headers: { "If-Match": String(created.rev) },
      data: { title: options.title, doc: doc(options.body ?? "Original text") },
    })
  ).json();
  if (!options.publish) return saved;
  return (
    await page.request.post(`${entries}/${created.id}/publish`, {
      headers: { "If-Match": String(saved.rev) },
      data: {},
    })
  ).json();
}

export async function readEntry(page: Page, site: Site, id: string) {
  return (await page.request.get(`${site.base}/api/admin/entries/${id}`)).json();
}

/**
 * Closes tabs while Tend is down, so their last save fails the way it does when the connection
 * drops. A test can't fail that save from the browser: it leaves as the tab closes, after
 * page.route, context.route and setOffline have all stopped applying to the tab. It would
 * reach the server, and the copy the test means to leave behind would never be offered.
 */
export async function closeWhileDown(site: Site, ...pages: Page[]): Promise<void> {
  await site.crash();
  for (const page of pages) await page.close();
  await site.restart();
}

/**
 * Holds back the page's requests to `url`, only those sent with `method` if it's given, until
 * the returned function is called: a slow connection that lasts exactly as long as the test
 * needs. A fixed delay can run out before the test is ready, on a busy machine.
 */
export async function holdRequests(page: Page, url: string, method?: string): Promise<() => void> {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(url, async (route) => {
    if (method === undefined || route.request().method() === method) await released;
    await route.fallback();
  });
  return release;
}

export interface DataRisk {
  why: "unmounted" | "unnamed";
  path: string;
  platform: "railway" | "render" | "fly" | "docker";
}

/**
 * Has Tend tell the admin its site would be lost, as it does in a container whose data folder
 * isn't on a volume that's kept. Tend can't be in one here, so this changes what it answers.
 */
export async function pretendDataIsAtRisk(
  page: Page,
  risk: DataRisk,
  user: { isOwner?: boolean } = {},
): Promise<void> {
  await page.route("**/api/auth/me", async (route) => {
    const reply = await route.fetch();
    const me = await reply.json();
    await route.fulfill({
      response: reply,
      json: { ...me, dataRisk: risk, user: { ...me.user, ...user } },
    });
  });
}

/**
 * Whether Tab moves to links in this browser. Safari's skips them until "Press Tab to
 * highlight each item" is turned on, and WebKit's does on Windows, where Alt+Tab is just Tab.
 * It replaces what the page shows, so call it before going anywhere.
 */
export async function tabReachesLinks(page: Page): Promise<boolean> {
  await page.setContent('<button id="from">From</button> <a id="to" href="#to">To</a>');
  await page.locator("#from").focus();
  await page.keyboard.press("Tab");
  return page.evaluate(() => document.activeElement?.id === "to");
}

/**
 * Types where a link or button goes, in its dialog, and waits for the search that starts to
 * find nothing. Until then the pages listed above Done can still go, moving Done up, and a
 * click on Done as they go is released somewhere else and does nothing.
 */
export async function typeAddress(dialog: Locator, address: string): Promise<void> {
  await dialog.getByLabel("Search your pages, or paste an address").fill(address);
  await expect(dialog.getByText("Nothing found")).toBeAttached();
}

interface TextNode {
  text?: string;
  content?: TextNode[];
}

export function bodyText(entry: { data: { doc: { content: TextNode[] } } }): string {
  const inline = (node: TextNode): string =>
    node.content ? node.content.map(inline).join("") : (node.text ?? "\n");
  return entry.data.doc.content.map(inline).join("\n\n");
}

export async function signIn(page: Page, site: Site, path = "/admin/login"): Promise<void> {
  await page.goto(`${site.base}${path}`);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password", { exact: true }).fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("link", { name: "Overview" })).toBeVisible();
}

/** A JPEG made in the browser, so tests need no picture files of their own. */
export async function photo(
  page: Page,
  width = 1200,
  height = 800,
  color = "#c96a3a",
): Promise<Buffer> {
  if (page.url() === "about:blank") await page.goto("data:text/html,<title>x</title>");
  const base64 = await page.evaluate(
    async ({ width, height, color }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d") as CanvasRenderingContext2D;
      context.fillStyle = color;
      context.fillRect(0, 0, width, height);
      context.fillStyle = "#ffffff";
      context.fillRect(width / 4, height / 4, width / 2, height / 2);
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((made) => resolve(made as Blob), "image/jpeg", 0.9),
      );
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    },
    { width, height, color },
  );
  return Buffer.from(base64, "base64");
}

export interface Uploaded {
  id: string;
  url: string;
  thumbUrl: string;
  alt: string | null;
}

/** Uploads straight to Tend, the way the admin sends files. */
export async function upload(
  page: Page,
  site: Site,
  data: Buffer,
  name: string,
): Promise<Uploaded> {
  const reply = await page.request.post(`${site.base}/api/admin/media`, {
    headers: {
      "Content-Type": "application/octet-stream",
      "X-File-Name": encodeURIComponent(name),
    },
    data,
  });
  expect(reply.status()).toBe(201);
  return reply.json();
}
