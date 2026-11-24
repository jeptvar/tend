import type { Page } from "@playwright/test";
import { createEntry, expect, type Site, test } from "./fixtures.ts";

// How long things take (PLAN.md §11), as someone at the screen waits for them: words to appear
// as they're typed, a save, and what's published to be on the site. They vary with the machine,
// so they run nightly and by hand, one at a time: `pnpm e2e --project=timings`.

test.describe.configure({ mode: "serial" });

const PUBLISH_P95_MS = 1000;
const SAVE_P95_MS = 300;
/** A keystroke is handled within one frame, and shown within three even when it's slow. */
const KEYSTROKE_TYPICAL_MS = 16;
const KEYSTROKE_P95_MS = 50;
const SLOWDOWN = 4;

function percentile(values: number[], part: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * part) - 1)] as number;
}

function say(name: string, values: number[]): void {
  const at = (part: number) => percentile(values, part).toFixed(1);
  console.log(`${name}: ${at(0.5)} ms typically, ${at(0.95)} ms for 95 in 100`);
}

const body = (page: Page) => page.getByRole("textbox", { name: "Text" });

async function openPost(page: Page, site: Site, id: string): Promise<void> {
  await page.goto(`${site.base}/admin/posts/${id}`);
  await expect(body(page)).toBeVisible();
}

test("what's published is on the site within a second", async ({ page, signedIn }) => {
  const post = await createEntry(page, signedIn, {
    title: "Hours",
    body: "Round 0",
    publish: true,
  });
  await openPost(page, signedIn, post.id);
  const took: number[] = [];
  for (let round = 1; round <= 20; round++) {
    await body(page).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type(`Round ${round}`);
    const publish = page.getByRole("button", { name: "Publish changes" });
    await expect(publish).toBeEnabled();
    const pressed = Date.now();
    await publish.click();
    // Asked for again and again, as if by a visitor at just that moment.
    for (;;) {
      const html = await (await page.request.get(`${signedIn.base}/blog/hours`)).text();
      if (html.includes(`Round ${round}<`)) break;
      expect(Date.now() - pressed, "it never arrived").toBeLessThan(10_000);
    }
    took.push(Date.now() - pressed);
    await expect(publish).toHaveCount(0);
  }
  say("From pressing Publish changes to a visitor seeing them", took);
  expect(percentile(took, 0.95)).toBeLessThanOrEqual(PUBLISH_P95_MS);
});

test("a save is there and back within 300 ms", async ({ page, signedIn }) => {
  const post = await createEntry(page, signedIn, { title: "Draft", body: "Words. ".repeat(500) });
  await openPost(page, signedIn, post.id);
  const took: number[] = [];
  page.on("requestfinished", (request) => {
    if (request.method() === "PATCH") took.push(request.timing().responseEnd);
  });
  await body(page).click();
  for (let round = 0; round < 20; round++) {
    await page.keyboard.type(" more");
    const saves = took.length;
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(() => took.length).toBeGreaterThan(saves);
  }
  say("A save of 500 words", took);
  expect(percentile(took, 0.95)).toBeLessThanOrEqual(SAVE_P95_MS);
});

test("typing in 3,000 words keeps up, on a processor 4 times slower", async ({
  page,
  signedIn,
}) => {
  test.setTimeout(120_000);
  const sentence = "The oven is warm and the first loaves are ready for the morning. ";
  const paragraph = { type: "paragraph", content: [{ type: "text", text: sentence.repeat(4) }] };
  const entries = `${signedIn.base}/api/admin/entries`;
  const post = await createEntry(page, signedIn, { title: "A long read" });
  const saved = await page.request.patch(`${entries}/${post.id}`, {
    headers: { "If-Match": String(post.rev) },
    // 48 words each.
    data: { doc: { type: "doc", content: Array.from({ length: 63 }, () => paragraph) } },
  });
  expect(saved.status()).toBe(200);
  await openPost(page, signedIn, post.id);
  // In the middle, with as much to lay out above as below.
  await body(page).locator("p").nth(31).click();
  await page.waitForTimeout(1000);

  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: SLOWDOWN });
  await page.evaluate(() => {
    const measured = { handled: [] as number[], shown: [] as number[] };
    Object.assign(window, { measured });
    document.addEventListener(
      "keydown",
      (event) => {
        const at = event.timeStamp;
        // Once everything the key sets off has run, and once it's on the screen: the first
        // task after the frame it's drawn in.
        const { port1, port2 } = new MessageChannel();
        port1.onmessage = () => measured.handled.push(performance.now() - at);
        port2.postMessage(null);
        requestAnimationFrame(() => {
          setTimeout(() => measured.shown.push(performance.now() - at));
        });
      },
      { capture: true },
    );
  });
  // As fast as someone types who types fast: ten characters a second.
  for (const character of " and then some more words, for the sake of it, until there are enough") {
    await page.keyboard.type(character);
    await page.waitForTimeout(100);
  }
  await session.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  const { handled, shown } = await page.evaluate(
    () => (window as unknown as { measured: { handled: number[]; shown: number[] } }).measured,
  );
  expect(handled.length).toBeGreaterThan(50);
  say("A keystroke handled", handled);
  say("A keystroke shown", shown);
  expect(percentile(handled, 0.5)).toBeLessThanOrEqual(KEYSTROKE_TYPICAL_MS);
  expect(percentile(shown, 0.95)).toBeLessThanOrEqual(KEYSTROKE_P95_MS);
});
