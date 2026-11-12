import { describe, expect, test } from "vitest";
import { findChecks, linkedIds } from "../src/editor/checks.ts";
import { cleanDoc, docToText, isAllowedHref } from "../src/lib/doc.ts";
import { toHref } from "../src/lib/href.ts";

function paragraph(...content: unknown[]) {
  return { type: "paragraph", content };
}

function text(value: string, marks?: unknown[]) {
  return { type: "text", text: value, ...(marks ? { marks } : {}) };
}

describe("cleanDoc", () => {
  test("is the same whatever order or extras the editor produced", () => {
    const fromEditor = {
      type: "doc",
      content: [
        {
          content: [
            {
              text: "hi",
              marks: [
                { type: "bold", attrs: {} },
                { type: "link", attrs: { href: " /x ", target: "_blank", rel: "a", class: "b" } },
              ],
              type: "text",
            },
          ],
          attrs: { textAlign: "left" },
          type: "paragraph",
        },
        { attrs: { language: "js" }, content: [text("code")], type: "codeBlock" },
        { attrs: { start: 1, type: null }, content: [], type: "orderedList" },
        { attrs: { start: 3, type: null }, content: [], type: "orderedList" },
      ],
    };
    expect(cleanDoc(fromEditor as never)).toEqual({
      type: "doc",
      content: [
        paragraph(text("hi", [{ type: "bold" }, { type: "link", attrs: { href: "/x" } }])),
        { type: "codeBlock", content: [text("code")] },
        { type: "orderedList", content: [] },
        { type: "orderedList", attrs: { start: 3 }, content: [] },
      ],
    });
  });

  test("the empty lines the editor keeps at the end aren't part of what's written", () => {
    const doc = { content: [paragraph(text("a")), { type: "paragraph" }, { type: "paragraph" }] };
    expect(cleanDoc(doc as never).content).toHaveLength(1);
    expect(cleanDoc({ content: [{ type: "paragraph" }] }).content).toEqual([]);
    expect(cleanDoc({}).content).toEqual([]);
  });

  test("leaves empty lines in the middle alone", () => {
    const doc = { content: [paragraph(text("a")), { type: "paragraph" }, paragraph(text("b"))] };
    expect(cleanDoc(doc as never).content).toHaveLength(3);
  });

  test("drops anything unsafe, so a bad paste can't stop every save", () => {
    const doc = cleanDoc({
      content: [
        paragraph(text("x", [{ type: "link", attrs: { href: "javascript:alert(1)" } }])),
        { type: "button", attrs: { href: "javascript:alert(1)", label: "y" } },
        { type: "image", attrs: { src: "x" } },
      ],
    } as never);
    expect(doc.content).toEqual([
      paragraph(text("x")),
      { type: "button", attrs: { href: "", label: "y" } },
    ]);
  });

  test("keeps what the server would refuse within what it allows", () => {
    const doc = cleanDoc({
      content: [
        { type: "button", attrs: { href: "/x", label: "y".repeat(500) } },
        {
          type: "section",
          attrs: { kind: "evil", preset: "<b>", tone: "loud", align: "up" },
          content: [],
        },
        { type: "orderedList", attrs: { start: Number.NaN }, content: [] },
      ],
    } as never);
    expect(String(doc.content[0]?.attrs?.label)).toHaveLength(200);
    expect(doc.content[1]?.attrs).toEqual({
      kind: "intro",
      preset: "1",
      tone: "none",
      align: "left",
    });
    expect(doc.content[2]).toEqual({ type: "orderedList", content: [] });
  });
});

describe("docToText", () => {
  test("gives every block's words, with blank lines between them", () => {
    const doc = cleanDoc({
      content: [
        { type: "heading", attrs: { level: 2 }, content: [text("Title")] },
        paragraph(text("One"), { type: "hardBreak" }, text("Two")),
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [paragraph(text("Point"))] }],
        },
        { type: "button", attrs: { href: "/x", label: "Go" } },
      ],
    } as never);
    expect(docToText(doc)).toBe("Title\n\nOne\nTwo\n\nPoint\n\nGo");
  });
});

