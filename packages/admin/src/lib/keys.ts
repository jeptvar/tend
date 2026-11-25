import type { KeyboardEvent } from "react";

/** What every key is while a Japanese or Chinese keyboard, say, is putting a word together. */
const COMPOSING = 229;

/**
 * Whether a key is part of putting a word together, so not for anything else. Safari's last one,
 * the Enter that accepts a suggestion, comes once that's over: only its old code still says so.
 */
export function isComposing(event: KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === COMPOSING;
}
