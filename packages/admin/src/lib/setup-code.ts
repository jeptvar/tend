const STORAGE_KEY = "tend.setupCode";

function remember(code: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, code);
  } catch {
    // Private windows can refuse this. The worst case is typing the code again after a reload.
  }
}

export function forgetSetupCode(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing was stored, then.
  }
}

/**
 * Picks the code up from the link Tend printed (#code=XXXX-XXXX) and takes it out of
 * the address bar, so it doesn't end up in browser history or a shared screenshot.
 * It's kept for this tab only, so reloading partway through setup still works.
 */
export function readSetupCode(): string | null {
  const match = window.location.hash.match(/^#code=(.+)$/);
  if (match?.[1]) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    try {
      const code = decodeURIComponent(match[1]);
      remember(code);
      return code;
    } catch {
      return null;
    }
  }
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeSetupCode(code: string): void {
  remember(code);
}
