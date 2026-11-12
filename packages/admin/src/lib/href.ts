import { isAllowedHref } from "./doc.ts";

// A scheme is followed by something other than a number: "example.com:8080" has a port.
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i;
const LOCALHOST = /^localhost(?::\d+)?(?:[/?#]\S*)?$/i;
const EMAIL = /^[^\s@:/]+@[^\s@:/]+\.[^\s@:/]+$/;
const DOMAIN = /^[^\s/:]+\.[^\s/:]{2,}(?::\d+)?(?:[/?#]\S*)?$/;
const PHONE = /^\+?[\d\s()-]{7,}$/;
const DOTTED_PHONE = /^\d{3}\.\d{3}\.\d{4}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** What someone typed as a real address, or null if it can't be one. */
export function toHref(typed: string): string | null {
  const text = typed.trim();
  if (text === "") return null;
  let href = text;
  // An address that says what it is stays exactly as it is, including anything after a @.
  if (HAS_SCHEME.test(text) || text.startsWith("/") || text.startsWith("#")) href = text;
  else if (EMAIL.test(text)) href = `mailto:${text}`;
  else if ((PHONE.test(text) && !DATE.test(text)) || DOTTED_PHONE.test(text)) {
    href = `tel:${text.replace(/[\s().-]/g, "")}`;
  } else if (LOCALHOST.test(text)) href = `http://${text}`;
  else if (DOMAIN.test(text)) href = `https://${text}`;
  else return null;
  return isAllowedHref(href) ? href : null;
}
