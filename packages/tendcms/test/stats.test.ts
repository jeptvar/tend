import { describe, expect, test } from "vitest";
import { statsSchema } from "../src/content/stats.ts";
import { statsTag } from "../src/site/stats.ts";
import { makeApp, setUp, signedInAs } from "./auth-helpers.ts";

// Settings → Visitor stats (PLAN.md v0.2): a cookie-free service, set up by pasting what it
// gives a site. What's pasted goes into a script tag on every page, so it's checked.

const parse = (value: object) => statsSchema.safeParse({ id: null, script: null, ...value });

describe("what's pasted", () => {
  test("each service's own ID, tidied the way the service writes it", () => {
    expect(parse({ service: "plausible", id: " https://Rise-Bakery.com/ " }).data).toEqual({
      service: "plausible",
      id: "rise-bakery.com",
      script: null,
    });
    expect(parse({ service: "fathom", id: "ABCDEFGH" }).data?.id).toBe("ABCDEFGH");
    expect(parse({ service: "umami", id: "94DB1CB1-74F4-4A40-AD6C-962362670409" }).data).toEqual({
      service: "umami",
      id: "94db1cb1-74f4-4a40-ad6c-962362670409",
      script: null,
    });
    expect(parse({ service: "cloudflare", id: "0123456789abcdef0123456789ABCDEF" }).data?.id).toBe(
      "0123456789abcdef0123456789abcdef",
    );
    expect(parse({ service: null, id: "left over" }).data).toEqual({
      service: null,
      id: null,
      script: null,
    });
  });

  test("or the whole snippet the service gave, from which the ID is taken", () => {
    const fathom =
      '<script src="https://cdn.usefathom.com/script.js" data-site="PQRSTUVW" defer></script>';
    expect(parse({ service: "fathom", id: fathom }).data?.id).toBe("PQRSTUVW");
    const plausible =
      '<script defer data-domain="rise-bakery.com" src="https://plausible.io/js/script.js"></script>';
    expect(parse({ service: "plausible", id: plausible }).data?.id).toBe("rise-bakery.com");
    const cloudflare = `<script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "0123456789abcdef0123456789abcdef"}'></script>`;
    expect(parse({ service: "cloudflare", id: cloudflare }).data?.id).toBe(
      "0123456789abcdef0123456789abcdef",
    );
    // An Umami of someone's own says where its script is, as well.
    const umami =
      '<script defer src="https://stats.rise-bakery.com/script.js" data-website-id="94db1cb1-74f4-4a40-ad6c-962362670409"></script>';
    expect(parse({ service: "umami", id: umami }).data).toEqual({
      service: "umami",
      id: "94db1cb1-74f4-4a40-ad6c-962362670409",
      script: "https://stats.rise-bakery.com/script.js",
    });
    const cloud = umami.replace("https://stats.rise-bakery.com/", "https://cloud.umami.is/");
    expect(parse({ service: "umami", id: cloud }).data?.script).toBeNull();
  });

  test.each([
    ["plausible", 'rise-bakery.com" onload="alert(1)'],
    ["plausible", "not a domain"],
    ["fathom", "ABC"],
    ["fathom", "<script>"],
    ["umami", "94db1cb1"],
    ["cloudflare", "0123456789abcdef"],
    ["cloudflare", ""],
  ])("%s refuses %j, under the box it was typed in", (service, id) => {
    const result = parse({ service, id });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["id"]);
  });

  test("an Umami of someone's own is on https", () => {
    const id = "94db1cb1-74f4-4a40-ad6c-962362670409";
    for (const script of ["http://stats.example.com/script.js", "javascript:alert(1)", "nope"]) {
      const result = parse({ service: "umami", id, script });
      expect(result.error?.issues[0]?.path).toEqual(["script"]);
    }
  });
});

describe("the tag on every page", () => {
  test("is each service's own, as its docs give it", () => {
    expect(statsTag({ service: "plausible", id: "rise-bakery.com", script: null })).toBe(
      '<script defer data-domain="rise-bakery.com" src="https://plausible.io/js/script.js"></script>',
    );
    expect(statsTag({ service: "fathom", id: "ABCDEFGH", script: null })).toBe(
      '<script src="https://cdn.usefathom.com/script.js" data-site="ABCDEFGH" defer></script>',
    );
    const id = "94db1cb1-74f4-4a40-ad6c-962362670409";
    expect(statsTag({ service: "umami", id, script: null })).toBe(
      `<script defer src="https://cloud.umami.is/script.js" data-website-id="${id}"></script>`,
    );
    expect(statsTag({ service: "umami", id, script: "https://stats.example.com/s.js" })).toContain(
      'src="https://stats.example.com/s.js"',
    );
    expect(
      statsTag({ service: "cloudflare", id: "0123456789abcdef0123456789abcdef", script: null }),
    ).toBe(
      '<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon="{&quot;token&quot;:&quot;0123456789abcdef0123456789abcdef&quot;}"></script>',
    );
    expect(statsTag({ service: null, id: null, script: null })).toBeNull();
  });

  test("goes on every page once saved, but never into a preview, and only an Admin saves it", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const { client: editor } = await signedInAs(made, "editor");
    const stats = { service: "fathom", id: "ABCDEFGH", script: null };
    expect((await editor.put("/api/admin/settings/stats", stats)).status).toBe(403);
    expect(await (await made.app.request("/")).text()).not.toContain("usefathom");

    const saved = await owner.put("/api/admin/settings/stats", stats);
    expect(saved.status).toBe(200);
    const home = await (await made.app.request("/")).text();
    const head = home.slice(0, home.indexOf("</head>"));
    expect(head).toContain('data-site="ABCDEFGH"');
    const design = await (await owner.get("/api/admin/design")).json();
    const preview = await (await owner.post("/api/admin/design/preview", design.value)).json();
    expect(preview.html).not.toContain("usefathom");

    const wrong = await owner.put("/api/admin/settings/stats", { ...stats, id: "AB" });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error.field).toBe("id");
    // Choosing none takes it off again.
    const none = { service: null, id: null, script: null };
    expect((await owner.put("/api/admin/settings/stats", none)).status).toBe(200);
    expect(await (await made.app.request("/")).text()).not.toContain("usefathom");
  });
});
