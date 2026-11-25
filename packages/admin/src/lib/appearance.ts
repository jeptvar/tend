// Whether the admin is light or dark: as this device is, or as someone chose on it. Kept on
// the device, because it's about the screen someone is at rather than who they are.

export type Appearance = "system" | "light" | "dark";

const KEY = "tend-appearance";

export function appearance(): Appearance {
  try {
    const kept = localStorage.getItem(KEY);
    return kept === "light" || kept === "dark" ? kept : "system";
  } catch {
    // Not allowed to keep anything: then it's as the device is.
    return "system";
  }
}

/** Shows the admin as chosen. index.css follows the device until one is. */
export function applyAppearance(chosen: Appearance = appearance()): void {
  if (chosen === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = chosen;
}

export function setAppearance(chosen: Appearance): void {
  try {
    if (chosen === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, chosen);
  } catch {
    // It still applies until this tab is closed.
  }
  applyAppearance(chosen);
}

/** Follows a choice made in another tab of this browser. */
export function followAppearance(): void {
  applyAppearance();
  window.addEventListener("storage", (event) => {
    if (event.key === KEY || event.key === null) applyAppearance();
  });
}
