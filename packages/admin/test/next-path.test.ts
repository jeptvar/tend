import { describe, expect, test } from "vitest";
import { nextPath } from "../src/lib/next-path.ts";

const SITE = "https://rise.example";

describe("where signing in leads", () => {
  test("back to the page on this site that sent someone to sign in", () => {
    expect(nextPath("?next=%2Fcontact", SITE)).toBe("/contact");
    expect(nextPath("?next=%2Fblog%2Fnews%3Fpage%3D2", SITE)).toBe("/blog/news?page=2");
    expect(nextPath("?next=/caf%C3%A9", SITE)).toBe("/caf%C3%A9");
    // Still encoded, a tab is part of a path here. Only a real one would be dropped.
    expect(nextPath(`?next=${encodeURIComponent("/%09/x.example")}`, SITE)).toBe("/%09/x.example");
  });

  test("nowhere, when there's no page to go back to", () => {
    expect(nextPath("", SITE)).toBeNull();
    expect(nextPath("?next=", SITE)).toBeNull();
  });

  test("never to another website, however the address is written", () => {
    for (const next of [
      "//evil.example/x",
      "/\\evil.example/x",
      "/\t/evil.example",
      "/\n/evil.example",
      "https://evil.example",
      "javascript:alert(1)",
      "evil.example",
    ]) {
      expect(nextPath(`?next=${encodeURIComponent(next)}`, SITE), next).toBeNull();
    }
  });
});
