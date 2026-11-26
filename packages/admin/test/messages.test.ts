import { describe, expect, test } from "vitest";
import messages from "../src/messages/en.json" with { type: "json" };

// Plain words (PLAN.md §4, P8): words that only mean something to whoever made the software.
const BANNED =
  /\b(slugs?|permalinks?|meta|excerpts?|schemas?|entry|entries|entity|entities|instances?|payloads?|deploy\w*|builds?|building|invalid|OG|hero|CTA|call to action|injections?)\b/i;

/** What people read: the words, without the {names} and choices that get filled in. */
function words(message: string): string {
  return message.replace(/\{[a-zA-Z]+(, (plural|select|selectordinal|number|date|time),?)?/g, " ");
}

/** Says the site is live, rather than how to get there (PLAN.md §4, P15). */
const SAYS_LIVE = ["overview.live", "nav.state.live"];
/** How to get there: what's true once someone has done it all. */
const SAYS_HOW = ["online.addressBody"];

describe("what the admin says about the site", () => {
  test("only says it's live where that's checked first", () => {
    const live = Object.entries(messages)
      .filter(([, message]) => /\blive\b/i.test(words(message)))
      .map(([id]) => id);
    expect(live.sort()).toEqual([...SAYS_LIVE, ...SAYS_HOW].sort());
  });

  test("never says the words that promise more than it knows", () => {
    for (const [id, message] of Object.entries(messages)) {
      expect(words(message), id).not.toMatch(/\byour site is (online|public|published|up)\b(?!,)/i);
    }
  });
});

describe("what the admin says", () => {
  test("uses none of the words that need explaining", () => {
    const found = Object.entries(messages)
      .filter(([, message]) => BANNED.test(words(message)))
      .map(([id, message]) => `${id}: ${message}`);
    expect(found).toEqual([]);
  });

  test("and this would find them", () => {
    for (const said of ["Choose a slug", "Invalid address", "Deploying…", "Your {entry} meta"]) {
      expect(BANNED.test(words(said)), said).toBe(true);
    }
    for (const said of ["{entry} was saved", "Rebuilding", "The heron", "Metal", "Ogre"]) {
      expect(BANNED.test(words(said)), said).toBe(false);
    }
  });
});
