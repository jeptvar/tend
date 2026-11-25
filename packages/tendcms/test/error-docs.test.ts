import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ApiError, tendIsBusy, tooManyTries } from "../src/api/errors.ts";

// Every error says what happened and what to do, and leads to a page that says more (PLAN.md
// P13). The codes are read from the source, so a new one without a page fails here.

const REPO = join(import.meta.dirname, "..", "..", "..");
const ERRORS = join(REPO, "docs", "errors");

function sources(folder: string): string[] {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ts|tsx|mjs)$/.test(entry.name))
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"));
}

const SERVER = sources(join(REPO, "packages", "tendcms", "src"));
const CODES = new Set(
  SERVER.flatMap((text) =>
    [...text.matchAll(/new ApiError\(\s*\d{3},\s*"([a-z_]+)"/g)].map((match) => match[1] as string),
  ),
);
/** Codes the command line and the start-up messages link to themselves. */
const LINKED = new Set(
  SERVER.flatMap((text) =>
    [...text.matchAll(/https:\/\/tendcms\.dev\/errors\/([a-z_]+)/g)].map(
      (match) => match[1] as string,
    ),
  ),
);
const PAGES = readdirSync(ERRORS)
  .filter((name) => name !== "README.md")
  .map((name) => name.replace(/\.md$/, ""));

describe("every error", () => {
  test("is found in the source", () => {
    expect(CODES.size).toBeGreaterThan(50);
    expect(LINKED.size).toBeGreaterThan(3);
  });

  test.each([...new Set([...CODES, ...LINKED])].sort())("%s has a page about it", (code) => {
    expect(PAGES).toContain(code);
  });

  test.each(PAGES)("the page about %s is about something Tend says", (page) => {
    expect([...CODES, ...LINKED]).toContain(page);
  });

  test.each(PAGES)("the page about %s says what it says, why, and what to do", (page) => {
    const text = readFileSync(join(ERRORS, `${page}.md`), "utf8");
    expect(text).toMatch(
      /^# .+\n\n> .+\n\n## What happened\n\n[\s\S]+\n\n## What to do\n\n- [\s\S]+\n$/,
    );
  });

  test("is in the list of them", () => {
    const list = readFileSync(join(ERRORS, "README.md"), "utf8");
    const linked = [...list.matchAll(/\]\(([a-z_]+)\.md\)/g)].map((match) => match[1]);
    expect(linked.sort()).toEqual([...PAGES].sort());
  });

  test("says what to do, and where its page is", () => {
    for (const error of [
      new ApiError(404, "not_found", "That's gone.", { fix: "Go back." }),
      tendIsBusy(),
      tooManyTries(1),
      tooManyTries(3600),
    ]) {
      const { code, message, fix, docs } = error.toJSON().error;
      expect(message).toMatch(/[.!?]$/);
      expect(fix).toMatch(/[.!?]$/);
      expect(docs).toBe(`https://tendcms.dev/errors/${code}`);
    }
    expect(tooManyTries(1).details.fix).toBe("Try again in 1 second.");
    expect(tooManyTries(3600).details.fix).toBe("Try again in 60 minutes.");
  });

  test("has words without an em dash, like everything Tend says", () => {
    for (const text of SERVER) {
      for (const [, words = ""] of text.matchAll(/new ApiError\(([\s\S]{0,400}?)\);/g)) {
        expect(words).not.toContain("—");
      }
    }
  });
});