describe("isAllowedHref", () => {
  test.each([
    "https://example.com",
    "http://example.com",
    "mailto:a@b.co",
    "tel:+15551234",
    "/about",
    "#top",
    "entry:0190b5d0-0000-7000-8000-000000000000",
  ])("allows %s", (href) => {
    expect(isAllowedHref(href)).toBe(true);
  });

  test.each([
    "",
    "javascript:alert(1)",
    " JaVaScRiPt:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html,x",
    "file:///etc/passwd",
    "x".repeat(2049),
    "entry:not-an-id",
  ])("refuses %s", (href) => {
    expect(isAllowedHref(href)).toBe(false);
  });
});

describe("toHref", () => {
  test.each([
    ["https://example.com/menu", "https://example.com/menu"],
    ["example.com", "https://example.com"],
    ["example.com/menu?x=1", "https://example.com/menu?x=1"],
    ["hello@example.com", "mailto:hello@example.com"],
    ["mailto:hello@example.com", "mailto:hello@example.com"],
    ["tel:+15551234567", "tel:+15551234567"],
    ["+1 (555) 123-4567", "tel:+15551234567"],
    ["555-123-4567", "tel:5551234567"],
    ["555.123.4567", "tel:5551234567"],
    ["/about", "/about"],
    ["#top", "#top"],
    ["192.168.1.10", "https://192.168.1.10"],
    ["1.2.3.4", "https://1.2.3.4"],
    ["https://www.youtube.com/@some.channel", "https://www.youtube.com/@some.channel"],
    ["https://www.tiktok.com/@jane.doe/video/7123", "https://www.tiktok.com/@jane.doe/video/7123"],
    ["  https://example.com  ", "https://example.com"],
  ])("%s becomes %s", (typed, href) => {
    expect(toHref(typed)).toBe(href);
  });

  test.each([
    "",
    "   ",
    "javascript:alert(1)",
    "data:text/html,x",
    "just some words",
    "2026-11-06",
  ])("%s isn't an address", (typed) => {
    expect(toHref(typed)).toBeNull();
  });
});

describe("findChecks", () => {
  const ID = "0190b5d0-0000-7000-8000-000000000000";
  const link = (href: string, words = "words") =>
    paragraph(text(words, [{ type: "link", attrs: { href } }]));

  test("says nothing about something that's fine", () => {
    const doc = cleanDoc({
      content: [
        { type: "heading", attrs: { level: 2 }, content: [text("A")] },
        { type: "heading", attrs: { level: 3 }, content: [text("B")] },
        paragraph(text("Words")),
        link("https://example.com", "the menu"),
      ],
    } as never);
    expect(findChecks(doc, [], null)).toEqual([]);
  });

  test("mentions a skipped level only once, and going back up is fine", () => {
    const doc = cleanDoc({
      content: [
        { type: "heading", attrs: { level: 3 }, content: [text("A")] },
        { type: "heading", attrs: { level: 2 }, content: [text("B")] },
        { type: "heading", attrs: { level: 4 }, content: [text("C")] },
      ],
    } as never);
    expect(findChecks(doc, [], null).map((check) => check.id)).toEqual(["check.skippedHeading"]);
  });

  test("points out links to what isn't on the site, or doesn't exist", () => {
    const doc = cleanDoc({ content: [paragraph(text("x")), link(`entry:${ID}`)] } as never);
    expect(linkedIds(doc)).toEqual([ID]);
    expect(findChecks(doc, [], null)).toEqual([{ id: "check.linkDeleted" }]);
    expect(findChecks(doc, [{ id: ID, type: "page", title: "About", url: null }], null)).toEqual([
      { id: "check.linkNotOnSite", values: { title: "About" } },
    ]);
    expect(
      findChecks(doc, [{ id: ID, type: "page", title: "About", url: "/about" }], null),
    ).toEqual([]);
  });

  test("points out vague links, buttons going nowhere, no words, and moves", () => {
    const doc = cleanDoc({
      content: [
        link("https://example.com", " Click here "),
        { type: "button", attrs: { href: "", label: "Nowhere" } },
      ],
    } as never);
    expect(findChecks(doc, [], { from: "/a", to: "/b" }).map((check) => check.id)).toEqual([
      "check.moved",
      "check.vagueLink",
      "check.buttonNoAddress",
    ]);
    expect(findChecks(cleanDoc({}), [], null)).toEqual([{ id: "check.empty" }]);
  });
});
