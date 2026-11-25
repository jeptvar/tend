import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { firstIdAt, uuidv7 } from "../src/ids.ts";
import { type browser, type MadeApp, makeApp, setUp, signedInAs } from "./auth-helpers.ts";

// Overview, and the tabs, counts and search of the lists of posts and pages (PLAN.md §6).

const ENTRIES = "/api/admin/entries";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

type Client = ReturnType<typeof browser>;

async function overview(client: Client) {
  const reply = await client.get("/api/admin/overview");
  expect(reply.status).toBe(200);
  return reply.json();
}

async function stepsOf(client: Client): Promise<Record<string, boolean>> {
  const { steps } = await overview(client);
  return Object.fromEntries(
    steps.map((step: { id: string; done: boolean }) => [step.id, step.done]),
  );
}

async function write(client: Client, type: "post" | "page", title: string) {
  const entry = await (await client.post(ENTRIES, { type })).json();
  const saved = await client.patch(`${ENTRIES}/${entry.id}`, { title }, { "If-Match": "1" });
  expect(saved.status).toBe(200);
  return saved.json();
}

async function change(client: Client, id: string, title: string) {
  const { rev } = await (await client.get(`${ENTRIES}/${id}`)).json();
  const saved = await client.patch(
    `${ENTRIES}/${id}`,
    { title },
    {
      "If-Match": String(rev),
    },
  );
  expect(saved.status).toBe(200);
}

async function publish(client: Client, id: string) {
  const { rev } = await (await client.get(`${ENTRIES}/${id}`)).json();
  const reply = await client.post(`${ENTRIES}/${id}/publish`, {}, { "If-Match": String(rev) });
  expect(reply.status).toBe(200);
}

async function upload(client: Client, color: string) {
  const picture = await sharp({ create: { width: 8, height: 8, channels: 3, background: color } })
    .png()
    .toBuffer();
  const reply = await client.upload("/api/admin/media", picture, "dot.png");
  expect(reply.status).toBe(201);
  return (await reply.json()).id as string;
}

async function listed(client: Client, query: string) {
  const reply = await client.get(`${ENTRIES}?type=post&${query}`);
  expect(reply.status).toBe(200);
  const { entries, counts } = await reply.json();
  return { titles: entries.map((entry: { title: string }) => entry.title), counts };
}

function later(made: MadeApp, ms = MINUTE) {
  made.clock.time += ms;
}

describe("the checklist", () => {
  test("for a new Business site has nothing ticked, and ticks itself off", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    expect(await stepsOf(owner)).toEqual({
      home: false,
      business: false,
      logo: false,
      kit: false,
      online: false,
    });

    later(made);
    const pages = await (await owner.get(`${ENTRIES}?type=page`)).json();
    const home = pages.entries.find((entry: { isHome: boolean }) => entry.isHome);
    await change(owner, home.id, "Rise Bakery, fresh every day");
    // Written, but visitors still see the one it started with.
    expect((await stepsOf(owner)).home).toBe(false);
    await publish(owner, home.id);
    const business = await (await owner.get("/api/admin/settings/business")).json();
    await owner.put("/api/admin/settings/business", { ...business.value, phone: "555 0100" });
    const logo = await upload(owner, "#336699");
    const design = await (await owner.get("/api/admin/design")).json();
    await owner.put("/api/admin/design", { ...design.value, logoId: logo });
    await owner.post("/api/auth/recovery-kit/saved");
    expect(await stepsOf(owner)).toEqual({
      home: true,
      business: true,
      logo: true,
      kit: true,
      online: false,
    });

    // Codes made since aren't the ones that were kept.
    later(made);
    await owner.post("/api/auth/recovery-kit", { password: "correct-horse-battery-staple-9" });
    const kit = await (await owner.get("/api/auth/recovery-kit")).json();
    expect((await stepsOf(owner)).kit).toBe(kit.saved);
  });

  test("asks a Blog for a post of its own, and an example isn't one until it's changed", async () => {
    const made = await makeApp();
    const owner = await setUp(made, { starter: "blog" });
    expect(await stepsOf(owner)).toEqual({
      home: false,
      post: false,
      logo: false,
      kit: false,
      online: false,
    });
    later(made);
    const posts = await (await owner.get(`${ENTRIES}?type=post`)).json();
    const example = posts.entries[0];
    expect(example.isExample).toBe(true);
    await change(owner, example.id, "Why we bake");
    expect((await stepsOf(owner)).post).toBe(false);
    await publish(owner, example.id);
    expect((await stepsOf(owner)).post).toBe(true);
  });

  test("counts a post someone wrote themselves once it's on the site", async () => {
    const made = await makeApp();
    const owner = await setUp(made, { starter: "blog" });
    const post = await write(owner, "post", "Opening day");
    expect((await stepsOf(owner)).post).toBe(false);
    await publish(owner, post.id);
    expect((await stepsOf(owner)).post).toBe(true);
  });

  test("is about going online until the site has an address, then about a domain", async () => {
    const platform = await makeApp({ platformUrl: "https://rise.up.railway.app" });
    const onRailway = await setUp(platform);
    expect(await stepsOf(onRailway)).toMatchObject({ domain: false });
    expect(await stepsOf(onRailway)).not.toHaveProperty("online");

    const domain = await makeApp({ publicUrl: "https://risebakery.example.com" });
    expect(await stepsOf(await setUp(domain))).toMatchObject({ domain: true });

    // One that only works on this network isn't online.
    const lan = await makeApp({ publicUrl: "http://192.168.1.20:3000" });
    expect(await stepsOf(await setUp(lan))).toMatchObject({ online: false });
  });

  test("for an Editor is their own kit, a post and a photo", async () => {
    const made = await makeApp();
    await setUp(made);
    const { client: editor } = await signedInAs(made, "editor");
    expect(await stepsOf(editor)).toEqual({ kit: false, post: false, photo: false });
    const post = await write(editor, "post", "Sourdough");
    await publish(editor, post.id);
    await upload(editor, "#993333");
    expect(await stepsOf(editor)).toEqual({ kit: false, post: true, photo: true });
    // What one Editor did is no step of another's.
    const { client: other } = await signedInAs(made, "writer");
    expect(await stepsOf(other)).toEqual({ kit: false, post: false, photo: false });
  });
});

