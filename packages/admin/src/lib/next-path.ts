/**
 * Where to go after signing in: the page a Private site sent someone here from, which it
 * names as ?next=. Only ever somewhere on this site. Anything that would leave it, however
 * it's written ("//other.example", "/\other.example", a tab inside the slashes, a scheme),
 * gives null, so signing in can't be used to send someone to another website.
 */
export function nextPath(search: string, origin: string): string | null {
  const next = new URLSearchParams(search).get("next");
  if (!next?.startsWith("/")) return null;
  let url: URL;
  try {
    url = new URL(next, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}
