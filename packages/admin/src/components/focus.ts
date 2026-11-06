import { type RefObject, useEffect } from "react";

// Where focus last followed a navigation. Module-level so the first load, and
// StrictMode's repeated effects, don't count as navigating.
let lastPath: string | null = window.location.pathname;

/** Makes the next screen take focus, even at the same address. */
export function focusNextScreen(): void {
  lastPath = null;
}

/**
 * Moves focus to a screen's heading after a navigation. The link just used is gone from
 * the page, so otherwise focus falls back to the top and screen readers announce nothing.
 */
export function useNavigationFocus(
  headingRef: RefObject<HTMLElement | null>,
  options: { enabled?: boolean; always?: boolean } = {},
): void {
  const { enabled = true, always = false } = options;
  useEffect(() => {
    if (always) {
      headingRef.current?.focus();
      return;
    }
    if (window.location.pathname === lastPath) return;
    lastPath = window.location.pathname;
    if (enabled) headingRef.current?.focus();
  }, [headingRef, enabled, always]);
}