describe("what's waiting", () => {
  test("is what's on the site with newer edits, and drafts, newest first, with how many", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const fresh = await overview(owner);
    expect(fresh.changes).toEqual({ entries: [], count: 0 });
    expect(fresh.drafts).toEqual({ entries: [], count: 0 });

    for (let each = 1; each <= 7; each++) {
      later(made);
      await write(owner, "post", `Draft ${each}`);
    }
    later(made);
    const about = await write(owner, "page", "About");
    await publish(owner, about.id);
    later(made);
    await change(owner, about.id, "About us");
    // Opened and left, so it isn't anything yet.
    await owner.post(ENTRIES, { type: "post" });

    const { changes, drafts } = await overview(owner);
    expect(changes.count).toBe(1);
    expect(changes.entries).toMatchObject([{ id: about.id, title: "About us", type: "page" }]);
    expect(changes.entries[0]).not.toHaveProperty("data");
    expect(drafts.count).toBe(7);
    expect(drafts.entries.map((entry: { title: string }) => entry.title)).toEqual([
      "Draft 7",
      "Draft 6",
      "Draft 5",
      "Draft 4",
      "Draft 3",
    ]);
  });

  test("for a Writer is only what they wrote", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    await write(owner, "post", "The Owner's");
    const { client: writer } = await signedInAs(made, "writer");
    const mine = await write(writer, "post", "Mine");
    const { drafts } = await overview(writer);
    expect(drafts.count).toBe(1);
    expect(drafts.entries).toMatchObject([{ id: mine.id }]);
  });

  test("and the disk and the last copy are for Admins", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const { client: editor } = await signedInAs(made, "editor");
    const forOwner = await overview(owner);
    expect(forOwner.disk.total).toBeGreaterThan(0);
    expect(forOwner.disk.low).toBeTypeOf("boolean");
    expect(forOwner.lastCopyAt).toBeNull();
    expect(await overview(editor)).toMatchObject({ disk: null, lastCopyAt: null });
  });
});

