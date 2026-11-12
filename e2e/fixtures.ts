import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";

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

export const test = base.extend<{ site: Site; signedIn: Site }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads this argument's shape
  site: async ({}, use) => {
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
  },

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
