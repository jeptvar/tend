import { describe, expect, test } from "vitest";
import messages from "../src/messages/en.json" with { type: "json" };

// Plain words (PLAN.md §4, P8): words that only mean something to whoever made the software.
const BANNED =
  /\b(slugs?|permalinks?|meta|excerpts?|schemas?|entry|entries|entity|entities|instances?|payloads?|deploy\w*|builds?|building|invalid|OG|hero|CTA|call to action|injections?)\b/i;

/** What people read: the words, without the {names} and choices that get filled in. */
function words(message: string): string {
  return message.replace(/\{[a-zA-Z]+(, (plural|select|selectordinal|number|date|time),?)?/g, " ");
}

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