describe("recent activity", () => {
  async function activityOf(client: Client) {
    const { activity } = await overview(client);
    return activity.map(
      (item: {
        kind: string;
        by: string | null;
        entry?: { title: string };
        count?: number;
        setting?: string;
      }) =>
        [item.by, item.kind, item.entry?.title ?? item.count ?? item.setting]
          .filter((part) => part !== undefined && part !== null)
          .join(" "),
    );
  }

  test("is empty on a new site: what setup made isn't something anyone did", async () => {
    const made = await makeApp();
    expect(await activityOf(await setUp(made))).toEqual([]);
  });

  test("says who did what, newest first, with repeats told once", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    later(made);
    const { client: editor } = await signedInAs(made, "editor");
    later(made);
    const post = await write(editor, "post", "Sourdough");
    await publish(editor, post.id);
    later(made);
    const about = await write(owner, "page", "About");
    await publish(owner, about.id);
    for (const title of ["About us", "About the bakery"]) {
      later(made);
      await change(owner, about.id, title);
      await publish(owner, about.id);
    }
    later(made);
    await upload(editor, "#112233");
    later(made);
    await upload(editor, "#223344");
    later(made);
    await upload(owner, "#334455");
    later(made);
    const visibility = { mode: "coming_soon" };
    expect((await owner.put("/api/admin/settings/visibility", visibility)).status).toBe(200);

    expect(await activityOf(owner)).toEqual([
      "Tom Baker setting visibility",
      "Tom Baker added 1",
      "editor added 2",
      "Tom Baker changed About the bakery",
      "editor published Sourdough",
      "editor joined",
    ]);
    // Settings and people are for Admins to know about.
    expect(await activityOf(editor)).toEqual([
      "Tom Baker added 1",
      "editor added 2",
      "Tom Baker changed About the bakery",
      "editor published Sourdough",
    ]);
  });

  test("tells Editors about the menu, which is theirs too", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const { client: editor } = await signedInAs(made, "editor");
    later(made);
    await owner.put("/api/admin/menus/main", { items: [] });
    expect(await activityOf(editor)).toEqual(["Tom Baker setting menu:main"]);
  });

  test("leaves out what's in the Trash, and what's older than a month", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    later(made);
    const gone = await write(owner, "post", "Gone");
    await publish(owner, gone.id);
    await owner.post(`${ENTRIES}/${gone.id}/trash`);
    const kept = await write(owner, "post", "Kept");
    await publish(owner, kept.id);
    const picture = await upload(owner, "#445566");
    await owner.post(`/api/admin/media/${picture}/trash`);
    expect(await activityOf(owner)).toEqual(["Tom Baker published Kept"]);
    made.clock.time += 31 * DAY;
    const { client: admin } = await signedInAs(made, "admin");
    expect(await activityOf(admin)).toEqual(["admin joined"]);
  });

  test("a Writer sees only their own, and someone removed has no name", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    later(made);
    const { client: editor, id } = await signedInAs(made, "editor");
    const post = await write(editor, "post", "Sourdough");
    await publish(editor, post.id);
    const { client: writer } = await signedInAs(made, "writer");
    await upload(writer, "#556677");
    expect(await activityOf(writer)).toEqual(["writer added 1"]);
    expect((await owner.delete(`/api/admin/people/${id}`)).status).toBe(204);
    expect(await activityOf(owner)).toContain("published Sourdough");
  });
});

describe("the lists of posts and pages", () => {
  async function someOfEach() {
    const made = await makeApp();
    const owner = await setUp(made);
    await write(owner, "post", "École d'été");
    later(made);
    const live = await write(owner, "post", "Summer 100% rye");
    await publish(owner, live.id);
    later(made);
    const changed = await write(owner, "post", "Winter");
    await publish(owner, changed.id);
    await change(owner, changed.id, "Winter again");
    const trashed = await write(owner, "post", "Old news");
    await owner.post(`${ENTRIES}/${trashed.id}/trash`);
    return { made, owner };
  }

  test("have a part for drafts, for what's on the site, and for the Trash, each counted", async () => {
    const { owner } = await someOfEach();
    const counts = { all: 3, drafts: 1, published: 2, trash: 1 };
    expect(await listed(owner, "")).toEqual({
      titles: ["Winter again", "Summer 100% rye", "École d'été"],
      counts,
    });
    expect(await listed(owner, "status=draft")).toEqual({ titles: ["École d'été"], counts });
    expect(await listed(owner, "status=published")).toEqual({
      titles: ["Winter again", "Summer 100% rye"],
      counts,
    });
    expect(await listed(owner, "view=trash")).toEqual({ titles: ["Old news"], counts });
    expect((await owner.get(`${ENTRIES}?type=post&status=everything`)).status).toBe(400);
  });

  test("are searched by title, however it's typed, and a sign in it means itself", async () => {
    const { owner } = await someOfEach();
    expect((await listed(owner, "q=ecole")).titles).toEqual(["École d'été"]);
    expect((await listed(owner, "q=SUMMER")).titles).toEqual(["Summer 100% rye"]);
    expect((await listed(owner, `q=${encodeURIComponent("100%")}`)).titles).toEqual([
      "Summer 100% rye",
    ]);
    expect((await listed(owner, `q=${encodeURIComponent("_")}`)).titles).toEqual([]);
    expect((await listed(owner, "q=winter&status=draft")).titles).toEqual([]);
    expect((await listed(owner, "q=old&view=trash")).titles).toEqual(["Old news"]);
    // The tabs still say how many there are in all.
    expect((await listed(owner, "q=nothing")).counts.all).toBe(3);
  });

  test("show a Writer only their own, counts and all", async () => {
    const { made } = await someOfEach();
    const { client: writer } = await signedInAs(made, "writer");
    await write(writer, "post", "Mine");
    expect(await listed(writer, "")).toEqual({
      titles: ["Mine"],
      counts: { all: 1, drafts: 1, published: 0, trash: 0 },
    });
  });

  test("don't send anyone's words along", async () => {
    const { owner } = await someOfEach();
    const { entries } = await (await owner.get(`${ENTRIES}?type=post`)).json();
    for (const entry of entries) expect(entry).not.toHaveProperty("data");
  });
});

describe("ids", () => {
  test("from a time sort after the ones before it, and before the ones after", () => {
    const at = 1_780_000_000_000;
    expect(firstIdAt(at) < uuidv7(at)).toBe(true);
    expect(uuidv7(at - 1) < firstIdAt(at)).toBe(true);
    expect(firstIdAt(0)).toBe("00000000-0000-0000-0000-000000000000");
  });
});
