// Invite and reset links carry their token after #, which browsers never send to a server.
// Like the setup code, it's taken out of the address bar, so it doesn't end up in browser
// history or a shared screenshot, and kept for this tab only, so reloading still works.

export type LinkKind = "invite" | "reset";

function storageKey(kind: LinkKind): string {
  return `tend.${kind}Link`;
}

export function readLinkToken(kind: LinkKind): string | null {
  const token = window.location.hash.slice(1);
  if (token) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    try {
      sessionStorage.setItem(storageKey(kind), token);
    } catch {
      // Private windows can refuse this. Then reloading means opening the link again.
    }
    return token;
  }
  try {
    return sessionStorage.getItem(storageKey(kind));
  } catch {
    return null;
  }
}

export function forgetLinkToken(kind: LinkKind): void {
  try {
    sessionStorage.removeItem(storageKey(kind));
  } catch {
    // Nothing was stored, then.
  }
}
